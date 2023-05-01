import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { PO } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { MultiLevelMap } from '../util/multi-level-map.js';
const log = new Logger().getInstance();
const util = new Utility().getInstance();
const po = new PO().getInstance({});
const SERVICE_LIFE_CYCLE = 'service.life.cycle';
const DISTRIBUTED_TRACING = 'distributed.tracing';
const DISTRIBUTED_TRACE_FORWARDER = 'distributed.trace.forwarder';
const SIGNATURE = "_";
const RPC = "rpc";
let self = null;
export class Platform {
    constructor(configFile) {
        if (self == null) {
            self = new EventSystem(configFile);
        }
    }
    getInstance() {
        return self;
    }
}
function getResourceFolder() {
    const filename = import.meta.url.substring(7);
    const parts = filename.split('/');
    const scriptName = parts.length > 2 && parts[1].endsWith(':') ? filename.substring(1) : filename;
    return dropLast(dropLast(scriptName)) + '/resources';
}
function dropLast(pathname) {
    return pathname.includes('/') ? pathname.substring(0, pathname.lastIndexOf('/')) : pathname;
}
class ServiceManager {
    constructor(route, listener, isPrivate = false, instances = 1) {
        this.eventQueue = [];
        this.workers = [];
        if (!route) {
            throw new Error('Missing route');
        }
        if (!listener) {
            throw new Error('Missing listener');
        }
        if (!(listener instanceof Function)) {
            throw new Error('Invalid listener function');
        }
        this.signature = util.getUuid();
        this.route = route;
        this.isPrivate = isPrivate;
        const total = Math.max(1, instances);
        for (let i = 1; i <= total; i++) {
            const workerRoute = route + "#" + i;
            const myInstance = String(i);
            this.workers.push(workerRoute);
            po.subscribe(workerRoute, (evt) => {
                evt.setTo(route);
                evt.setHeader('my_route', route);
                evt.setHeader('my_instance', myInstance);
                if (evt.getTraceId() != null) {
                    evt.setHeader('my_trace_id', evt.getTraceId());
                }
                if (evt.getTracePath() != null) {
                    evt.setHeader('my_trace_path', evt.getTracePath());
                }
                const utc = new Date().toISOString();
                const start = performance.now();
                try {
                    const result = listener(evt);
                    if (result && Object(result).constructor == Promise) {
                        result.then(v => this.handleResult(workerRoute, utc, start, evt, v)).catch(e => this.handleError(workerRoute, utc, evt, e));
                    }
                    else {
                        this.handleResult(workerRoute, utc, start, evt, result);
                    }
                }
                catch (e) {
                    this.handleError(workerRoute, utc, evt, e);
                }
            }, false);
        }
        po.subscribe(route, (evt) => {
            if (this.signature == evt.getHeader(SIGNATURE)) {
                const availableWorker = String(evt.getBody());
                if (this.workerNotExists(availableWorker)) {
                    this.workers.push(availableWorker);
                }
                const nextEvent = this.eventQueue.shift();
                if (nextEvent) {
                    const nextWorker = this.workers.shift();
                    po.send(nextEvent.setTo(nextWorker));
                }
            }
            else {
                const worker = this.workers.shift();
                if (worker) {
                    po.send(evt.setTo(worker));
                }
                else {
                    this.eventQueue.push(evt);
                }
            }
        }, false);
        log.info((this.isPrivate ? 'PRIVATE ' : 'PUBLIC ') + this.route + ' registered');
    }
    workerNotExists(w) {
        for (const k in this.workers) {
            if (this.workers[k] == w) {
                return false;
            }
        }
        return true;
    }
    handleResult(workerRoute, utc, start, evt, response) {
        let traced = false;
        const diff = parseFloat((performance.now() - start).toFixed(3));
        const replyTo = evt.getReplyTo();
        if (replyTo) {
            if (this.route == replyTo) {
                log.error(`Response event dropped to avoid looping to ${replyTo}`);
            }
            else {
                if (po.exists(replyTo)) {
                    const result = response instanceof EventEnvelope ? new EventEnvelope(response) : new EventEnvelope().setBody(response);
                    result.setTo(replyTo).setFrom(this.route);
                    result.setExecTime(diff);
                    if (evt.getCorrelationId()) {
                        result.setCorrelationId(evt.getCorrelationId());
                    }
                    if (evt.getTraceId() && evt.getTracePath()) {
                        result.setTraceId(evt.getTraceId()).setTracePath(evt.getTracePath());
                    }
                    if (evt.getExtra()) {
                        result.setExtra(evt.getExtra());
                    }
                    po.send(result);
                }
                else {
                    // unable to deliver response
                    if (evt.getTraceId() && evt.getTracePath()) {
                        const metrics = { 'origin': self.getOriginId(), 'id': evt.getTraceId(), 'path': evt.getTracePath(),
                            'service': this.route, 'start': utc, 'success': true, 'exec_time': diff,
                            'remark': 'Response not delivered - Route ' + replyTo + ' not found' };
                        if (evt.getFrom()) {
                            metrics['from'] = evt.getFrom();
                        }
                        const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
                        po.send(trace);
                        traced = true;
                    }
                    else {
                        const from = evt.getFrom() ? evt.getFrom() : "unknown";
                        log.error(`Delivery error - Reply route ${replyTo} not found, from=${from}, to=${this.route}, type=response, exec_time=${diff}`);
                    }
                }
            }
        }
        // send tracing information if needed
        const tag = evt.getTag(RPC);
        if (!traced && tag == null && evt.getTraceId() && evt.getTracePath()) {
            const metrics = { 'origin': self.getOriginId(), 'id': evt.getTraceId(), 'path': evt.getTracePath(),
                'service': this.route, 'start': utc, 'success': true, 'exec_time': diff };
            if (evt.getFrom()) {
                metrics['from'] = evt.getFrom();
            }
            const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
            po.send(trace);
        }
        // send ready signal
        po.send(new EventEnvelope().setTo(this.route).setBody(workerRoute).setHeader(SIGNATURE, this.signature));
    }
    handleError(workerRoute, utc, evt, e) {
        let errorCode = 500;
        let traced = false;
        const replyTo = evt.getReplyTo();
        if (replyTo) {
            if (this.route == replyTo) {
                log.error(`Exception event dropped to avoid looping to ${replyTo}`);
            }
            else {
                if (po.exists(replyTo)) {
                    const result = new EventEnvelope().setTo(replyTo).setFrom(this.route);
                    if (evt.getCorrelationId()) {
                        result.setCorrelationId(evt.getCorrelationId());
                    }
                    if (evt.getTraceId() && evt.getTracePath()) {
                        result.setTraceId(evt.getTraceId()).setTracePath(evt.getTracePath());
                    }
                    if (evt.getExtra()) {
                        result.setExtra(evt.getExtra());
                    }
                    if (e instanceof AppException) {
                        errorCode = e.getStatus();
                        result.setStatus(errorCode).setBody(e.message).setException(true);
                    }
                    else if (e instanceof Error) {
                        errorCode = 500;
                        result.setStatus(errorCode).setBody(e.message).setException(true);
                    }
                    else {
                        errorCode = 400;
                        result.setStatus(errorCode).setBody(String(e)).setException(true);
                    }
                    po.send(result);
                }
                else {
                    // unable to deliver response
                    if (evt.getTraceId() && evt.getTracePath()) {
                        const metrics = { 'origin': self.getOriginId(), 'id': evt.getTraceId(), 'path': evt.getTracePath(),
                            'status': errorCode, 'exception': e.message,
                            'service': this.route, 'start': utc, 'success': false,
                            'remark': 'Response not delivered - Route ' + replyTo + ' not found' };
                        if (evt.getFrom()) {
                            metrics['from'] = evt.getFrom();
                        }
                        const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
                        po.send(trace);
                        traced = true;
                    }
                    else {
                        const from = evt.getFrom() ? evt.getFrom() : "unknown";
                        log.error(`Delivery error - Reply route ${replyTo} not found, from=${from}, to=${this.route}, type=exception_response, status=${errorCode}, exception=${e.message}`);
                    }
                }
            }
        }
        else {
            if (e instanceof AppException) {
                errorCode = e.getStatus();
                log.warn(`Unhandled exception (${evt.getTo()}), status=${errorCode}`, e);
            }
            else {
                errorCode = 500;
                log.warn(`Unhandled exception (${evt.getTo()})`, e);
            }
        }
        // send tracing information if needed
        if (!traced && evt.getTraceId() && evt.getTracePath()) {
            const metrics = { 'origin': self.getOriginId(), 'id': evt.getTraceId(), 'path': evt.getTracePath(),
                'service': this.route, 'start': utc, 'success': false,
                'status': errorCode, 'exception': e.message };
            if (evt.getFrom()) {
                metrics['from'] = evt.getFrom();
            }
            const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
            po.send(trace);
        }
        // send ready signal
        po.send(new EventEnvelope().setTo(this.route).setBody(workerRoute).setHeader(SIGNATURE, this.signature));
    }
}
class EventSystem {
    constructor(configFile) {
        this.services = new Map();
        this.forever = false;
        this.stopping = false;
        this.t1 = -1;
        self = this;
        const filepath = configFile ? configFile : getResourceFolder() + '/application.yml';
        self.config = new MultiLevelMap(parseYaml(readFileSync(filepath, { encoding: 'utf-8', flag: 'r' }))).normalizeMap();
        const level = process.env.LOG_LEVEL;
        if (!(level && log.validLevel(level))) {
            log.setLevel(self.config.getElement('log.level', 'info'));
        }
        po.subscribe(SERVICE_LIFE_CYCLE, (evt) => {
            if ('unsubscribe' == evt.getHeader('type')) {
                const route = evt.getHeader('route');
                if (route && self.services.has(route)) {
                    const metadata = self.services.get(route);
                    const isPrivate = metadata['private'];
                    const instances = parseInt(metadata['instances']);
                    for (let i = 1; i <= instances; i++) {
                        // silently unsubscribe the workers for the service
                        po.unsubscribe(route + "#" + i, false);
                    }
                    self.services.delete(route);
                    log.info((isPrivate ? 'PRIVATE ' : 'PUBLIC ') + route + ' released');
                }
            }
        });
        po.subscribe(DISTRIBUTED_TRACING, (evt) => {
            if (evt.getBody() instanceof Object) {
                const payload = evt.getBody();
                if (payload && 'trace' in payload) {
                    const metrics = payload['trace'];
                    const routeName = metrics['service'];
                    // ignore tracing for "distributed.tracing" and "distributed.trace.forwarder"
                    if (DISTRIBUTED_TRACING != routeName && DISTRIBUTED_TRACE_FORWARDER != routeName) {
                        log.info(evt.getBody());
                        if (po.exists(DISTRIBUTED_TRACE_FORWARDER)) {
                            const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACE_FORWARDER).setBody(payload);
                            po.send(trace);
                        }
                    }
                }
            }
        });
        // monitor shutdown signals
        process.on('SIGTERM', () => {
            if (!self.stopping) {
                self.stopping = true;
                log.info('Kill signal detected');
            }
        });
        process.on('SIGINT', () => {
            if (!self.stopping) {
                self.stopping = true;
                log.info('Control-C detected');
            }
        });
    }
    /**
     * Retrieve unique application instance ID (aka originId)
     *
     * @returns originId
     */
    getOriginId() {
        return po.getId();
    }
    /**
     * Get application.yml
     *
     * @returns multi-level-map
     */
    getConfig() {
        return self.config;
    }
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
    register(route, listener, isPrivate = false, instances = 1) {
        if (route) {
            if (listener instanceof Function) {
                new ServiceManager(route, listener, isPrivate, instances);
                self.services.set(route, { "private": isPrivate, "instances": instances });
            }
            else {
                throw new Error('Invalid listener function');
            }
        }
        else {
            throw new Error('Missing route');
        }
    }
    /**
     * Release a previously registered function
     *
     * @param route name
     */
    release(route) {
        if (self.services.has(route)) {
            po.unsubscribe(route, false);
        }
    }
    /**
     * You can use this method to keep the event system running in the background
     */
    async runForever() {
        if (!self.forever) {
            // guarantee execute once
            self.forever = true;
            if (self.t1 < 0) {
                self.t1 = Date.now();
                log.info('To stop application, press Control-C');
            }
            while (!self.isStopping()) {
                const now = Date.now();
                if (now - self.t1 > 60000) {
                    self.t1 = now;
                    log.debug('Running...');
                }
                await util.sleep(250);
            }
            log.info('Stopped');
        }
    }
    /**
     * Stop the platform and cloud connector
     */
    stop() {
        self.stopping = true;
    }
    /**
     * Check if the platform is shutting down
     *
     * @returns true or false
     */
    isStopping() {
        return self.stopping;
    }
}
//# sourceMappingURL=platform.js.map