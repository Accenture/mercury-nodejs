import os from 'os';
import { AppConfig } from '../util/config-reader.js';
import { Platform } from '../system/platform.js';
import { PostOffice } from '../system/post-office.js';
import { Utility } from '../util/utility.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { MultiLevelMap } from '../util/multi-level-map.js';
import { AppException } from '../models/app-exception.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { FunctionRegistry } from '../system/function-registry.js';
const po = new PostOffice();
const CONTENT_TYPE = "Content-Type";
const APPLICATION_JSON = "application/json";
const TEXT_PLAIN = "text/plain";
const TYPE = 'type';
const INFO = 'info';
const HEALTH = 'health';
let appName;
let appVersion;
let appDesc;
let healthServices;
let origin;
let startTime;
const util = new Utility();
const registry = FunctionRegistry.getInstance();
const numberFormatter = new Intl.NumberFormat('en-us');
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class ActuatorServices {
    static loaded = false;
    static infoService = "info.actuator.service";
    static routeService = "routes.actuator.service";
    static healthService = "health.actuator.service";
    static livenessService = "liveness.actuator.service";
    static envService = "env.actuator.service";
    initialize() {
        if (!ActuatorServices.loaded) {
            ActuatorServices.loaded = true;
            const platform = Platform.getInstance();
            const config = AppConfig.getInstance();
            appName = platform.getName();
            appVersion = config.getProperty('info.app.version', 'unknown');
            appDesc = config.getProperty('info.app.description', '-');
            origin = platform.getOriginId();
            startTime = util.getLocalTimestamp(platform.getStartTime().getTime());
            const hs = config.getProperty('health.dependencies', '');
            healthServices = hs.split(',').map(k => k.trim()).filter(k => k);
        }
        return this;
    }
    async handleEvent(evt) {
        const payload = evt.getBody();
        if (payload && payload instanceof Object) {
            const myRoute = evt.getHeader('my_route');
            // interpret the incoming HTTP request
            const request = new AsyncHttpRequest(payload);
            if (request && Object.keys(request.getHeaders()).length > 0) {
                if (ActuatorServices.infoService == myRoute) {
                    return await ActuatorServices.doInfo();
                }
                if (ActuatorServices.healthService == myRoute) {
                    return await ActuatorServices.doHealthChecks();
                }
                if (ActuatorServices.livenessService == myRoute) {
                    return new EventEnvelope().setHeader(CONTENT_TYPE, TEXT_PLAIN).setBody('OK');
                }
                if (ActuatorServices.envService == myRoute) {
                    return await ActuatorServices.doEnv();
                }
                if (ActuatorServices.routeService == myRoute) {
                    return await ActuatorServices.doRoutes();
                }
            }
        }
        throw new AppException(404, 'Resource not found');
    }
    static async doRoutes() {
        const result = new MultiLevelMap();
        result.setElement('app.name', appName);
        result.setElement('app.version', appVersion);
        result.setElement('app.description', appDesc);
        result.setElement('origin', origin);
        const publicKv = {};
        const privateKv = {};
        const functionList = registry.getFunctionList();
        for (const route of functionList) {
            const md = registry.getMetadata(route);
            const instances = md['instances'];
            const isPrivate = md['private'];
            if (isPrivate) {
                privateKv[route] = instances;
            }
            else {
                publicKv[route] = instances;
            }
        }
        result.setElement('routing.public', publicKv);
        result.setElement('routing.private', privateKv);
        return new EventEnvelope().setHeader(CONTENT_TYPE, APPLICATION_JSON).setBody(result.getMap());
    }
    static async doEnv() {
        const result = new MultiLevelMap();
        result.setElement('app.name', appName);
        result.setElement('app.version', appVersion);
        result.setElement('app.description', appDesc);
        result.setElement('origin', origin);
        const config = AppConfig.getInstance();
        const envVars = util.split(config.getProperty("show.env.variables", ""), ", ");
        const propVars = util.split(config.getProperty("show.application.properties", ""), ", ");
        const envKv = {};
        if (process) {
            for (const k of envVars) {
                const v = process.env[k];
                if (v) {
                    envKv[k] = v;
                }
            }
        }
        result.setElement('env.environment', envKv);
        const propKv = {};
        for (const k of propVars) {
            const v = config.get(k);
            if (v) {
                propKv[k] = v;
            }
        }
        result.setElement('env.properties', propKv);
        return new EventEnvelope().setHeader(CONTENT_TYPE, APPLICATION_JSON).setBody(result.getMap());
    }
    static async doInfo() {
        const result = new MultiLevelMap();
        const freemem = numberFormatter.format(os.freemem());
        const totalmem = numberFormatter.format(os.totalmem());
        const used = numberFormatter.format(process.memoryUsage().heapUsed);
        result.setElement('app.name', appName);
        result.setElement('app.version', appVersion);
        result.setElement('app.description', appDesc);
        result.setElement('memory.max', totalmem);
        result.setElement('memory.free', freemem);
        result.setElement('memory.used', used);
        result.setElement('node.version', process.version);
        result.setElement('origin', origin);
        result.setElement('time.current', util.getLocalTimestamp(new Date().getTime()));
        result.setElement('time.start', startTime);
        result.setElement('uptime', util.getElapsedTime(process.uptime() * 1000));
        return new EventEnvelope().setHeader(CONTENT_TYPE, APPLICATION_JSON).setBody(result.getMap());
    }
    static async doHealthChecks() {
        let up = true;
        let status = 200;
        const upstream = new Array();
        for (let i = 0; i < healthServices.length; i++) {
            const service = healthServices[i];
            const info = { 'route': service };
            try {
                const infoReq = new EventEnvelope().setTo(service).setHeader(TYPE, INFO);
                const infoRes = await po.request(infoReq, 3000);
                const infoBody = infoRes.getBody();
                if (infoBody && infoBody.constructor == Object) {
                    Object.keys(infoBody).forEach(k => {
                        info[k] = infoBody[k];
                    });
                }
                const healthReq = new EventEnvelope().setTo(service).setHeader(TYPE, HEALTH);
                const healthRes = await po.request(healthReq, 5000);
                const rc = healthRes.getStatus();
                info['status_code'] = rc;
                info['message'] = healthRes.getBody();
                if (rc != 200) {
                    up = false;
                    status = rc;
                }
            }
            catch (e) {
                up = false;
                const rc = e instanceof AppException ? e.getStatus() : 500;
                status = rc;
                info['status_code'] = rc;
                info['message'] = e.message;
            }
            upstream.push(info);
        }
        const result = { 'up': up, 'origin': origin, 'name': appName, 'dependency': upstream };
        if (upstream.length == 0) {
            result['message'] = 'Did you forget to define health.dependencies in application configuration?';
        }
        return new EventEnvelope().setStatus(status).setHeader(CONTENT_TYPE, APPLICATION_JSON).setBody(result);
    }
}
//# sourceMappingURL=actuator.js.map