import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { Logger } from '../util/logger.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { Utility } from '../util/utility.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { FunctionRegistry } from '../util/function-registry.js';

const log = new Logger();
const util = new Utility();
const registry = new FunctionRegistry();
let self: PO = null;
const DISTRIBUTED_TRACING = 'distributed.tracing';
const ASYNC_HTTP_CLIENT = 'async.http.request';
const APPLICATION_OCTET_STREAM = "application/octet-stream";
const RPC = "rpc";

export class PostOffice {

    private from: string = null;
    private instance: string = null;
    private traceId: string = null;
    private tracePath: string = null;
    private trackable = false;    

    constructor(headers?: object) {
        if (self == null) {
            self = new PO();
        }
        if (headers && headers.constructor == Object) {
            if ('my_route' in headers) {
                this.from = String(headers['my_route']);
                this.trackable = true;
            }
            if ('my_instance' in headers) {
                this.instance = String(headers['my_instance']);
                this.trackable = true;
            }
            if ('my_trace_id' in headers) {
                this.traceId = String(headers['my_trace_id']);
                this.trackable = true;
            }
            if ('my_trace_path' in headers) {
                this.tracePath = String(headers['my_trace_path']);
            }
        }
    }

    private touch(event: EventEnvelope) {
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
        if (this.trackable) {
            event.setFrom(this.from);
            event.setTraceId(this.traceId);
            event.setTracePath(this.tracePath);
        }
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
     * Obtain the "this" reference (i.e. class instance) of my function
     * 
     * @returns the Composable class holding the function that instantiates this PostOffice
     */
    getMyClass(): object {
        return this.trackable? registry.getClass(this.from) : null;
    }

    /**
     * Get my own route name
     * 
     * @returns route name
     */
    getMyRoute(): string {
        return this.from;
    }

    /**
     * Retrieve the instance number of this worker for the function
     * 
     * @returns worker instance number
     */
    getMyInstance(): string {
        return this.instance;
    }

    /**
     * Retrieve the optional trace ID for the incoming event
     * 
     * @returns trace ID or null
     */
    getMyTraceId(): string {
        return this.traceId;
    }

    /**
     * Retrieve the optional trace path for the incoming event
     * 
     * @returns trace path or null
     */
    getMyTracePath(): string {
        return this.tracePath;
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
    subscribe(route: string, listener: (evt: EventEnvelope) => void, logging = true): void {
        self.subscribe(route, listener, logging);
    } 

    /**
     * Reserved for internal use. Plese use the 'platform.release' API instead.
     * 
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
        this.touch(event);
        self.send(event);
    }

    /**
     * Send an event later
     * 
     * @param event envelope
     * @param delay in milliseconds (default one second)
     */
    sendLater(event: EventEnvelope, delay = 1000): void {
        this.touch(event);
        self.sendLater(event, delay);
    }
    
    /**
     * Make an asynchronous RPC call
     * 
     * @param event envelope
     * @param timeout value in milliseconds
     * @returns a future promise of result or error
     */
    request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope> {
        this.touch(event);
        return self.request(event, timeout);
    }  
    
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
    remoteRequest(event: EventEnvelope, endpoint: string, securityHeaders: object = {}, rpc=true, timeout = 60000): Promise<EventEnvelope> {
        this.touch(event);
        return self.remoteRequest(event, endpoint, securityHeaders, rpc, timeout);   
    }
}

class PO {

    private po = new EventEmitter();
    private handlers = new Map();
    private id: string = util.getUuid();

    getId(): string {
        return this.id;
    }

    exists(route: string): boolean {
        if (route && route.length > 0) {
            return this.handlers.has(route);
        } else {
            return false;
        }        
    }

    subscribe(route: string, listener: (evt: EventEnvelope) => void, logging = true): void {
        if (!route) {
            throw new Error('Missing route');
        }
        const hash = route.indexOf('#');
        const name = hash == -1? route : route.substring(0, hash);
        const worker = hash == -1? null : route.substring(hash+1); 
        if (!util.validRouteName(name)) {
            throw new Error('Invalid route name - use 0-9, a-z, period, hyphen or underscore characters');
        }
        if (worker != null && (worker.length == 0 || !util.isDigits(worker))) {
            throw new Error('Invalid route worker suffix');
        }
        if (!listener) {
            throw new Error('Missing listener');
        }
        if (!(listener instanceof Function)) {
            throw new Error('Invalid listener function');
        }
        if (this.handlers.has(route)) {
            this.unsubscribe(route);
        }
        this.handlers.set(route, listener);
        this.po.on(route, listener);
        if (logging) {
            log.info(`${route} registered`);
        }
    }

    unsubscribe(route: string, logging = true): void {
        if (this.handlers.has(route)) {
            const service = this.handlers.get(route);
            this.po.removeListener(route, service);
            this.handlers.delete(route);
            if (logging) {
                log.info(`${route} unregistered`);
            }          
        }
    }

    send(event: EventEnvelope): void {
        const route = event.getTo();
        if (route) {
            if (this.handlers.has(route)) {
                this.po.emit(route, event);
            } else {
                const traceRef = event.getTraceId()? `Trace (${event.getTraceId()}), ` : '';
                log.error(`${traceRef}Event ${event.getId()} dropped because ${route} not found`);                
            }
        } else {
            log.warn(`Event ${event.getId()} dropped because there is no target service route`);
        }
    }

    sendLater(event: EventEnvelope, delay = 1000): void {
        util.sleep(Math.max(10, delay)).then(() => this.send(event));
    }

    request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope> {
        return new Promise((resolve, reject) => {
            const utc = new Date().toISOString();
            const start = performance.now();
            const route = event.getTo();
            if (route) {
                if (this.handlers.has(route)) {
                    const callback = 'r.'+util.getUuid();
                    const timer = setTimeout(() => {
                        this.unsubscribe(callback, false);
                        reject(new AppException(408, `Route ${event.getTo()} timeout for ${timeout} ms`));
                    }, Math.max(10, timeout));                    
                    this.subscribe(callback, (response: EventEnvelope) => {                        
                        clearTimeout(timer);
                        this.unsubscribe(callback, false);
                        if (response.isException()) {
                            reject(new AppException(response.getStatus(), String(response.getBody())));
                        } else {
                            // remove some metadata
                            response.removeTag(RPC).setTo(null).setReplyTo(null).setTraceId(null).setTracePath(null);
                            const diff = parseFloat((performance.now() - start).toFixed(3));
                            response.setRoundTrip(diff);
                            // send tracing information if needed
                            if (event.getTraceId() && event.getTracePath()) {
                                const metrics = {'origin': this.getId(), 'id': event.getTraceId(), 'path': event.getTracePath(), 
                                                'service': event.getTo(), 'start': utc, 'success': true, 
                                                'exec_time': response.getExecTime(), 'round_trip': diff};
                                if (event.getFrom()) {
                                    metrics['from'] = event.getFrom();
                                }
                                const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({'trace': metrics});
                                this.send(trace);
                            }
                            resolve(response);
                        }
                    }, false);
                    event.setReplyTo(callback);
                    event.addTag(RPC, String(timeout));
                    this.po.emit(route, event);
                    
                } else {
                    reject(new AppException(404, `Event ${event.getId()} dropped because ${route} not found`));
                }
            } else {
                reject(new AppException(400, `Event ${event.getId()} dropped because there is no target service route`));
            }
        });
    }

    remoteRequest(event: EventEnvelope, endpoint: string, securityHeaders: object = {}, rpc=true, timeout = 60000): Promise<EventEnvelope> {
        return new Promise((resolve, reject) => {
            const bytes = event.toBytes();
            const req = new AsyncHttpRequest().setMethod('POST');
            req.setHeader('Content-Type', APPLICATION_OCTET_STREAM).setHeader('X-TTL', String(timeout)).setBody(bytes);
            let host: string;
            let path: string;
            try {
                const target = new URL(endpoint);
                let secure: boolean;
                const protocol = target.protocol;
                if ("http:" == protocol) {
                    secure = false;
                } else if ("https:" == protocol) {
                    secure = true;
                } else {
                    throw new Error('Protocol must be http or https');
                }
                host = (secure ? 'https://' : 'http://') + target.host
                path = target.pathname;
            } catch (ex) {
                reject(new AppException(400, ex.message));
            }
            req.setTargetHost(host).setUrl(path);
            if (event.getTraceId()) {
              req.setHeader('X-Trace-Id', event.getTraceId());
            }
            if (!rpc) {
                req.setHeader('X-Async', 'true');
            }
            Object.keys(securityHeaders).forEach(k => {
                req.setHeader(k, securityHeaders[k]);
            });
            const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
            this.request(reqEvent, timeout)
                .then(result => {
                    const body = result.getBody();
                    if (body instanceof Buffer) {
                        try {
                            const response = new EventEnvelope(body as Buffer);
                            resolve(response);
                        } catch(e) {
                            // response is not a packed EventEnvelope
                            resolve(new EventEnvelope().setStatus(400)
                                        .setBody("Did you configure rest.yaml correctly? " +
                                                    "Invalid result set - "+e.getMessage()));
                        }                        
                    } else {
                        if (result.getStatus() >= 400 && body && body.constructor == Object) {
                            const map = body as object;
                            if ('type' in map && 'error' == map['type'] && 'message' in map && typeof map['message'] == 'string') {
                                resolve(new EventEnvelope().setStatus(result.getStatus()).setBody(map['message']));
                            } else {
                                resolve(result);
                            }
                        } else {
                            resolve(result);
                        }                        
                    }                 
                })
                .catch(e => {
                    const status = e instanceof AppException? e.getStatus() : 500;
                    reject(new AppException(status, e.message));
                });
        });       
    }

}
