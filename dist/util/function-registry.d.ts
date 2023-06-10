import { EventEnvelope } from '../models/event-envelope.js';
export declare class FunctionRegistry {
    constructor();
    /**
     * Save a function to the registry by name.
     *
     * This is used when you publish a library with reusable functions and
     * you want to expose the functions by names for subsequent registration
     * by the user application.
     *
     * @param name of the function
     * @param listener is the function reference
     */
    saveFunction(name: string, listener: (evt: EventEnvelope) => void): void;
    /**
     * Retrieve a function by name so that you can register it programmatically.
     * The "PreLoader" will also use this to find functions to register them
     * declaratively.
     *
     * @param name of the function
     * @returns the function that was previously saved by a library
     */
    getFunction(name: string): (evt: EventEnvelope) => void;
    /**
     * Check if a function exists in registry
     *
     * @param name of the function
     * @returns true if the function exists
     */
    exists(name?: string): boolean;
    /**
     * Retrieve all function names in registry
     *
     * @returns list of function names
     */
    getFunctions(): Array<string>;
}
