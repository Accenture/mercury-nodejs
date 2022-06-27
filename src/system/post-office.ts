import { isMainThread } from 'worker_threads';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { Logger } from '../util/logger.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { Utility } from '../util/utility.js';

const log = new Logger().getInstance();
const util = new Utility().getInstance();
let self: PostOffice = null;
const SERVICE_LIFE_CYCLE = 'service.life.cycle';
const WS_WORKER = 'ws.worker';
const SERVICE_QUERY = 'system.service.query';

export class PO {

    constructor() {
        // post office is not supported in worker threads because
        // worker thread can only communicate with main thread using parent-worker channel
        if (self == null && isMainThread) {
            self = new PostOffice();
        }
    }
  
    getInstance(): PostOffice {
        return self;
    }

    getTraceAwareInstance(evt: EventEnvelope) {
        return new PoWithTrace(evt);
    }

}

class PoWithTrace {

    private evt = null;

    constructor(evt: EventEnvelope) {
        this.evt = evt;
    }

    /**
     * Application instance ID
     * 
     * @returns unique ID
     */
    getId(): string {
        return self.getId();
    }

    /**
     * Check if the application is running in standalone or cloud mode
     * 
     * @returns true or false
     */
     isCloudLoaded(): boolean {
        return self.isCloudLoaded();
    }

    /**
     * Check if the application is connected to the cloud via a language connector
     * 
     * @returns true or false
     */
    isCloudConnected(): boolean {
        return self.isCloudConnected();
    }

    /**
     * Check if the connection is ready for sending events to the cloud
     * 
     * @returns true or false
     */
    isReady(): boolean {
        return self.isReady();
    }

    /**
     * Check if a route has been registered
     * 
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): Promise<boolean> {
        return self.exists(route);
    }

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
    subscribe(route: string, listener: (evt: EventEnvelope) => void, logging = true): void {
        self.subscribe(route, listener, logging);
    }

    /**
     * Unsubscribe a registered function from a route name
     * 
     * @param route name
     * @param logging is true by default
     */
     unsubscribe(route: string, logging = true): void {
        self.unsubscribe(route, logging);
    }

    /**
     * Send an event
     * 
     * @param event envelope
     */
     send(event: EventEnvelope): void {
        self.send(new EventEnvelope(event).setTrace(this.evt));
     }
     
    /**
     * Send an event later
     * 
     * @param event envelope
     * @param delay in milliseconds (default one second)
     */
     sendLater(event: EventEnvelope, delay = 1000): void {
        self.sendLater(new EventEnvelope(event).setTrace(this.evt), delay);
    }
    
    /**
     * Make an asynchronous RPC call
     * 
     * @param event envelope
     * @param timeout value in milliseconds
     * @returns a future promise of result or error
     */
     request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope> {
        return self.request(new EventEnvelope(event).setTrace(this.evt), timeout);
     }    

}

class PostOffice {

    private po = new EventEmitter.EventEmitter();
    private handlers = new Map();
    private id: string;
    private cloudLoaded = false;
    private cloudAuthenticated = false;
    private cloudConnected = false;
    private ready = false;

    constructor() {
        self = this;
        self.id = 'js-'+util.getUuid();
        log.info(`Event system started - ${self.id}`);
    }

    /**
     * Application instance ID
     * 
     * @returns unique ID
     */
    getId(): string {
        return self.id;
    }

    /**
     * This method is reserved by the system. DO NOT call it directly from your app.
     * 
     * @param status of cloud connection
     */
    setStatus(status: 'loaded' | 'connected' | 'authenticated' | 'ready' | 'disconnected'): void {
        if ('loaded' == status) {
            self.cloudLoaded = true;
        }
        if ('connected' == status) {
            self.cloudConnected = true;
        }
        if ('authenticated' == status) {
            self.cloudAuthenticated = true;
        }
        if ('ready' == status) {
            self.ready = true;
        }
        if ('disconnected' == status) {
            self.cloudConnected = false;
            self.cloudAuthenticated = false;
            self.ready = false;
        }
    }

    /**
     * Check if the application is running in standalone or cloud mode
     * 
     * @returns true or false
     */
    isCloudLoaded(): boolean {
        return self.cloudLoaded;
    }

    /**
     * Check if the application is connected to the cloud via a language connector
     * 
     * @returns true or false
     */
    isCloudConnected(): boolean {
        return self.cloudConnected;
    }

    /**
     * Check if the application has been authenticated by the cloud
     * 
     * @returns true or false
     */
    isCloudAuthenticated(): boolean {
        return self.cloudAuthenticated;
    }

    /**
     * Check if the connection is ready for sending events to the cloud
     * 
     * @returns true or false
     */
    isReady(): boolean {
        return self.ready;
    }

    /**
     * Check if a route has been registered
     * 
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): Promise<boolean> {
        return new Promise((resolve) => {
            if (self.handlers.has(route)) {
                resolve(true);
            } else if (self.isCloudAuthenticated()) {
                self.request(new EventEnvelope().setTo(SERVICE_QUERY).setHeader('type', 'find').setHeader('route', route), 8000).then((response) => {
                    resolve(response.getBody()? true : false)
                });
    
            } else {
                resolve(false);
            }
        });
    }

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
    subscribe(route: string, listener: (evt: EventEnvelope) => void, logging = true): void {
        if (!route) {
            throw new Error('Missing route');
        }
        if (!listener) {
            throw new Error('Missing listener');
        }
        if (!(listener instanceof Function)) {
            throw new Error('Invalid listener function');
        }
        if (self.handlers.has(route)) {
            self.unsubscribe(route);
        }
        self.handlers.set(route, listener);
        self.po.on(route, listener);
        if (logging) {
            log.info(`${route} registered`);
        }
    }

    /**
     * Unsubscribe a registered function from a route name
     * 
     * @param route name
     * @param logging is true by default
     */
    unsubscribe(route: string, logging = true): void {
        if (self.handlers.has(route)) {
            const service = self.handlers.get(route);
            self.po.removeListener(route, service);
            self.handlers.delete(route);
            if (logging) {
                log.info(`${route} unregistered`);
            }
            // inform platform service to check if this is a managed service and to do housekeeping
            self.send(new EventEnvelope().setTo(SERVICE_LIFE_CYCLE).setHeader('type', 'unsubscribe').setHeader('route', route));
        }
    }

    /**
     * Send an event
     * 
     * @param event envelope
     */
    send(event: EventEnvelope): void {
        const route = event.getTo();
        if (route) {
            if (event.getBroadcast()) {
                if (self.isCloudAuthenticated()) {
                    self.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'event').setBody(event.toMap()));
                } else if (self.handlers.has(route)) {
                    self.po.emit(route, event);
                }

            } else {
                if (self.handlers.has(route)) {
                    self.po.emit(route, event);
                } else {
                    if (self.isCloudAuthenticated()) {
                        // forward event to cloud
                        self.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'event').setBody(event.toMap()));
    
                    } else {
                        log.error(`Event ${event.getId()} dropped because ${route} not found`);
                    }
                }
            }


        } else {
            log.warn(`Event ${event.getId()} dropped because there is no target service route`);
        }
    }

    /**
     * Send an event later
     * 
     * @param event envelope
     * @param delay in milliseconds (default one second)
     */
    sendLater(event: EventEnvelope, delay = 1000): void {
        util.sleep(Math.max(10, delay)).then(() => self.send(event));
    }

    /**
     * Make an asynchronous RPC call
     * 
     * @param event envelope
     * @param timeout value in milliseconds
     * @returns a future promise of result or error
     */
    request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope> {
        return new Promise((resolve, reject) => {
            const start = performance.timeOrigin + performance.now();
            const route = event.getTo();
            if (route) {
                const local = self.handlers.has(route);
                if (local || self.isCloudAuthenticated()) {
                    const callback = 'r.'+util.getUuid();
                    const timer = setTimeout(() => {
                        reject(new AppException(408, `Route ${event.getId()} timeout for ${timeout} ms`));
                    }, Math.max(10, timeout));
                    
                    self.subscribe(callback, (response: EventEnvelope) => {
                        clearTimeout(timer);
                        self.unsubscribe(callback, false);
                        if (response.isException()) {
                            reject(new AppException(response.getStatus(), String(response.getBody())));
                        } else {
                            const diff = parseFloat((performance.timeOrigin + performance.now() - start).toFixed(3));
                            resolve(response.setRoundTrip(diff));
                        }
                    }, false);
                    if (local) {
                        event.setReplyTo(callback);
                        self.po.emit(route, event);
                    } else {
                        // forward event to cloud
                        event.setReplyTo('->'+callback);
                        self.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'event').setBody(event.toMap()));
                    }
                    
                } else {
                    reject(new Error(`Event ${event.getId()} dropped because ${route} not found`));
                }
            } else {
                reject(new Error(`Event ${event.getId()} dropped because there is no target service route`));
            }
        });
    }

}
