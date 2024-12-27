import { EventEmitter } from 'events';
import { EventEnvelope } from '../models/event-envelope.js';
export declare class PostOffice {
    private from;
    private instance;
    private traceId;
    private tracePath;
    private trackable;
    constructor(headers?: object);
    private touch;
    /**
     * Application instance ID
     *
     * @returns unique ID
     */
    getId(): string;
    /**
     * Internal API - DO NOT call this method from user code
     *
     * @returns the underlying event emitter
     */
    getEventEmitter(): EventEmitter;
    /**
     * Internal API - DO NOT call this method from user code
     *
     * @returns registered handlers in the event loop
     */
    getHandlers(): Map<any, any>;
    /**
     * Obtain the "this" reference (i.e. class instance) of my function
     *
     * @returns the Composable class holding the function that instantiates this PostOffice
     */
    getMyClass(): object;
    /**
     * Get my own route name
     *
     * @returns route name
     */
    getMyRoute(): string;
    /**
     * Retrieve the instance number of this worker for the function
     *
     * @returns worker instance number
     */
    getMyInstance(): string;
    /**
     * Retrieve the optional trace ID for the incoming event
     *
     * @returns trace ID or null
     */
    getMyTraceId(): string;
    /**
     * Retrieve the optional trace path for the incoming event
     *
     * @returns trace path or null
     */
    getMyTracePath(): string;
    /**
     * Check if a route has been registered
     *
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): boolean;
    /**
     * Send an event
     *
     * @param event envelope
     */
    send(event: EventEnvelope): void;
    /**
     * Send an event later
     *
     * @param event envelope
     * @param delay in milliseconds (default one second)
     */
    sendLater(event: EventEnvelope, delay?: number): void;
    /**
     * Make an asynchronous RPC call
     *
     * @param event envelope
     * @param timeout value in milliseconds
     * @returns a future promise of result or error
     */
    request(event: EventEnvelope, timeout?: number): Promise<EventEnvelope>;
    /**
     * Make an asynchronous RPC call using "Event Over HTTP"
     *
     * @param event envelope
     * @param endpoint URL of the remote application providing the Event API service
     * @param securityHeaders HTTP request headers for authentication. e.g. the "Authorization" header.
     * @param rpc if true. Otherwise, it is a "drop-n-forget" async call.
     * @param timeout value in milliseconds
     * @returns a future promise of result or error
     */
    remoteRequest(event: EventEnvelope, endpoint: string, securityHeaders?: object, rpc?: boolean, timeout?: number): Promise<EventEnvelope>;
}
