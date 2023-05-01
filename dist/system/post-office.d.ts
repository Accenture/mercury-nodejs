import { EventEnvelope } from '../models/event-envelope.js';
export declare class PO {
    constructor();
    getInstance(headers: object): PostOffice | TrackablePo;
}
declare class TrackablePo {
    private from;
    private traceId;
    private tracePath;
    constructor(headers: object);
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
     * Subscribe an event listener to a route name
     * (this method register an unmanaged service)
     *
     * For managed service, please use the 'platform.register' method.
     *
     * In some rare case, you may register your listener as a unmanaged service.
     * The listener will be running without the control of the platform service.
     * i.e. distributed tracing and RPC features will be disabled.
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
}
declare class PostOffice {
    private po;
    private handlers;
    private id;
    constructor();
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
     * Subscribe an event listener to a route name
     * (this method register an unmanaged service)
     *
     * For managed service, please use the 'platform.register' method.
     *
     * In some rare case, you may register your listener as a unmanaged service.
     * The listener will be running without the control of the platform service.
     * i.e. distributed tracing and RPC features will be disabled.
     *
     * The system enforces exclusive subscriber. If you need multiple functions to listen to the same route,
     * please implement your own multiple subscription logic. A typical approach is to implement a forwarder
     * and send a subscription request to the forwarder function with your listener route name as a callback.
     *
     * @param route name for your event listener
     * @param listener function (synchronous or Promise function)
     * @param logging is true by default
     */
    subscribe(route: string, listener: (headers: object, evt: EventEnvelope) => void, logging?: boolean): void;
    /**
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
}
export {};
