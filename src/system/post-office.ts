import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { Logger } from '../util/logger.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { Utility } from '../util/utility.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { FunctionRegistry } from './function-registry.js';
import { Composable } from '../models/composable.js';
import { TemporaryInbox } from '../services/temporary-inbox.js';
import { EventHttpResolver } from '../util/event-http-resolver.js';

const log = Logger.getInstance();
const util = new Utility();
const registry = FunctionRegistry.getInstance();
const emitter = new EventEmitter();
const handlers = new Map();
const resolver = EventHttpResolver.getInstance();
const EVENT_MANAGER = "event.script.manager";
const TASK_EXECUTOR = "task.executor";
const ASYNC_HTTP_CLIENT = 'async.http.request';
const APPLICATION_OCTET_STREAM = "application/octet-stream";
const RPC = "rpc";
const X_EVENT_API = "x-event-api";
let self: PO = null;

export class PostOffice {
    private from: string = null;
    private traceId: string = null;
    private tracePath: string = null;
    private instance: string = "1";
    private trackable: boolean = false;

    constructor(event?: EventEnvelope | Sender) {
        self ??= PO.getInstance();
        if (event instanceof Sender) {
            this.trackable = true;
            this.from = event.originator;
            this.traceId = event.traceId;
            this.tracePath = event.tracePath;
        } else if (event instanceof EventEnvelope) {
            this.loadTracking(event.getHeaders());
        }
    }

    private loadTracking(info: object) {
        if ('my_route' in info) {
            this.trackable = true;
            this.from = typeof info['my_route'] == 'string'? info['my_route'] : null;
        }
        if ('my_instance' in info) {
            this.instance = typeof info['my_instance'] == 'string'? info['my_instance'] : null;
        }
        if ('my_trace_id' in info) {
            this.trackable = true;
            this.traceId = typeof info['my_trace_id'] == 'string'? info['my_trace_id'] : null;
        }
        if ('my_trace_path' in info) {
            this.tracePath = typeof info['my_trace_path'] == 'string'? info['my_trace_path'] : null;
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
     * Internal API - DO NOT call this method from user code
     * 
     * @returns the underlying event emitter
     */
    getEventEmitter(): EventEmitter {
        return emitter;
    }

    /**
     * Internal API - DO NOT call this method from user code
     * 
     * @returns registered handlers in the event loop
     */
    getHandlers() {
        return handlers;
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
     * Send an event
     * 
     * @param event envelope
     */
    async send(event: EventEnvelope) {
        this.touch(event);
        await self.send(event);
    }

    /**
     * Send an event later
     * 
     * @param event envelope
     * @param delay in milliseconds (default one second)
     * @returns timer
     */
    sendLater(event: EventEnvelope, delay = 1000): NodeJS.Timeout {
        this.touch(event);
        return self.sendLater(event, delay);
    }

    cancelFutureEvent(timer: NodeJS.Timeout): void {
        self.cancelFutureEvent(timer);
    }
    
    /**
     * Make an asynchronous RPC call
     * 
     * @param event envelope
     * @param timeout value in milliseconds
     * @returns a future promise of result event or error
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

    /**
     * Make a fork-n-join RPC call to multiple services
     * 
     * @param events in a list
     * @param timeout value in milliseconds
     * @returns a future promise of a list of result events or error
     */
    parallelRequest(events: Array<EventEnvelope>, timeout = 60000): Promise<Array<EventEnvelope>> {
        for (const event of events) {
            this.touch(event);
        }
        return self.parallelRequest(events, timeout);
    }   
}

export class Sender {
    originator: string;
    traceId: string;
    tracePath: string;

    constructor(originator: string, traceId: string, tracePath:string) {
        this.originator = originator;
        this.traceId = traceId;
        this.tracePath = tracePath;
    }
}

class PO {
    private static instance: PO;
    private readonly id: string;

    private constructor() { 
        this.id ??= util.getUuid();        
    }

    static getInstance() {
        PO.instance ??= new PO();
        return PO.instance;
    }

    getId(): string {
        return this.id;
    }

    exists(route: string): boolean {
        if (route) {
            return handlers.has(route);
        } else {
            return false;
        }        
    }

    async send(event: EventEnvelope) {
        // clone the event to guarantee the original content is immutable
        const input = new EventEnvelope().copy(event);
        const route = input.getTo();
        if (route) {
            const targetHttp = input.getHeader(X_EVENT_API)? null : resolver.getEventHttpTarget(route);
            const headers = resolver.getEventHttpHeaders(route);
            if (targetHttp) {
                this.sendEventApi(input, targetHttp, headers);
                return;
            }
            if (handlers.has(route)) {
                if (route == EVENT_MANAGER || route == TASK_EXECUTOR) {
                    // let event manager and task executor process the event directly
                    // because they are considered to be part of the event system.
                    setImmediate(() => {
                        const f = registry.getClass(route) as Composable;
                        f.handleEvent(input.setHeader('my_route', route));
                    });
                } else {
                    // serialize event envelope for immutability
                    emitter.emit(route, input.toBytes());
                }
            } else {
                throw new Error(`Route ${route} not found`);                
            }
        } else {
            log.warn(`Event ${input.getId()} dropped because there is no target service route`);
        }
    }

    async sendEventApi(input: EventEnvelope, targetHttp: string, headers: object) {
        const route = input.getTo();
        const callback = input.getReplyTo();
        const rpc = !!callback;
        const eventApiType = rpc? "callback" : "async";
        input.setReplyTo(null);
        const forwardEvent = new EventEnvelope(input.toMap()).setHeader(X_EVENT_API, eventApiType);
        const evt = await this.remoteRequest(forwardEvent, targetHttp, headers, rpc);
        if (rpc) {
            // Send the RPC response from the remote target service to the callback
            evt.setTo(callback).setReplyTo(null).setFrom(route)
                .setTraceId(input.getTraceId()).setTracePath(input.getTracePath())
                .setCorrelationId(input.getCorrelationId());
            try {
                await this.send(evt);
            } catch (e) {
                log.error(`Error in sending callback event ${route} from ${targetHttp} to ${callback} - ${e.message}`);
            }
        } else if (evt.getStatus() != 202) {
            log.error(`Error in sending async event ${route} to ${targetHttp} - status=${evt.getStatus()}`);
        }
    }

    sendLater(event: EventEnvelope, delay = 1000): NodeJS.Timeout {
        const timer = setTimeout(() => {
            this.send(event);
        }, delay);
        return timer;
    }

    cancelFutureEvent(timer: NodeJS.Timeout): void {
        clearTimeout(timer);
    }

    request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope> {
        return new Promise((resolve, reject) => {
            // clone the event to guarantee the original content is immutable
            const input = new EventEnvelope().copy(event);
            const utc = new Date().toISOString();
            const start = performance.now();
            const route = input.getTo();
            if (route) {
                const targetHttp = input.getHeader(X_EVENT_API)? null : resolver.getEventHttpTarget(route);
                const headers = resolver.getEventHttpHeaders(route);
                if (targetHttp) {
                    const callback = input.getReplyTo();
                    const rpc = !!callback;
                    const eventApiType = rpc? "callback" : "async";
                    input.setReplyTo(null);
                    const forwardEvent = new EventEnvelope(input.toMap()).setHeader(X_EVENT_API, eventApiType);
                    this.remoteRequest(forwardEvent, targetHttp, headers, rpc).then(res => {
                        resolve(res);
                    }).catch(e => {
                        reject(e as Error);
                    });
                } else if (handlers.has(route)) {
                    const cid = util.getUuid();
                    const timer = setTimeout(() => {
                        TemporaryInbox.clearPromise(cid);
                        reject(new AppException(408, `Route ${input.getTo()} timeout for ${timeout} ms`));
                    }, Math.max(10, timeout));
                    const map = {'resolve': resolve, 'reject': reject, 'utc': utc, 'start': start, 'timer': timer, 
                                 'traceId': input.getTraceId(), 'tracePath': input.getTracePath(),
                                 'oid': input.getCorrelationId(), 'route': route, 'from': input.getFrom()};
                    TemporaryInbox.setPromise(cid, map);                                                                
                    input.setReplyTo(TemporaryInbox.routeName).addTag(RPC, String(timeout));
                    input.setCorrelationId(cid);
                    // serialize event envelope for immutability
                    emitter.emit(route, input.toBytes());                    
                } else {
                    reject(new AppException(404, `Event ${input.getId()} dropped because ${route} not found`));
                }
            } else {
                reject(new AppException(400, `Event ${input.getId()} dropped because there is no target service route`));
            }
        });
    }

    remoteRequest(event: EventEnvelope, endpoint: string, securityHeaders: object = {}, rpc=true, timeout = 60000): Promise<EventEnvelope> {
        return new Promise((resolve, reject) => {
            // input event is serialized into bytes so it is READ only here, thus its content is immutable.
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
                            const response = new EventEnvelope(body);
                            resolve(response);
                        } catch(e) {
                            // response is not a packed EventEnvelope
                            resolve(new EventEnvelope().setStatus(400)
                                        .setBody(`Did you configure rest.yaml correctly? invalid result set - ${e.message}`));
                        }                        
                    } else if (result.getStatus() >= 400 && body && body.constructor == Object) {
                        const map = body as object;
                        if ('type' in map && 'error' == map['type'] && 'message' in map && typeof map['message'] == 'string') {
                            resolve(new EventEnvelope().setStatus(result.getStatus()).setBody(map['message']));
                        } else {
                            resolve(result);
                        }
                    } else {
                        resolve(result);
                    }                 
                })
                .catch(e => {
                    const status = e instanceof AppException? e.getStatus() : 500;
                    reject(new AppException(status, e.message));
                });
        });       
    }

    parallelRequest(events: Array<EventEnvelope>, timeout = 60000): Promise<Array<EventEnvelope>> {
        return new Promise((resolve, reject) => {
            // validate events
            if (events.length == 0) {
                reject(new AppException(400, 'Input must be not an empty list'));
            }
            for (const event of events) {
                if (!(event instanceof EventEnvelope)) {
                    reject(new AppException(400, 'Input must be a list of events'));
                    return;
                }
            }
            // process events
            let normal = true;
            const consolidated = new Array<EventEnvelope>();
            for (const event of events) {
                this.request(event, timeout)
                    .then(result => {
                        if (normal) {
                            consolidated.push(result);
                            if (consolidated.length == events.length) {
                                resolve(consolidated);
                            }
                        }
                    })
                    .catch(e => {
                        normal = false;
                        const status = e instanceof AppException? e.getStatus() : 500;
                        reject(new AppException(status, e.message));
                    });
            }
        });
    }
}
