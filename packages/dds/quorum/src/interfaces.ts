/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ISharedObject, ISharedObjectEvents } from "@fluidframework/shared-object-base";

/**
 * IQuorumEvents are the events fired by an IQuorum.
 */
export interface IQuorumEvents extends ISharedObjectEvents {
    /**
     * Notifies when a new value goes pending or has been accepted.
     */
    (event: "pending" | "accepted", listener: (key: string) => void);
}

/**
 * An IQuorum is a key-value storage, in which setting a value requires all connected collaborators to observe and ack
 * the set message.  As a result, the value goes through two phases - "pending" state where the local client has seen
 * the set, but not all connected clients have, and "accepted" where all connected clients have seen the set.
 */
export interface IQuorum extends ISharedObject<IQuorumEvents> {
    /**
     * Checks if the quorum has an accepted value for the given key.
     * @param key - The key to check
     */
    has(key: string): boolean;

    /**
     * Gets the accepted value for the given key.
     * @param key - The key to retrieve from
     */
    // TODO: this should be updated to return something other than `any` (unknown)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(key: string): any;

    /**
     * Gets the pending value for the given key.
     * @param key - The key to retrieve from
     */
    // TODO: this should be updated to return something other than `any` (unknown)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getPending(key: string): any;

    /**
     * Sets the value for the given key.  After setting the value, it will be in "pending" state until all connected
     * clients have ack'd the set.  The accepted value remains unchanged until that time.
     * @param key - The key to set
     * @param value - The value to store
     */
    set(key: string, value: unknown): void;

    /**
     * Deletes the key/value pair at the given key.  After issuing the delete, the delete is in "pending" state until
     * all connected clients have ack'd the delete.  The accepted value remains unchanged until that time.
     * @param key - the key to delete
     */
    delete(key: string): void;
}
