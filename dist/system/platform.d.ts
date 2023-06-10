import { EventEnvelope } from '../models/event-envelope.js';
import { ConfigReader } from '../util/config-reader.js';
export declare class Platform {
    constructor(configFile?: string | object);
    static initialized(): boolean;
    /**
     * Retrieve unique application instance ID (i.e. "originId")
     *
     * @returns originId
     */
    getOriginId(): string;
    getName(): string;
    getStartTime(): Date;
    /**
     * Get application configuration
     *
     * @returns config reader
     */
    getConfig(): ConfigReader;
    /**
     * Register a function with a route name.
     *
     * Your function will be registered as PRIVATE unless you set isPrivate=false.
     * PUBLIC functions are reachable by a peer from the Event API Endpoint "/api/event".
     * PRIVATE functions are invisible outside the current application instance.
     * INTERCEPTOR functions' return values are ignored because they are designed to forward events themselves.
     *
     * Note that the listener should be ideally an asynchronous function or a function that returns a promise.
     * However, the system would accept regular function too.
     *
     * The 'void' return type in the listener is used in typescipt compile time only.
     * It is safe for the function to return value as a primitive value, JSON object, an EventEnvelope.
     *
     * Your function can throw an Error or an AppException.
     * With AppException, you can set status code and message.
     *
     * @param route name
     * @param listener function with EventEnvelope as input
     * @param isPrivate true or false
     * @param isInterceptor true or false
     * @param instances number of workers for this function
     */
    register(route: string, listener: (evt: EventEnvelope) => void, isPrivate?: boolean, instances?: number, isInterceptor?: boolean): void;
    /**
     * Release a previously registered function
     *
     * @param route name
     */
    release(route: string): void;
    /**
     * Check if a route is private
     *
     * @param route name of a function
     * @returns true if private and false if public
     * @throws Error(Route 'name' not found)
     */
    isPrivate(route: string): any;
    /**
     * Stop the platform.
     * (REST automation and outstanding streams, if any, will be automatically stopped.)
     */
    stop(): Promise<void>;
    /**
     * Check if the platform is shutting down
     *
     * @returns true or false
     */
    isStopping(): boolean;
    /**
     * You can use this method to keep the event system running in the background
     */
    runForever(): Promise<void>;
}
