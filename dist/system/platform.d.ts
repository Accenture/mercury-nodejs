import { EventEnvelope } from '../models/event-envelope.js';
import { MultiLevelMap } from '../util/multi-level-map.js';
export declare class Platform {
    constructor(configFile?: string);
    getInstance(): EventSystem;
}
declare class EventSystem {
    private config;
    private services;
    private forever;
    private stopping;
    private t1;
    constructor(configFile?: string);
    /**
     * Retrieve unique application instance ID (aka originId)
     *
     * @returns originId
     */
    getOriginId(): string;
    /**
     * Get application.yml
     *
     * @returns multi-level-map
     */
    getConfig(): MultiLevelMap;
    /**
     * Register a function with a route name.
     * (This is a managed version of the po.subscribe method. Please use this to register your service functions)
     *
     * Your function will be registered as PUBLIC unless you set isPrivate to true.
     * PUBLIC functions are advertised to the whole system so that other application instances can find them.
     * PRIVATE function are invisible outside the current application instance.
     * Private scope is ideal for business logic encapsulation.
     *
     * Note that the listener can be either:
     * 1. synchronous function with optional return value, or
     * 2. asynchronous function that returns a promise
     *
     * The 'void' return type in the listener is used in typescipt compile time only. It is safe for the function to return value.
     * The return value can be a primitive value, JSON object, an EventEnvelope, an Error or an AppException.
     * With AppException, you can set status code and message.
     *
     * @param route name
     * @param listener function (synchronous or promise)
     * @param isPrivate true or false
     */
    register(route: string, listener: (evt: EventEnvelope) => void, isPrivate?: boolean, instances?: number): void;
    /**
     * Release a previously registered function
     *
     * @param route name
     */
    release(route: string): void;
    /**
     * You can use this method to keep the event system running in the background
     */
    runForever(): Promise<void>;
    /**
     * Stop the platform and cloud connector
     */
    stop(): void;
    /**
     * Check if the platform is shutting down
     *
     * @returns true or false
     */
    isStopping(): boolean;
}
export {};
