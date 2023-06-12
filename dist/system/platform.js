import { performance } from 'perf_hooks';
import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { PostOffice } from '../system/post-office.js';
import { DistributedTrace } from '../services/tracer.js';
import { AsyncHttpClient } from '../services/async-http-client.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { AppConfig } from '../util/config-reader.js';
const log = new Logger();
const util = new Utility();
const po = new PostOffice();
const DISTRIBUTED_TRACING = 'distributed.tracing';
const SIGNATURE = "_";
const RPC = "rpc";
const OBJECT_STREAM_MANAGER = "object.stream.manager";
const REST_AUTOMATION_MANAGER = "rest.automation.manager";
let self = null;
let startTime;
let appName;
export class Platform {
    constructor(configFile) {
        if (self == null) {
            self = new EventSystem(configFile);
            startTime = new Date();
        }
    }
    static initialized() {
        return self != null;
    }
    /**
     * Retrieve unique application instance ID (i.e. "originId")
     *
     * @returns originId
     */
    getOriginId() {
        return self.getOriginId();
    }
    getName() {
        if (!appName) {
            const appConfig = self.getConfig();
            appName = appConfig.getProperty('application.name', 'untitled');
        }
        return appName;
    }
    getStartTime() {
        return startTime;
    }
    /**
     * Get application configuration
     *
     * @returns config reader
     */
    getConfig() {
        return self.getConfig();
    }
    /**
     * Register a function with a route name.
     *
     * Your function will be registered as PRIVATE unless you set isPrivate=false.
     * PUBLIC functions are reachable by a peer from the Event API Endpoint "/api/event".
     * PRIVATE functions are invisible outside the current application instance.
     * INTERCEPTOR functions' return values are ignored because they are designed to forward events themselves.
     *
     * Note that the listener should be ideally an asynchronous function or a function that returns a promise.
     * However, the system would accept regular function too.
     *
     * The 'void' return type in the listener is used in typescipt compile time only.
     * It is safe for the function to return value as a primitive value, JSON object, an EventEnvelope.
     *
     * Your function can throw an Error or an AppException.
     * With AppException, you can set status code and message.
     *
     * @param route name
     * @param listener function with EventEnvelope as input
     * @param isPrivate true or false
     * @param isInterceptor true or false
     * @param instances number of workers for this function
     */
    register(route, listener, isPrivate = true, instances = 1, isInterceptor = false) {
        self.register(route, listener, isPrivate, instances, isInterceptor);
    }
    /**
     * Release a previously registered function
     *
     * @param route name
     */
    release(route) {
        self.release(route);
    }
    /**
     * Check if a route is private
     *
     * @param route name of a function
     * @returns true if private and false if public
     * @throws Error(Route 'name' not found)
     */
    isPrivate(route) {
        return self.isPrivate(route);
    }
    /**
     * Stop the platform.
     * (REST automation and outstanding streams, if any, will be automatically stopped.)
     */
    async stop() {
        await self.stop();
    }
    /**
     * Check if the platform is shutting down
     *
     * @returns true or false
     */
    isStopping() {
        return self.isStopping();
    }
    /**
     * You can use this method to keep the event system running in the background
     */
    async runForever() {
        return self.runForever();
    }
}
class ServiceManager {
    route;
    isPrivate;
    isInterceptor;
    eventQueue = [];
    workers = [];
    signature;
    constructor(route, listener, isPrivate = false, instances = 1, interceptor = false) {
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
        this.isInterceptor = interceptor;
        const total = Math.max(1, instances);
        //
        // Worker event listeners
        // 
        for (let i = 1; i <= total; i++) {
            // Worker route name has a suffix of '#' and a worker instance number
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
        //
        // Service manager event listener for each named route
        //
        // It uses "setImmediate" method to execute the event delivery in the next event loop cycle.
        //
        // To guarantee strict message ordering, 
        // each worker sends a READY signal to the service manager before taking the next event.
        //
        po.subscribe(route, (evt) => {
            if (this.signature == evt.getHeader(SIGNATURE)) {
                const availableWorker = String(evt.getBody());
                if (this.workerNotExists(availableWorker)) {
                    this.workers.push(availableWorker);
                }
                const nextEvent = this.eventQueue.shift();
                if (nextEvent) {
                    const nextWorker = this.workers.shift();
                    setImmediate(() => {
                        po.send(nextEvent.setTo(nextWorker));
                    });
                }
            }
            else {
                const worker = this.workers.shift();
                if (worker) {
                    setImmediate(() => {
                        po.send(evt.setTo(worker));
                    });
                }
                else {
                    this.eventQueue.push(evt);
                }
            }
        }, false);
        const category = this.isPrivate ? 'PRIVATE' : 'PUBLIC';
        if (total == 1) {
            log.info(`${category} ${this.route} registered`);
        }
        else {
            log.info(`${category} ${this.route} registered with ${total} instances`);
        }
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
        if (replyTo && !this.isInterceptor) {
            if (this.route == replyTo) {
                log.error(`Response event dropped to avoid looping to ${replyTo}`);
            }
            else {
                if (po.exists(replyTo)) {
                    const result = response instanceof EventEnvelope ? new EventEnvelope(response) : new EventEnvelope().setBody(response);
                    result.setTo(replyTo).setReplyTo(null).setFrom(this.route);
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
        // send ready signal if the service is still active
        if (po.exists(this.route)) {
            po.send(new EventEnvelope().setTo(this.route).setBody(workerRoute).setHeader(SIGNATURE, this.signature));
        }
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
    config;
    services = new Map();
    forever = false;
    stopping = false;
    constructor(configFileOrMap) {
        this.config = new AppConfig(configFileOrMap).getReader();
        let levelInEnv = false;
        let reloaded = false;
        let reloadFile = null;
        let errorInReload = null;
        if (process) {
            if (process.env.LOG_LEVEL) {
                levelInEnv = true;
            }
            // reload configuration from a file given in command line argument "-C{filename}"
            const replaceConfig = process.argv.filter(k => k.startsWith('-C'));
            if (replaceConfig.length > 0) {
                reloadFile = replaceConfig[0].substring(2);
                try {
                    const map = util.loadYamlFile(reloadFile);
                    if (map.isEmpty()) {
                        errorInReload = `Configuration file ${reloadFile} is empty`;
                    }
                    else {
                        this.config.reload(map);
                        reloaded = true;
                    }
                }
                catch (e) {
                    errorInReload = e.message;
                }
            }
            // override application parameters from command line arguments
            const parameters = process.argv.filter(k => k.startsWith('-D') && k.substring(2).includes('='));
            for (let i = 0; i < parameters.length; i++) {
                const p = parameters[i].substring(2);
                const sep = p.indexOf('=');
                const k = p.substring(0, sep);
                const v = p.substring(sep + 1);
                if (k && v) {
                    this.config.set(k, v);
                }
            }
        }
        if (!levelInEnv) {
            log.setLevel(this.config.getProperty('log.level', 'info'));
        }
        log.setJsonFormat(this.config.getProperty('log.format', 'json') == 'json');
        if (reloaded) {
            log.info(`Configuration reloaded from ${reloadFile}`);
        }
        else if (errorInReload) {
            log.error(`Unable to load configuration from ${reloadFile} - ${errorInReload}`);
        }
        if (process) {
            // monitor shutdown signals
            process.on('SIGTERM', () => {
                if (self && !self.isStopping()) {
                    self.stop();
                    log.info('Kill signal detected');
                }
            });
            process.on('SIGINT', () => {
                if (self && !self.isStopping()) {
                    self.stop();
                    log.info('Control-C detected');
                }
            });
        }
        // Event system ready
        log.info(`Event system started - ${po.getId()}`);
        const tracer = new DistributedTrace();
        this.register(tracer.getName(), tracer.handleEvent, true, 1, true);
        const httpClient = new AsyncHttpClient();
        this.register(httpClient.getName(), httpClient.handleEvent, true, 200, true);
    }
    getOriginId() {
        return po.getId();
    }
    getConfig() {
        return this.config;
    }
    register(route, listener, isPrivate = true, instances = 1, interceptor = false) {
        if (route) {
            if (!util.validRouteName(route)) {
                throw new Error('Invalid route name - use 0-9, a-z, period, hyphen or underscore characters');
            }
            if (listener instanceof Function) {
                if (this.services.has(route)) {
                    log.warn(`Reloading ${route} service`);
                    this.release(route);
                }
                new ServiceManager(route, listener, isPrivate, instances, interceptor);
                this.services.set(route, { "private": isPrivate, "instances": instances, "interceptor": interceptor });
            }
            else {
                throw new Error('Invalid listener function');
            }
        }
        else {
            throw new Error('Missing route');
        }
    }
    release(route) {
        if (this.services.has(route)) {
            const metadata = this.services.get(route);
            const isPrivate = metadata['private'];
            const instances = parseInt(metadata['instances']);
            // silently unsubscribe the service manager and workers
            po.unsubscribe(route, false);
            for (let i = 1; i <= instances; i++) {
                po.unsubscribe(route + "#" + i, false);
            }
            this.services.delete(route);
            log.info((isPrivate ? 'PRIVATE ' : 'PUBLIC ') + route + ' released');
        }
    }
    isPrivate(route) {
        if (this.services.has(route)) {
            const metadata = this.services.get(route);
            return metadata['private'];
        }
        else {
            throw new Error(`Route ${route} not found`);
        }
    }
    async stop() {
        if (!this.stopping) {
            this.stopping = true;
            if (po.exists(REST_AUTOMATION_MANAGER)) {
                await po.request(new EventEnvelope().setTo(REST_AUTOMATION_MANAGER).setHeader('type', 'close'));
            }
            if (po.exists(OBJECT_STREAM_MANAGER)) {
                await po.request(new EventEnvelope().setTo(OBJECT_STREAM_MANAGER).setHeader('type', 'close'));
            }
            let t1 = Date.now();
            while (this.forever) {
                const now = Date.now();
                if (now - t1 > 5000) {
                    t1 = now;
                    log.info('Stopping...');
                }
                await util.sleep(500);
            }
        }
    }
    isStopping() {
        return this.stopping;
    }
    async runForever() {
        if (!this.forever) {
            this.forever = true;
            log.info('To stop application, press Control-C');
            let t1 = Date.now();
            while (!this.isStopping()) {
                const now = Date.now();
                if (now - t1 > 60000) {
                    t1 = now;
                    log.debug('Running...');
                }
                await util.sleep(500);
            }
            log.info('Stopped');
            this.forever = false;
        }
    }
}
//# sourceMappingURL=platform.js.map