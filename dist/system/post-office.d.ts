import { EventEnvelope } from '../models/event-envelope.js';
export declare class PO {
    constructor();
    getInstance(): PostOffice;
    getTraceAwareInstance(evt: EventEnvelope): PoWithTrace;
}
declare class PoWithTrace {
    private evt;
    constructor(evt: EventEnvelope);
    /**
     * Application instance ID
     *
     * @returns unique ID
     */
    getId(): string;
    /**
     * Check if the application is running in standalone or cloud mode
     *
     * @returns true or false
     */
    isCloudLoaded(): boolean;
    /**
     * Check if the application is connected to the cloud via a language connector
     *
     * @returns true or false
     */
    isCloudConnected(): boolean;
    /**
     * Check if the connection is ready for sending events to the cloud
     *
     * @returns true or false
     */
    isReady(): boolean;
    /**
     * Check if a route has been registered
     *
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): Promise<boolean>;
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
    private cloudLoaded;
    private cloudAuthenticated;
    private cloudConnected;
    private ready;
    constructor();
    /**
     * Application instance ID
     *
     * @returns unique ID
     */
    getId(): string;
    /**
     * This method is reserved by the system. DO NOT call it directly from your app.
     *
     * @param status of cloud connection
     */
    setStatus(status: 'loaded' | 'connected' | 'authenticated' | 'ready' | 'disconnected'): void;
    /**
     * Check if the application is running in standalone or cloud mode
     *
     * @returns true or false
     */
    isCloudLoaded(): boolean;
    /**
     * Check if the application is connected to the cloud via a language connector
     *
     * @returns true or false
     */
    isCloudConnected(): boolean;
    /**
     * Check if the application has been authenticated by the cloud
     *
     * @returns true or false
     */
    isCloudAuthenticated(): boolean;
    /**
     * Check if the connection is ready for sending events to the cloud
     *
     * @returns true or false
     */
    isReady(): boolean;
    /**
     * Check if a route has been registered
     *
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): Promise<boolean>;
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
export {};
