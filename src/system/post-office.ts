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
const DISTRIBUTED_TRACING = 'distributed.tracing';
const RPC = "rpc";

export class PO {

    constructor() {
        // post office is not supported in worker threads because
        // worker thread can only communicate with main thread using parent-worker channel
        if (self == null && isMainThread) {
            self = new PostOffice();
        }
    }

    getInstance(headers: object) {
        return 'my_route' in headers? new TrackablePo(headers): self;
    }

}

class TrackablePo {

    private from: string;
    private traceId: string;
    private tracePath: string;

    constructor(headers: object) {
        this.from = 'my_route' in headers? String(headers['my_route']) : null;
        this.traceId = 'my_trace_id' in headers? String(headers['my_trace_id']) : null;
        this.tracePath = 'my_trace_path' in headers? String(headers['my_trace_path']) : null;
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
     * Check if a route has been registered
     * 
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): boolean {
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
        self.send(new EventEnvelope(event).setFrom(this.from).setTraceId(this.traceId).setTracePath(this.tracePath));
     }
     
    /**
     * Send an event later
     * 
     * @param event envelope
     * @param delay in milliseconds (default one second)
     */
     sendLater(event: EventEnvelope, delay = 1000): void {
        self.sendLater(new EventEnvelope(event).setFrom(this.from).setTraceId(this.traceId).setTracePath(this.tracePath), delay);
    }
    
    /**
     * Make an asynchronous RPC call
     * 
     * @param event envelope
     * @param timeout value in milliseconds
     * @returns a future promise of result or error
     */
     request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope> {
        return self.request(new EventEnvelope(event).setFrom(this.from).setTraceId(this.traceId).setTracePath(this.tracePath), timeout);
     }    

}

class PostOffice {

    private po = new EventEmitter();
    private handlers = new Map();
    private id: string;

    constructor() {
        self = this;
        self.id = util.getUuid();
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
     * Check if a route has been registered
     * 
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route: string): boolean {
        return self.handlers.has(route);
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
    subscribe(route: string, listener: (headers: object, evt: EventEnvelope) => void, logging = true): void {
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
            if (!route.includes('#')) {
                self.send(new EventEnvelope().setTo(SERVICE_LIFE_CYCLE).setHeader('type', 'unsubscribe').setHeader('route', route));
            }            
        }
    }

    /**
     * Send an event
     * 
     * @param event envelope
     */
    send(event: EventEnvelope): void {
        const headers = event.getHeaders();
        if ('my_route' in headers) {
            delete headers['my_route'];
        }
        if ('my_instance' in headers) {
            delete headers['my_instance'];
        }
        if ('my_trace_id' in headers) {
            delete headers['my_trace_id'];
        }
        if ('my_trace_path' in headers) {
            delete headers['my_trace_path'];
        }
        const route = event.getTo();
        if (route) {
            if (self.handlers.has(route)) {
                self.po.emit(route, event);
            } else {
                log.error(`Event ${event.getId()} dropped because ${route} not found`);
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
        const headers = event.getHeaders();
        if ('my_route' in headers) {
            delete headers['my_route'];
        }
        if ('my_instance' in headers) {
            delete headers['my_instance'];
        }
        if ('my_trace_id' in headers) {
            delete headers['my_trace_id'];
        }
        if ('my_trace_path' in headers) {
            delete headers['my_trace_path'];
        }
        return new Promise((resolve, reject) => {
            const utc = new Date().toISOString();
            const start = performance.now();
            const route = event.getTo();
            if (route) {
                if (self.handlers.has(route)) {
                    const callback = 'r.'+util.getUuid();
                    const timer = setTimeout(() => {
                        self.unsubscribe(callback, false);
                        reject(new AppException(408, `Route ${event.getTo()} timeout for ${timeout} ms`));
                    }, Math.max(10, timeout));
                    
                    self.subscribe(callback, (response: EventEnvelope) => {
                        clearTimeout(timer);
                        self.unsubscribe(callback, false);
                        if (response.isException()) {
                            reject(new AppException(response.getStatus(), String(response.getBody())));
                        } else {
                            const diff = parseFloat((performance.now() - start).toFixed(3));
                            response.setRoundTrip(diff);
                            // send tracing information if needed
                            if (event.getTraceId() && event.getTracePath()) {
                                const metrics = {'origin': self.getId(), 'id': event.getTraceId(), 'path': event.getTracePath(), 
                                                'service': event.getTo(), 'start': utc, 'success': true, 
                                                'exec_time': response.getExecTime(), 'round_trip': diff};
                                if (event.getFrom()) {
                                    metrics['from'] = event.getFrom();
                                }
                                const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({'trace': metrics});
                                self.send(trace);
                            }
                            resolve(response);
                        }
                    }, false);
                    event.setReplyTo(callback);
                    event.addTag(RPC, String(timeout));
                    self.po.emit(route, event);
                    
                } else {
                    reject(new Error(`Event ${event.getId()} dropped because ${route} not found`));
                }
            } else {
                reject(new Error(`Event ${event.getId()} dropped because there is no target service route`));
            }
        });
    }

}
