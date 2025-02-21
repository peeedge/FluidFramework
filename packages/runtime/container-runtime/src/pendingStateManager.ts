/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { IDisposable } from "@fluidframework/common-definitions";
import { assert, Lazy } from "@fluidframework/common-utils";
import { ICriticalContainerError } from "@fluidframework/container-definitions";
import { DataProcessingError } from "@fluidframework/container-utils";
import {
    ISequencedDocumentMessage,
} from "@fluidframework/protocol-definitions";
import { FlushMode } from "@fluidframework/runtime-definitions";
import { wrapError } from "@fluidframework/telemetry-utils";
import Deque from "double-ended-queue";
import { ContainerMessageType } from "./containerRuntime";

/**
 * This represents a message that has been submitted and is added to the pending queue when `submit` is called on the
 * ContainerRuntime. This message has either not been ack'd by the server or has not been submitted to the server yet.
 */
export interface IPendingMessage {
    type: "message";
    messageType: ContainerMessageType;
    clientSequenceNumber: number;
    referenceSequenceNumber: number;
    content: any;
    localOpMetadata: unknown;
    opMetadata: Record<string, unknown> | undefined;
}

/**
 * This represents a FlushMode update and is added to the pending queue when `setFlushMode` is called on the
 * ContainerRuntime and the FlushMode changes.
 */
export interface IPendingFlushMode {
    type: "flushMode";
    flushMode: FlushMode;
}

/**
 * This represents an explicit flush call and is added to the pending queue when flush is called on the ContainerRuntime
 * to flush pending messages.
 */
export interface IPendingFlush {
    type: "flush";
}

export type IPendingState = IPendingMessage | IPendingFlushMode | IPendingFlush;

export interface IPendingLocalState {
    /**
     * list of pending states, including ops and batch information
     */
    pendingStates: IPendingState[];
}

export interface IRuntimeStateHandler{
    connected(): boolean;
    clientId(): string | undefined;
    flushMode(): FlushMode;
    setFlushMode(mode: FlushMode): void;
    close(error?: ICriticalContainerError): void;
    applyStashedOp: (type: ContainerMessageType, content: ISequencedDocumentMessage) => Promise<unknown>;
    flush(): void;
    reSubmit(
        type: ContainerMessageType,
        content: any,
        localOpMetadata: unknown,
        opMetadata: Record<string, unknown> | undefined): void;
    rollback(
        type: ContainerMessageType,
        content: any,
        localOpMetadata: unknown): void;
}

/**
 * PendingStateManager is responsible for maintaining the messages that have not been sent or have not yet been
 * acknowledged by the server. It also maintains the batch information for both automatically and manually flushed
 * batches along with the messages.
 * When the Container reconnects, it replays the pending states, which includes setting the FlushMode, manual flushing
 * of messages and triggering resubmission of unacked ops.
 *
 * It verifies that all the ops are acked, are received in the right order and batch information is correct.
 */
export class PendingStateManager implements IDisposable {
    private readonly pendingStates = new Deque<IPendingState>();
    private readonly initialStates: Deque<IPendingState>;
    private readonly disposeOnce = new Lazy<void>(() => {
        this.initialStates.clear();
        this.pendingStates.clear();
    });

    // Maintains the count of messages that are currently unacked.
    private _pendingMessagesCount: number = 0;
    public get pendingMessagesCount(): number {
        return this._pendingMessagesCount;
    }

    // Indicates whether we are processing a batch.
    private isProcessingBatch: boolean = false;

    // This stores the first message in the batch that we are processing. This is used to verify that we get
    // the correct batch metadata.
    private pendingBatchBeginMessage: ISequencedDocumentMessage | undefined;

    /**
     * This tracks the flush mode for the next message in the pending state queue. When replaying messages, we need to
     * first set the flush mode to this value and then send ops. It is important to do this info because the flush
     * mode could have been updated.
     */
    private flushModeForNextMessage: FlushMode;

    private clientId: string | undefined;

    /**
     * Called to check if there are any pending messages in the pending state queue.
     * @returns A boolean indicating whether there are messages or not.
     */
    public hasPendingMessages(): boolean {
        return this._pendingMessagesCount !== 0 || !this.initialStates.isEmpty();
    }

    public getLocalState(): IPendingLocalState | undefined {
        assert(this.initialStates.isEmpty(), 0x2e9 /* "Must call getLocalState() after applying initial states" */);
        if (this.hasPendingMessages()) {
            return {
                pendingStates: this.pendingStates.toArray().map(
                    // delete localOpMetadata since it may not be serializable
                    // and will be regenerated by applyStashedOp()
                    (state) => state.type === "message" ? { ...state, localOpMetadata: undefined } : state),
            };
        }
    }

    constructor(
        private readonly stateHandler: IRuntimeStateHandler,
        initialFlushMode: FlushMode,
        initialLocalState: IPendingLocalState | undefined,
    ) {
        this.initialStates = new Deque<IPendingState>(initialLocalState?.pendingStates ?? []);

        this.flushModeForNextMessage = initialFlushMode;
        this.onFlushModeUpdated(initialFlushMode);
    }

    public get disposed() { return this.disposeOnce.evaluated; }
    public readonly dispose = () => this.disposeOnce.value;

    /**
     * Called when a message is submitted locally. Adds the message and the associated details to the pending state
     * queue.
     * @param type - The container message type.
     * @param clientSequenceNumber - The clientSequenceNumber associated with the message.
     * @param content - The message content.
     * @param localOpMetadata - The local metadata associated with the message.
     */
    public onSubmitMessage(
        type: ContainerMessageType,
        clientSequenceNumber: number,
        referenceSequenceNumber: number,
        content: any,
        localOpMetadata: unknown,
        opMetadata: Record<string, unknown> | undefined,
    ) {
        const pendingMessage: IPendingMessage = {
            type: "message",
            messageType: type,
            clientSequenceNumber,
            referenceSequenceNumber,
            content,
            localOpMetadata,
            opMetadata,
        };

        this.pendingStates.push(pendingMessage);

        this._pendingMessagesCount++;
    }

    /**
     * Called when the FlushMode is updated. Adds the FlushMode to the pending state queue.
     * @param flushMode - The flushMode that was updated.
     */
    public onFlushModeUpdated(flushMode: FlushMode) {
        this.pendingStates.push({ type: "flushMode", flushMode });
    }

    /**
     * Called when flush() is called on the ContainerRuntime to manually flush messages.
     */
    public onFlush() {
        // If the FlushMode is Immediate, we don't need to track an explicit flush call because every message is
        // automatically flushed. So, flush is a no-op.
        if (this.stateHandler.flushMode() === FlushMode.Immediate) {
            return;
        }

        // If the previous state is not a message, flush is a no-op.
        const previousState = this.pendingStates.peekBack();
        if (previousState?.type !== "message") {
            return;
        }

        // An explicit flush is interesting and is tracked only if there are messages sent in TurnBased mode.
        this.pendingStates.push({ type: "flush" });
    }

    /**
     * Applies stashed ops at their reference sequence number so they are ready to be ACKed or resubmitted
     * @param seqNum - Sequence number at which to apply ops. Will apply all ops if seqNum is undefined.
     */
    public async applyStashedOpsAt(seqNum?: number) {
        // apply stashed ops at sequence number
        while (!this.initialStates.isEmpty()) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const nextState = this.initialStates.peekFront()!;
            if (nextState.type === "message") {
                if (seqNum !== undefined) {
                    if (nextState.referenceSequenceNumber > seqNum) {
                        break; // nothing left to do at this sequence number
                    } else if (nextState.referenceSequenceNumber < seqNum) {
                        throw new Error("loaded from snapshot too recent to apply stashed ops");
                    }
                }

                // applyStashedOp will cause the DDS to behave as if it has sent the op but not actually send it
                const localOpMetadata =
                    await this.stateHandler.applyStashedOp(nextState.messageType, nextState.content);
                nextState.localOpMetadata = localOpMetadata;
            }

            // then we push onto pendingStates which will cause PendingStateManager to resubmit when we connect
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            this.pendingStates.push(this.initialStates.shift()!);
        }
    }

    /**
     * Processes a local message once its ack'd by the server. It verifies that there was no data corruption and that
     * the batch information was preserved for batch messages.
     * @param message - The message that got ack'd and needs to be processed.
     */
    public processPendingLocalMessage(message: ISequencedDocumentMessage): unknown {
        // Pre-processing part - This may be the start of a batch.
        this.maybeProcessBatchBegin(message);

        // Get the next state from the pending queue and verify that it is of type "message".
        const pendingState = this.peekNextPendingState();
        assert(pendingState.type === "message", 0x169 /* "No pending message found for this remote message" */);
        this.pendingStates.shift();

        // Processing part - Verify that there has been no data corruption.
        // The clientSequenceNumber of the incoming message must match that of the pending message.
        if (pendingState.clientSequenceNumber !== message.clientSequenceNumber) {
            // Close the container because this could indicate data corruption.
            const error = DataProcessingError.create(
                "pending local message clientSequenceNumber mismatch",
                "unexpectedAckReceived",
                message,
                { expectedClientSequenceNumber: pendingState.clientSequenceNumber },
            );

            this.stateHandler.close(error);
            return;
        }

        this._pendingMessagesCount--;

        // Post-processing part - If we are processing a batch then this could be the last message in the batch.
        this.maybeProcessBatchEnd(message);

        return pendingState.localOpMetadata;
    }

    /**
     * This message could be the first message in batch. If so, set batch state marking the beginning of a batch.
     * @param message - The message that is being processed.
     */
    private maybeProcessBatchBegin(message: ISequencedDocumentMessage) {
        // Tracks the last FlushMode that was set before this message was sent.
        let pendingFlushMode: FlushMode | undefined;
        // Tracks whether a flush was called before this message was sent.
        let pendingFlush: boolean = false;

        /**
         * We are checking if the next message is the start of a batch. It can happen in the following scenarios:
         * 1. The FlushMode was set to TurnBased before this message was sent.
         * 2. The FlushMode was already TurnBased and a flush was called before this message was sent. This essentially
         *    means that the flush marked the end of a previous batch and beginning of a new batch.
         *
         * Keep reading pending states from the queue until we encounter a message. It's possible that the FlushMode was
         * updated a bunch of times without sending any messages.
         */
        let nextPendingState = this.peekNextPendingState();
        while (nextPendingState.type !== "message") {
            if (nextPendingState.type === "flushMode") {
                pendingFlushMode = nextPendingState.flushMode;
            }
            if (nextPendingState.type === "flush") {
                pendingFlush = true;
            }
            this.pendingStates.shift();
            nextPendingState = this.peekNextPendingState();
        }

        if (pendingFlushMode !== undefined) {
            this.flushModeForNextMessage = pendingFlushMode;
        }

        // If the FlushMode was set to Immediate before this message was sent, this message won't be a batch message
        // because in Immediate mode, every message is flushed individually.
        if (pendingFlushMode === FlushMode.Immediate) {
            return;
        }

        /**
         * This message is the first in a batch if before it was sent either the FlushMode was set to TurnBased or there
         * was an explicit flush call. Note that a flush call is tracked only in TurnBased mode and it indicates the end
         * of one batch and beginning of another.
         */
        if (pendingFlushMode === FlushMode.TurnBased || pendingFlush) {
            // We should not already be processing a batch and there should be no pending batch begin message.
            assert(!this.isProcessingBatch && this.pendingBatchBeginMessage === undefined,
                0x16b /* "The pending batch state indicates we are already processing a batch" */);

            // Set the pending batch state indicating we have started processing a batch.
            this.pendingBatchBeginMessage = message;
            this.isProcessingBatch = true;
        }
    }

    /**
     * This message could be the last message in batch. If so, clear batch state since the batch is complete.
     * @param message - The message that is being processed.
     */
    private maybeProcessBatchEnd(message: ISequencedDocumentMessage) {
        if (!this.isProcessingBatch) {
            return;
        }

        const nextPendingState = this.peekNextPendingState();
        if (nextPendingState.type === "message") {
            return;
        }

        /**
         * We are in the middle of processing a batch. The batch ends when we see an explicit flush. We should never see
         * a FlushMode before flush. This is true because we track batches only when FlushMode is TurnBased and in this
         * mode, a batch ends either by calling flush or by changing the mode to Immediate which also triggers a flush.
         */
        assert(
            nextPendingState.type !== "flushMode",
            0x2bd /* "We should not see a pending FlushMode until we see a flush when processing a batch" */,
        );

        // There should be a pending batch begin message.
        assert(this.pendingBatchBeginMessage !== undefined, 0x16d /* "There is no pending batch begin message" */);

        // Get the batch begin metadata from the first message in the batch.
        const batchBeginMetadata = this.pendingBatchBeginMessage.metadata?.batch;

        // There could be just a single message in the batch. If so, it should not have any batch metadata. If there
        // are multiple messages in the batch, verify that we got the correct batch begin and end metadata.
        if (this.pendingBatchBeginMessage === message) {
            assert(batchBeginMetadata === undefined,
                0x16e /* "Batch with single message should not have batch metadata" */);
        } else {
            // Get the batch metadata from the last message in the batch.
            const batchEndMetadata = message.metadata?.batch;
            assert(batchBeginMetadata === true, 0x16f /* "Did not receive batch begin metadata" */);
            assert(batchEndMetadata === false, 0x170 /* "Did not receive batch end metadata" */);
        }

        // Clear the pending batch state now that we have processed the entire batch.
        this.pendingBatchBeginMessage = undefined;
        this.isProcessingBatch = false;
    }

    /**
     * Capture the pending state at this point
     */
    public checkpoint() {
        const checkpointHead = this.pendingStates.peekBack();
        return {
            rollback: () => {
                try {
                    while (this.pendingStates.peekBack() !== checkpointHead) {
                        this.rollbackNextPendingState();
                    }
                } catch (err) {
                    const error = wrapError(err, (message) => {
                        return DataProcessingError.create(
                            `RollbackError: ${message}`,
                            "checkpointRollback",
                            undefined) as DataProcessingError;
                    });
                    this.stateHandler.close(error);
                    throw error;
                }
            },
        };
    }

    /**
     * Returns the next pending state from the pending state queue.
     */
    private peekNextPendingState(): IPendingState {
        const nextPendingState = this.pendingStates.peekFront();
        assert(!!nextPendingState, 0x171 /* "No pending state found for the remote message" */);
        return nextPendingState;
    }

    /**
     * Undo the last pending state
     */
    private rollbackNextPendingState() {
        const pendingStatesCount = this.pendingStates.length;
        if (pendingStatesCount === 0) {
            return;
        }

        this._pendingMessagesCount--;

        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const pendingState = this.pendingStates.pop()!;
        switch (pendingState.type) {
            case "message":
                this.stateHandler.rollback(
                    pendingState.messageType,
                    pendingState.content,
                    pendingState.localOpMetadata);
                break;
            default:
                throw new Error(`Can't rollback state ${pendingState.type}`);
        }
    }

    /**
     * Called when the Container's connection state changes. If the Container gets connected, it replays all the pending
     * states in its queue. This includes setting the FlushMode and triggering resubmission of unacked ops.
     */
    public replayPendingStates() {
        assert(this.stateHandler.connected(), 0x172 /* "The connection state is not consistent with the runtime" */);

        // This assert suggests we are about to send same ops twice, which will result in data loss.
        assert(this.clientId !== this.stateHandler.clientId(),
            0x173 /* "replayPendingStates called twice for same clientId!" */);
        this.clientId = this.stateHandler.clientId();

        assert(this.initialStates.isEmpty(), 0x174 /* "initial states should be empty before replaying pending" */);

        let pendingStatesCount = this.pendingStates.length;
        if (pendingStatesCount === 0) {
            return;
        }

        // Reset the pending message count because all these messages will be removed from the queue.
        this._pendingMessagesCount = 0;

        // Save the current FlushMode so that we can revert it back after replaying the states.
        const savedFlushMode = this.stateHandler.flushMode();

        // Set the flush mode for the next message. This step is important because the flush mode may have been changed
        // after the next pending message was sent.
        this.stateHandler.setFlushMode(this.flushModeForNextMessage);

        // Process exactly `pendingStatesCount` items in the queue as it represents the number of states that were
        // pending when we connected. This is important because the `reSubmitFn` might add more items in the queue
        // which must not be replayed.
        while (pendingStatesCount > 0) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const pendingState = this.pendingStates.shift()!;
            switch (pendingState.type) {
                case "message":
                    this.stateHandler.reSubmit(
                        pendingState.messageType,
                        pendingState.content,
                        pendingState.localOpMetadata,
                        pendingState.opMetadata);
                    break;
                case "flushMode":
                    this.stateHandler.setFlushMode(pendingState.flushMode);
                    break;
                case "flush":
                    this.stateHandler.flush();
                    break;
                default:
                    break;
            }
            pendingStatesCount--;
        }

        // Revert the FlushMode.
        this.stateHandler.setFlushMode(savedFlushMode);
    }
}
