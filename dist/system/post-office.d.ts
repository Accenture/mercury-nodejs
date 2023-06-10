import { EventEnvelope } from '../models/event-envelope.js';
export declare class PostOffice {
    private from;
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
     * Check if a route has been registered
     *
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): boolean;
    /**
     * Reserved for internal use. Plese use the 'platform.release' API instead.
     *
     * Subscribe an event listener to a route name
     *
     * The system enforces exclusive subscriber. If you need multiple functions to listen to the same route,
     * please implement your own multiple subscription logic. A typical approach is to implement a forwarder
     * and send a subscription request to the forwarder function with your listener route name as a callback.
     *
     * @param route name for your event listener
     * @param listener function (synchronous or Promise function)
     * @param logging is true by default
     */
    subscribe(route: string, listener: (evt: EventEnvelope) => void, logging?: boolean): void;
    /**
     * Reserved for internal use. Plese use the 'platform.release' API instead.
     *
     * Unsubscribe a registered function from a route name
     *
     * @param route name
     * @param logging is true by default
     */
    unsubscribe(route: string, logging?: boolean): void;
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
