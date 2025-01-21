import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { Logger } from '../util/logger.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { Utility } from '../util/utility.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { FunctionRegistry } from './function-registry.js';
const log = Logger.getInstance();
const util = new Utility();
const registry = FunctionRegistry.getInstance();
const emitter = new EventEmitter();
const handlers = new Map();
const eventHttpTargets = {};
const eventHttpHeaders = {};
let self = null;
const EVENT_MANAGER = "event.script.manager";
const TASK_EXECUTOR = "task.executor";
const DISTRIBUTED_TRACING = 'distributed.tracing';
const ASYNC_HTTP_CLIENT = 'async.http.request';
const APPLICATION_OCTET_STREAM = "application/octet-stream";
const RPC = "rpc";
const X_EVENT_API = "x-event-api";
export class PostOffice {
    from = null;
    traceId = null;
    tracePath = null;
    instance = "1";
    trackable = false;
    constructor(headers) {
        if (self == null) {
            self = new PO();
        }
        if (headers && headers instanceof Sender) {
            this.trackable = true;
            this.from = headers.originator;
            this.traceId = headers.traceId;
            this.tracePath = headers.tracePath;
        }
        if (headers && headers.constructor == Object) {
            if ('my_route' in headers) {
                this.trackable = true;
                this.from = String(headers['my_route']);
            }
            if ('my_instance' in headers) {
                this.instance = String(headers['my_instance']);
            }
            if ('my_trace_id' in headers) {
                this.trackable = true;
                this.traceId = String(headers['my_trace_id']);
            }
            if ('my_trace_path' in headers) {
                this.tracePath = String(headers['my_trace_path']);
            }
        }
    }
    touch(event) {
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
     * DO NOT use this method directly.
     * This will be invoked at application startup by the platform class.
     *
     * @param file path of the config file
     * @param config ConfigReader
     */
    loadHttpRoutes(file, config) {
        const o = config.get("event.http");
        if (Array.isArray(o)) {
            const eventHttpEntries = o;
            for (let i = 0; i < eventHttpEntries.length; i++) {
                const route = config.getProperty("event.http[" + i + "].route");
                const target = config.getProperty("event.http[" + i + "].target");
                if (route && target) {
                    eventHttpTargets[route] = target;
                    let headerCount = 0;
                    const h = config.get("event.http[" + i + "].headers");
                    if (h instanceof Object && !Array.isArray(h)) {
                        const headers = {};
                        Object.keys(h).forEach(k => {
                            headers[String(k)] = config.getProperty("event.http[" + i + "].headers." + k);
                            headerCount++;
                        });
                        eventHttpHeaders[route] = headers;
                    }
                    log.info(`Event-over-HTTP ${route} -> ${target} with ${headerCount} header${headerCount == 1 ? '' : 's'}`);
                }
            }
            const total = Object.keys(eventHttpTargets).length;
            log.info(`Total ${total} event-over-http target${total == 1 ? '' : 's'} configured`);
        }
        else {
            log.error(`Invalid config ${file} - the event.http section should be a list of route and target`);
        }
    }
    /**
     * Application instance ID
     *
     * @returns unique ID
     */
    getId() {
        return self.getId();
    }
    /**
     * Internal API - DO NOT call this method from user code
     *
     * @returns the underlying event emitter
     */
    getEventEmitter() {
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
    getMyClass() {
        return this.trackable ? registry.getClass(this.from) : null;
    }
    /**
     * Get my own route name
     *
     * @returns route name
     */
    getMyRoute() {
        return this.from;
    }
    /**
     * Retrieve the instance number of this worker for the function
     *
     * @returns worker instance number
     */
    getMyInstance() {
        return this.instance;
    }
    /**
     * Retrieve the optional trace ID for the incoming event
     *
     * @returns trace ID or null
     */
    getMyTraceId() {
        return this.traceId;
    }
    /**
     * Retrieve the optional trace path for the incoming event
     *
     * @returns trace path or null
     */
    getMyTracePath() {
        return this.tracePath;
    }
    /**
     * Check if a route has been registered
     *
     * @param route name of the registered function
     * @returns promise of true or false
     */
    exists(route) {
        return self.exists(route);
    }
    /**
     * Send an event
     *
     * @param event envelope
     */
    async send(event) {
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
    sendLater(event, delay = 1000) {
        this.touch(event);
        return self.sendLater(event, delay);
    }
    cancelFutureEvent(timer) {
        self.cancelFutureEvent(timer);
    }
    /**
     * Make an asynchronous RPC call
     *
     * @param event envelope
     * @param timeout value in milliseconds
     * @returns a future promise of result or error
     */
    request(event, timeout = 60000) {
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
    remoteRequest(event, endpoint, securityHeaders = {}, rpc = true, timeout = 60000) {
        this.touch(event);
        return self.remoteRequest(event, endpoint, securityHeaders, rpc, timeout);
    }
}
export class Sender {
    originator;
    traceId;
    tracePath;
    constructor(originator, traceId, tracePath) {
        this.originator = originator;
        this.traceId = traceId;
        this.tracePath = tracePath;
    }
}
class PO {
    id = util.getUuid();
    getId() {
        return this.id;
    }
    exists(route) {
        if (route && route.length > 0) {
            return handlers.has(route);
        }
        else {
            return false;
        }
    }
    subscribeInbox(route, listener) {
        // no need for input validation because this method is used internally by the request method
        handlers.set(route, listener);
        emitter.on(route, listener);
        log.debug(`Inbox ${route} registered`);
    }
    unsubscribeInbox(route) {
        if (handlers.has(route)) {
            const service = handlers.get(route);
            emitter.removeListener(route, service);
            handlers.delete(route);
            log.debug(`Inbox ${route} unregistered`);
        }
    }
    async send(event) {
        const route = event.getTo();
        if (route) {
            const targetHttp = event.getHeader(X_EVENT_API) ? null : eventHttpTargets[route];
            const headers = eventHttpHeaders[route];
            if (targetHttp) {
                const callback = event.getReplyTo();
                const rpc = callback ? true : false;
                const eventApiType = rpc ? "callback" : "async";
                event.setReplyTo(null);
                const forwardEvent = new EventEnvelope(event.toMap()).setHeader(X_EVENT_API, eventApiType);
                const evt = await this.remoteRequest(forwardEvent, targetHttp, headers, rpc);
                if (rpc) {
                    // Send the RPC response from the remote target service to the callback
                    evt.setTo(callback).setReplyTo(null).setFrom(route)
                        .setTraceId(event.getTraceId()).setTracePath(event.getTracePath())
                        .setCorrelationId(event.getCorrelationId());
                    try {
                        await this.send(evt);
                    }
                    catch (e) {
                        log.error(`Error in sending callback event ${route} from ${targetHttp} to ${callback} - ${e.message}`);
                    }
                }
                else {
                    if (evt.getStatus() != 202) {
                        log.error(`Error in sending async event ${route} to ${targetHttp} - status=${evt.getStatus()}, error=${String(evt.getBody())}`);
                    }
                }
                return;
            }
            if (handlers.has(route)) {
                if (route == EVENT_MANAGER || route == TASK_EXECUTOR) {
                    // let event manager and task executor process the event directly
                    // because they are considered to be part of the event system.
                    setImmediate(() => {
                        const f = registry.getClass(route);
                        f.handleEvent(event.setHeader('my_route', route));
                    });
                }
                else {
                    // serialize event envelope for immutability
                    emitter.emit(route, event.toBytes());
                }
            }
            else {
                throw new Error(`Route ${route} not found`);
            }
        }
        else {
            log.warn(`Event ${event.getId()} dropped because there is no target service route`);
        }
    }
    sendLater(event, delay = 1000) {
        const timer = setTimeout(() => {
            this.send(event);
        }, delay);
        return timer;
    }
    cancelFutureEvent(timer) {
        clearTimeout(timer);
    }
    request(event, timeout = 60000) {
        return new Promise((resolve, reject) => {
            const utc = new Date().toISOString();
            const start = performance.now();
            const route = event.getTo();
            if (route) {
                const targetHttp = event.getHeader(X_EVENT_API) ? null : eventHttpTargets[route];
                const headers = eventHttpHeaders[route];
                if (targetHttp) {
                    const callback = event.getReplyTo();
                    const rpc = callback ? true : false;
                    const eventApiType = rpc ? "callback" : "async";
                    event.setReplyTo(null);
                    const forwardEvent = new EventEnvelope(event.toMap()).setHeader(X_EVENT_API, eventApiType);
                    this.remoteRequest(forwardEvent, targetHttp, headers, rpc).then(res => {
                        resolve(res);
                    }).catch(e => {
                        reject(e);
                    });
                }
                if (handlers.has(route)) {
                    const callback = 'r.' + util.getUuid();
                    const timer = setTimeout(() => {
                        this.unsubscribeInbox(callback);
                        reject(new AppException(408, `Route ${event.getTo()} timeout for ${timeout} ms`));
                    }, Math.max(10, timeout));
                    this.subscribeInbox(callback, (payload) => {
                        const response = new EventEnvelope(payload);
                        clearTimeout(timer);
                        this.unsubscribeInbox(callback);
                        if (response.isException()) {
                            reject(new AppException(response.getStatus(), String(response.getBody())));
                        }
                        else {
                            // remove some metadata
                            response.removeTag(RPC).setTo(null).setReplyTo(null).setTraceId(null).setTracePath(null);
                            const diff = parseFloat((performance.now() - start).toFixed(3));
                            response.setRoundTrip(diff);
                            // send tracing information if needed
                            if (event.getTraceId() && event.getTracePath()) {
                                const metrics = { 'origin': this.getId(), 'id': event.getTraceId(), 'path': event.getTracePath(),
                                    'service': event.getTo(), 'start': utc, 'success': true,
                                    'exec_time': response.getExecTime(), 'round_trip': diff };
                                if (event.getFrom()) {
                                    metrics['from'] = event.getFrom();
                                }
                                if (response.getStatus() >= 400) {
                                    metrics['success'] = false;
                                    metrics['status'] = response.getStatus();
                                    const error = response.getBody();
                                    if (typeof error == 'string') {
                                        metrics['exception'] = error;
                                    }
                                    else if (error instanceof Object) {
                                        if ('message' in error) {
                                            metrics['exception'] = error['message'];
                                        }
                                        else {
                                            metrics['exception'] = error;
                                        }
                                    }
                                    else {
                                        metrics['exception'] = error ? error : 'null';
                                    }
                                }
                                const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
                                this.send(trace);
                            }
                            resolve(response);
                        }
                    });
                    event.setReplyTo(callback);
                    event.addTag(RPC, String(timeout));
                    // serialize event envelope for immutability
                    emitter.emit(route, event.toBytes());
                }
                else {
                    reject(new AppException(404, `Event ${event.getId()} dropped because ${route} not found`));
                }
            }
            else {
                reject(new AppException(400, `Event ${event.getId()} dropped because there is no target service route`));
            }
        });
    }
    remoteRequest(event, endpoint, securityHeaders = {}, rpc = true, timeout = 60000) {
        return new Promise((resolve, reject) => {
            const bytes = event.toBytes();
            const req = new AsyncHttpRequest().setMethod('POST');
            req.setHeader('Content-Type', APPLICATION_OCTET_STREAM).setHeader('X-TTL', String(timeout)).setBody(bytes);
            let host;
            let path;
            try {
                const target = new URL(endpoint);
                let secure;
                const protocol = target.protocol;
                if ("http:" == protocol) {
                    secure = false;
                }
                else if ("https:" == protocol) {
                    secure = true;
                }
                else {
                    throw new Error('Protocol must be http or https');
                }
                host = (secure ? 'https://' : 'http://') + target.host;
                path = target.pathname;
            }
            catch (ex) {
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
                    }
                    catch (e) {
                        // response is not a packed EventEnvelope
                        resolve(new EventEnvelope().setStatus(400)
                            .setBody("Did you configure rest.yaml correctly? " +
                            "Invalid result set - " + e.getMessage()));
                    }
                }
                else {
                    if (result.getStatus() >= 400 && body && body.constructor == Object) {
                        const map = body;
                        if ('type' in map && 'error' == map['type'] && 'message' in map && typeof map['message'] == 'string') {
                            resolve(new EventEnvelope().setStatus(result.getStatus()).setBody(map['message']));
                        }
                        else {
                            resolve(result);
                        }
                    }
                    else {
                        resolve(result);
                    }
                }
            })
                .catch(e => {
                const status = e instanceof AppException ? e.getStatus() : 500;
                reject(new AppException(status, e.message));
            });
        });
    }
}
//# sourceMappingURL=post-office.js.map