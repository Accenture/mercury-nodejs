import { EventEnvelope } from '../models/event-envelope.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class FunctionRegistry {
    private static singleton;
    private registry;
    private constructor();
    static getInstance(): FunctionRegistry;
    /**
     * Save a Composable function to the registry by name.
     *
     * @param route of the composable function
     * @param that is the class instance of the Composable function
     * @param instances for concurrency
     * @param isPrivate is false if function is visible thru event-over-http
     * @param isInterceptor is true if function is an event interceptor
     */
    save(route: string, that: object, instances: number, isPrivate: boolean, isInterceptor: boolean): void;
    /**
     * Remove a composable function from the registry by name.
     *
     * @param name of the function
     */
    remove(name: string): void;
    /**
     * Retrieve metadata for the composable function
     *
     * @param name of the function
     * @returns map of key-values
     */
    getMetadata(name: string): object;
    /**
     * Retrieve a function by name so that you can register it programmatically.
     * The "PreLoader" will also use this to find functions to register them
     * declaratively.
     *
     * @param name of the function
     * @returns the function that was previously saved by a library
     */
    get(name: string): (evt: EventEnvelope) => void;
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
    getFunctionList(): Array<string>;
}
