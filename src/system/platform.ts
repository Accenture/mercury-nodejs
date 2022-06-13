import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { Logger } from "../util/logger.js";
import { Utility } from '../util/utility.js';
import { PO } from "../system/post-office.js";
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { MultiLevelMap } from '../util/multi-level-map.js';

const log = new Logger().getInstance();
const util = new Utility().getInstance();
const po = new PO().getInstance();
const WS_WORKER = 'ws.worker';
const SERVICE_LIFE_CYCLE = 'service.life.cycle';
const DISTRIBUTED_TRACING = 'distributed.tracing';
const DISTRIBUTED_TRACE_PROCESSOR = 'distributed.trace.processor';

let self: EventSystem = null;
let lastTraceProcessorCheck = 0;
let traceProcessorFound = false;

export class Platform {

    constructor() {
        if (self == null) {
            self = new EventSystem();
        }
    }
  
    getInstance(): EventSystem {
        return self;
    }
}

function getResourceFolder() {
    const filename = import.meta.url.substring(7);
    const parts = filename.split('/');
    const scriptName = parts.length > 2 && parts[1].endsWith(':')? filename.substring(1) : filename;
    return dropLast(dropLast(scriptName)) + "/resources";
}

function dropLast(pathname: string) {
    return pathname.includes('/')? pathname.substring(0, pathname.lastIndexOf('/')) : pathname;
}

function isTraceProcessorAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        const now = Date.now();
        if (now - lastTraceProcessorCheck > 5000) {
            lastTraceProcessorCheck = now;
            po.exists(DISTRIBUTED_TRACE_PROCESSOR).then((found: boolean) => {
                traceProcessorFound = found;
                resolve(found);
            }).catch((e) => {
                log.error('Unable to check '+DISTRIBUTED_TRACE_PROCESSOR+' - '+e.message);
                resolve(false);
            });
        } else {
            resolve(traceProcessorFound);
        }
    });
}

// Graceful shutdown
async function shutdown() {
    if (await po.exists(WS_WORKER)) {
        log.info("Stopping");
        po.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'stop'));
    }   
}

class ServiceManager {

    private route: string;
    private isPrivate: boolean;

    constructor(route: string, listener, isPrivate = false) {
        if (!route) {
            throw new Error('Missing route');
        }
        if (!listener) {
            throw new Error('Missing listener');
        }
        if (!(listener instanceof Function)) {
            throw new Error('Invalid listener function');
        }
        this.route = route;
        this.isPrivate = isPrivate;
        po.subscribe(route, (evt: EventEnvelope) => {
            const utc = new Date().toISOString();
            const start = performance.now();
            try {
                const result = listener(evt);
                if (result && Object(result).constructor == Promise) {
                    result.then(v => this.handleResult(utc, start, evt, v)).catch(e => this.handleError(utc, evt, e));
                } else {
                    this.handleResult(utc, start, evt, result);
                }
            } catch (e) {
                this.handleError(utc, evt, e);
            }
        }, false);
        log.info((this.isPrivate? 'PRIVATE ' : 'PUBLIC ') + this.route + ' registered');
    }

    handleResult(utc: string, start: number, evt: EventEnvelope, response): void {
        const diff = (performance.now() - start).toFixed(3);
        const replyTo = evt.getReplyTo();
        if (replyTo) {
            const result = response instanceof EventEnvelope? new EventEnvelope(response) : new EventEnvelope().setBody(response);
            result.setTo(replyTo).setFrom(this.route);
            result.setExecTime(parseFloat(diff));
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
        // send tracing information if needed
        if (evt.getTraceId() && evt.getTracePath()) {
            const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING);
            trace.setHeader('origin', self.getOriginId());
            trace.setHeader('id', evt.getTraceId()).setHeader('path', evt.getTracePath());
            trace.setHeader('service', this.route).setHeader('start', utc);
            if (evt.getFrom()) {
                trace.setHeader('from', evt.getFrom());
            }
            trace.setHeader('success', 'true');
            trace.setHeader('exec_time', diff);
            po.send(trace);
        }
    }

    handleError(utc: string, evt: EventEnvelope, e): void {
        let errorCode = 500;
        const replyTo = evt.getReplyTo();
        if (replyTo) {
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
            } else if (e instanceof Error) {
                errorCode = 500;
                result.setStatus(errorCode).setBody(e.message).setException(true);
            } else {
                errorCode = 400;
                result.setStatus(errorCode).setBody(String(e)).setException(true);
            }
            po.send(result);
        } else {
            if (e instanceof AppException) {
                errorCode = e.getStatus();
                log.warn('Unhandled exception ('+evt.getTo()+'), status='+errorCode, e);
            } else {
                errorCode = 500;
                log.warn('Unhandled exception ('+evt.getTo()+')', e);
            }
        }
        // send tracing information if needed
        if (evt.getTraceId() && evt.getTracePath()) {
            const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING);
            trace.setHeader('origin', self.getOriginId());
            trace.setHeader('id', evt.getTraceId()).setHeader('path', evt.getTracePath());
            trace.setHeader('service', this.route).setHeader('start', utc);
            if (evt.getFrom()) {
                trace.setHeader('from', evt.getFrom());
            }
            trace.setHeader('success', 'false');
            trace.setHeader('status', String(errorCode));
            trace.setHeader('exception', e.messaage);
            po.send(trace);
        }
    }
}

class EventSystem {

    private config: MultiLevelMap;
    private services = new Map<string, boolean>();
    private forever = false;
    private tracing = true;
    private stopping = false;
    private t1 = -1;

    constructor(configFile?: string) {
        self = this;
        const filepath = configFile? configFile : getResourceFolder() + '/application.yml';
        self.config = new MultiLevelMap(parseYaml(readFileSync(filepath, {encoding:'utf-8', flag:'r'}))).normalizeMap();
        const level = process.env.LOG_LEVEL;
        if (!(level && log.validLevel(level))) {
            log.setLevel(self.config.getElement('log.level', 'info'));
        }
        // 
        // Using 'po.subscribe' instead of 'platform.register' to make this an unmanaged event listener.
        // this effectively disables distributed tracing for these listeners.
        //
        po.subscribe(SERVICE_LIFE_CYCLE, (evt: EventEnvelope) => {
            if ('unsubscribe' == evt.getHeader('type')) {
                const route = evt.getHeader('route');
                if (route && self.services.has(route)) {
                    const isPrivate = self.services.get(route);
                    self.services.delete(route);
                    log.info((isPrivate? 'PRIVATE ' : 'PUBLIC ') + route + ' released');
                }
            }
        });
        po.subscribe(DISTRIBUTED_TRACING, (evt: EventEnvelope) => {
            log.info('trace=' + JSON.stringify(evt.getHeaders()));
            if (self.isTraceSupported()) {
                // handle the trace metrics delivery asynchronously
                isTraceProcessorAvailable().then((found) => {
                    if (found) {
                        // body is an empty map because annotations and journaling features are not supported
                        const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACE_PROCESSOR).setBody({});
                        const metrics = evt.getHeaders();
                        for (const k of Object.keys(metrics)) {
                            const v = metrics[k];
                            trace.setHeader(k, v);
                        }
                        po.send(trace);
                    }
                });
            }
        });
        // monitor shutdown signals
        process.on('SIGTERM', () => {
            if (!self.stopping) {
                self.stopping = true;
                log.info('Kill signal detected');
            }
            shutdown();
        });
        process.on('SIGINT', () => {
            if (!self.stopping) {
                self.stopping = true;
                log.info('Control-C detected');
            }
            shutdown();
        });
    }

    /**
     * Retrieve unique application instance ID (aka originId)
     * 
     * @returns originId
     */
    getOriginId(): string {
        return po.getId();
    }

    /**
     * Get application.yml
     * 
     * @returns multi-level-map
     */
    getConfig(): MultiLevelMap {
        return self.config;
    }

    /**
     * Check if trace aggregation feature is turned on
     * 
     * @returns true or false
     */
    isTraceSupported(): boolean {
        return self.tracing;
    }

    /**
     * Turn trace aggregation feature on or off. 
     * (This method is reserved for system use. DO NOT use this method from your app)
     * 
     * @param enabled is true or false
     */
    setTraceSupport(enabled = true): void {
        self.tracing = enabled? true: false;
        log.info('Trace aggregation is '+ (self.tracing? 'ON' : 'OFF'));
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
    register(route: string, listener: (evt: EventEnvelope) => void, isPrivate = false): void {
        if (route) {
            if (listener instanceof Function) {
                new ServiceManager(route, listener, isPrivate);
                self.services.set(route, isPrivate);
                if (!isPrivate && po.isCloudAuthenticated()) {
                    po.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'add').setHeader('route', route));
                }
            } else {
                throw new Error('Invalid listener function');
            }
        } else {
            throw new Error('Missing route');
        }
    }

    /**
     * Release a previously registered function
     * 
     * @param route name
     */
    release(route: string) {
        if (self.services.has(route)) {
            const isPrivate = self.services.get(route);
            po.unsubscribe(route, false);
            if (!isPrivate && po.isCloudAuthenticated()) {
                po.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'remove').setHeader('route', route));
            }
        }
    }

    /**
     * Advertise public routes to the cloud.
     * This method is reserved by the system. DO NOT call it directly from your app.
     */
    advertise(): void {
        for (const route of self.services.keys()) {
            const isPrivate = self.services.get(route);
            if (!isPrivate && po.isCloudAuthenticated()) {
                po.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'add').setHeader('route', route));
            }
        }
    }

    /**
     * When your application uses the cloud connector, your app can run in the background.
     * If you run your app in standalone mode, you can use this runForever method to keep it running in the background.
     */
    async runForever() {
        if (!self.forever) {
            // guarantee execute once
            self.forever = true;
            if (self.t1 < 0) {
                self.t1 = Date.now();
                log.info("To stop application, press Control-C");
            }
            while (!self.isStopping()) {
                const now = Date.now();
                if (now - self.t1 > 60000) {
                    self.t1 = now;
                    log.debug('Running...');
                }
                await util.sleep(250);
            }
            log.info("Stopped");
        }
    }

    /**
     * Stop the platform and cloud connector
     */
    stop(): void {
        self.stopping = true;
        shutdown();
    }

    /**
     * Check if the platform is shutting down
     * 
     * @returns true or false
     */
    isStopping(): boolean {
        return self.stopping;
    }

}