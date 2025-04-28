import { performance } from 'perf_hooks';
import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { FunctionRegistry } from "./function-registry.js";
import { PostOffice } from '../system/post-office.js';
import { RestAutomation } from '../system/rest-automation.js';
import { DistributedTrace } from '../services/tracer.js';
import { AsyncHttpClient } from '../services/async-http-client.js';
import { ActuatorServices } from '../services/actuator.js';
import { EventApiService } from '../services/event-api.js';
import { TemporaryInbox } from '../services/temporary-inbox.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { AppConfig, ConfigReader } from '../util/config-reader.js';
import { ContentTypeResolver } from '../util/content-type-resolver.js';
import { EventHttpResolver } from '../util/event-http-resolver.js';
import fs from 'fs';
const log = Logger.getInstance();
const registry = FunctionRegistry.getInstance();
const util = new Utility();
const po = new PostOffice();
const emitter = po.getEventEmitter();
const handlers = po.getHandlers();
const SIGNATURE = util.getUuid() + '/';
const DISTRIBUTED_TRACING = 'distributed.tracing';
const RPC = "rpc";
const OBJECT_STREAM_MANAGER = "object.stream.manager";
const REST_AUTOMATION_HOUSEKEEPER = "rest.automation.housekeeper";
const TEMP_DIR = "/tmp/composable/node/temp-streams";
let startTime;
let appName;
let self;
function subscribe(route, listener) {
    const hasRoute = route ? true : false;
    if (!hasRoute) {
        throw new Error('Missing route');
    }
    const hash = route.indexOf('#');
    const name = hash == -1 ? route : route.substring(0, hash);
    const worker = hash == -1 ? null : route.substring(hash + 1);
    if (!util.validRouteName(name)) {
        throw new Error('Invalid route name - use 0-9, a-z, period, hyphen or underscore characters');
    }
    if (worker != null && (worker.length == 0 || !util.isDigits(worker))) {
        throw new Error('Invalid route worker suffix');
    }
    const hasListener = listener ? true : false;
    if (!hasListener) {
        throw new Error('Missing listener');
    }
    if (!(listener instanceof Function)) {
        throw new Error('Invalid listener function');
    }
    if (handlers.has(route)) {
        unsubscribe(route);
    }
    handlers.set(route, listener);
    emitter.on(route, listener);
    log.debug(`${route} registered`);
}
function unsubscribe(route) {
    if (handlers.has(route)) {
        const service = handlers.get(route);
        emitter.removeListener(route, service);
        handlers.delete(route);
        log.debug(`${route} unregistered`);
    }
}
async function checkExpiredStreams() {
    if (util.isDirectory(TEMP_DIR)) {
        const thirtyMinutes = 30 * 60 * 1000;
        const now = new Date().getTime();
        const files = await fs.promises.readdir(TEMP_DIR);
        for (const f of files) {
            const path = `${TEMP_DIR}/${f}`;
            try {
                const stats = await fs.promises.stat(path);
                const diff = now - stats.mtime.getTime();
                if (diff > thirtyMinutes) {
                    await fs.promises.unlink(path);
                    log.info(`Expired ${path} deleted`);
                }
            }
            catch (e) {
                log.warn(`Unable to check expired streams - ${e.message}`);
            }
        }
    }
}
function ready() {
    log.info('To stop application, press Control-C');
}
export class Platform {
    static singleton;
    constructor() {
        if (startTime === undefined) {
            startTime = new Date();
            self = new EventSystem();
        }
    }
    /**
     * Obtain the singleton instance of Platform
     *
     * @returns instance
     */
    static getInstance() {
        if (Platform.singleton === undefined) {
            Platform.singleton = new Platform();
        }
        return Platform.singleton;
    }
    /**
     * Retrieve unique application instance ID (i.e. "originId")
     *
     * @returns originId
     */
    getOriginId() {
        return self.getOriginId();
    }
    /**
     * Retrieve application name
     *
     * @returns application name
     */
    getName() {
        if (appName === undefined) {
            const config = AppConfig.getInstance();
            appName = config.getProperty('application.name', 'untitled');
        }
        return appName;
    }
    /**
     * Retrieve the system's start time
     *
     * @returns start time
     */
    getStartTime() {
        return startTime;
    }
    /**
     * Wait for the platform system to load essential services
     *
     * @returns true
     */
    async getReady() {
        // check if essential services are loaded
        let t1 = new Date().getTime();
        while (!po.exists(TemporaryInbox.routeName)) {
            await util.sleep(1);
            // The platform should be ready very quickly.
            // If there is something that blocks it from starting up,
            // this would print alert every two seconds.
            const now = new Date().getTime();
            if (now - t1 >= 2000) {
                t1 = now;
                log.warn('Waiting for platform to get ready');
            }
        }
        return true;
    }
    /**
     * Register a composable class with a route name.
     *
     * Your composable function will be registered as PRIVATE unless you set isPrivate=false.
     * PUBLIC function is reachable by a peer from the Event API Endpoint "/api/event".
     * PRIVATE function is invisible outside the current application instance.
     * INTERCEPTOR function's return value is ignored because it is designed to forward events.
     *
     * Note that the class must implement the Composable interface
     * and the handleEvent function should be an asynchronous function or a function that returns a promise.
     *
     * The handleEvent function can throw an Error or an AppException.
     * With AppException, you can set status code and message.
     *
     * @param route name
     * @param composable class implementing the initialize and handleEvent methods
     * @param instances number of workers for this function
     * @param isPrivate true or false
     * @param interceptor true or false
     */
    register(route, composable, instances = 1, isPrivate = true, interceptor = false) {
        self.register(route, composable, instances, isPrivate, interceptor);
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
    interceptor;
    eventQueue = [];
    workers = [];
    constructor(route, listener, instances = 1, isPrivate = false, interceptor = false) {
        const hasRoute = route ? true : false;
        const hasListener = listener ? true : false;
        if (!hasRoute) {
            throw new Error('Missing route');
        }
        if (!hasListener) {
            throw new Error('Missing listener');
        }
        if (!(listener instanceof Function)) {
            throw new Error('Invalid listener function');
        }
        this.route = route;
        this.isPrivate = isPrivate;
        this.interceptor = interceptor;
        const total = Math.max(1, instances);
        //
        // Worker event listeners
        // 
        for (let i = 1; i <= total; i++) {
            // Worker route name has a suffix of '#' and a worker instance number
            const workerRoute = route + "#" + i;
            const myInstance = String(i);
            this.workers.push(workerRoute);
            subscribe(workerRoute, (evt) => {
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
                // filter out annotation except for temporary inbox
                if ('temporary.inbox' != route) {
                    evt.clearAnnotations();
                }
                const result = listener(evt);
                // The listener must implement Composable interface.
                // Anything else will be ignored.
                if (result && Object(result).constructor == Promise) {
                    result.then(v => this.handleResult(workerRoute, utc, start, evt, v))
                        .catch(e => this.handleError(workerRoute, utc, evt, e));
                }
            });
        }
        //
        // Service manager event listener for each named route
        //
        // It uses "setImmediate" method to execute the event delivery in the next event loop cycle.
        //
        // To guarantee strict message ordering, 
        // each worker sends a READY signal to the service manager before taking the next event.
        //
        subscribe(route, (payload) => {
            if (typeof payload == 'string') {
                // validate unique signature for worker routing
                if (payload.startsWith(SIGNATURE)) {
                    const availableWorker = payload.substring(SIGNATURE.length);
                    if (this.workerNotExists(availableWorker)) {
                        this.workers.push(availableWorker);
                    }
                    const nextEvent = this.eventQueue.shift();
                    if (nextEvent) {
                        const nextWorker = this.workers.shift();
                        setImmediate(() => {
                            const event = new EventEnvelope(nextEvent);
                            emitter.emit(nextWorker, event);
                        });
                    }
                }
            }
            else if (payload instanceof Buffer) {
                const event = new EventEnvelope(payload);
                const worker = this.workers.shift();
                if (worker) {
                    setImmediate(() => {
                        emitter.emit(worker, event);
                    });
                }
                else {
                    this.eventQueue.push(payload);
                }
            }
        });
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
        if (replyTo && !this.interceptor) {
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
                    result.setTags(evt.getTags());
                    if ('temporary.inbox' == replyTo) {
                        result.setAnnotations(evt.getAnnotations());
                    }
                    else {
                        result.clearAnnotations();
                    }
                    po.send(result);
                }
                else {
                    // unable to deliver response
                    if (evt.getTraceId() && evt.getTracePath()) {
                        const metrics = { 'origin': self.getOriginId(), 'id': evt.getTraceId(), 'path': evt.getTracePath(),
                            'service': this.route, 'start': utc, 'success': false, 'exec_time': diff,
                            'status': 500, 'exception': 'Response not delivered - Route ' + replyTo + ' not found' };
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
        const isRequestResponse = evt.getTag(RPC) ? true : false;
        if (!traced && !isRequestResponse && evt.getTraceId() && evt.getTracePath()) {
            const metrics = { 'origin': self.getOriginId(), 'id': evt.getTraceId(), 'path': evt.getTracePath(),
                'service': this.route, 'start': utc, 'success': true, 'exec_time': diff };
            if (evt.getFrom()) {
                metrics['from'] = evt.getFrom();
            }
            const annotations = evt.getAnnotations();
            if (Object.keys(annotations).length > 0) {
                metrics['annotations'] = annotations;
            }
            if (evt.getStatus() >= 400) {
                metrics['success'] = false;
                metrics['status'] = evt.getStatus();
                metrics['exception'] = evt.getError();
            }
            const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
            po.send(trace);
        }
        // send ready signal
        if (po.exists(this.route)) {
            emitter.emit(this.route, SIGNATURE + workerRoute);
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
                    result.setTags(evt.getTags());
                    if (e instanceof AppException) {
                        errorCode = e.getStatus();
                    }
                    po.send(result.setException(e));
                }
                else {
                    // unable to deliver response
                    if (evt.getTraceId() && evt.getTracePath()) {
                        const metrics = { 'origin': self.getOriginId(), 'id': evt.getTraceId(), 'path': evt.getTracePath(),
                            'status': 500, 'service': this.route, 'start': utc, 'success': false,
                            'exception': 'Response not delivered - Route ' + replyTo + ' not found' };
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
        if (po.exists(this.route)) {
            emitter.emit(this.route, SIGNATURE + workerRoute);
        }
    }
}
class EventSystem {
    static instance;
    forever = false;
    stopping = false;
    constructor() {
        if (EventSystem.instance === undefined) {
            EventSystem.instance = this;
            log.info(`Starting event system - id: ${po.getId()}`);
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
            this.start();
        }
    }
    start() {
        setImmediate(() => {
            const config = AppConfig.getInstance();
            // load event-over-http.yaml if present
            const yamlFile = config.getProperty('yaml.event.over.http');
            if (yamlFile) {
                EventHttpResolver.getInstance().loadHttpRoutes(yamlFile, new ConfigReader(yamlFile));
            }
            // load custom-content-type.yaml if present
            const ctFile = config.getProperty('yaml.custom.content.types');
            if (ctFile) {
                ContentTypeResolver.getInstance().loadCustomContentTypes(new ConfigReader(ctFile));
            }
            // load essential services
            const actuator = new ActuatorServices();
            this.register(ActuatorServices.infoService, actuator, 10);
            this.register(ActuatorServices.routeService, actuator, 10);
            this.register(ActuatorServices.healthService, actuator, 10);
            this.register(ActuatorServices.livenessService, actuator, 10);
            this.register(ActuatorServices.envService, actuator, 10);
            this.register(DistributedTrace.routeName, new DistributedTrace(), 1, true, true);
            this.register(AsyncHttpClient.routeName, new AsyncHttpClient(), 200, true, true);
            this.register(EventApiService.routeName, new EventApiService(), 200);
            this.register(TemporaryInbox.routeName, new TemporaryInbox(), 200, true, true);
            const diff = new Date().getTime() - startTime.getTime();
            log.info(`Event system started in ${diff} ms`);
        });
    }
    getOriginId() {
        return po.getId();
    }
    register(route, composable, instances = 1, isPrivate = true, interceptor = false) {
        if (route && util.validRouteName(route)) {
            if (registry.isLoaded(route)) {
                log.warn(`Reloading ${route} service`);
                this.release(route);
            }
            if ('initialize' in composable && 'handleEvent' in composable &&
                composable.initialize instanceof Function && composable.handleEvent instanceof Function) {
                if (!registry.exists(route)) {
                    registry.save(route, composable, instances, isPrivate, interceptor);
                    composable.initialize();
                }
                new ServiceManager(route, composable.handleEvent, instances, isPrivate, interceptor);
                registry.load(route);
            }
            else {
                throw new Error(`Unable to register ${route} because the given function is not a Composable`);
            }
        }
        else {
            throw new Error('Check route name - use 0-9, a-z, period, hyphen or underscore characters');
        }
    }
    release(route) {
        if (registry.exists(route)) {
            const metadata = registry.getMetadata(route);
            const isPrivate = metadata['private'];
            const instances = metadata['instances'];
            // silently unsubscribe the service manager and workers
            unsubscribe(route);
            for (let i = 1; i <= instances; i++) {
                unsubscribe(route + "#" + i);
            }
            registry.remove(route);
            log.info((isPrivate ? 'PRIVATE ' : 'PUBLIC ') + route + ' released');
        }
    }
    isPrivate(route) {
        if (registry.exists(route)) {
            const metadata = registry.getMetadata(route);
            return metadata['private'];
        }
        else {
            return true;
        }
    }
    async stop() {
        if (!this.stopping) {
            this.stopping = true;
            if (po.exists(REST_AUTOMATION_HOUSEKEEPER)) {
                await po.request(new EventEnvelope().setTo(REST_AUTOMATION_HOUSEKEEPER).setHeader('type', 'close'));
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
            await Platform.getInstance().getReady();
            ready();
            const config = AppConfig.getInstance();
            if ('true' == config.getProperty('rest.automation')) {
                await RestAutomation.getInstance().getReady();
            }
            let t1 = Date.now();
            while (!this.isStopping()) {
                const now = Date.now();
                // clean up expired streams if any
                if (now - t1 > 60000) {
                    t1 = now;
                    checkExpiredStreams();
                }
                await util.sleep(500);
            }
            log.info('Stopped');
            this.forever = false;
        }
    }
}
//# sourceMappingURL=platform.js.map