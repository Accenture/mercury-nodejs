import { EventEnvelope } from '../models/event-envelope.js';
export declare class FunctionRegistry {
    constructor();
    /**
     * Save a Composable class to the registry by name.
     *
     * @param that is the class instance of the Composable function
     */
    saveFunction(that: object): void;
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
     * Retrieve the class instance of a function
     * (this would be used to invoke other methods in the same class)
     *
     * @param name of the function
     * @returns the Composable class holding the function
     */
    getClass(name: string): object;
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
