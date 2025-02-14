import os from 'os';
import { AppConfig } from '../util/config-reader.js';
import { Platform } from '../system/platform.js';
import { PostOffice } from '../system/post-office.js';
import { Utility } from '../util/utility.js';
import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { MultiLevelMap } from '../util/multi-level-map.js';
import { AppException } from '../models/app-exception.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';

const po = new PostOffice();
const ACTUATOR_SERVICES = 'actuator.services';
const CONTENT_TYPE = "Content-Type";
const APPLICATION_JSON = "application/json";
const TEXT_PLAIN = "text/plain";
const TYPE = 'type';
const INFO = 'info';
const HEALTH = 'health';

let loaded = false;
let appName: string;
let appVersion: string;
let appDesc: string;
let healthServices: Array<string>;
let origin: string;
let startTime: string;
const util = new Utility();
const numberFormatter = new Intl.NumberFormat('en-us');

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class ActuatorServices implements Composable {
    static name = ACTUATOR_SERVICES;
    
    initialize(): Composable { 
        if (!loaded) {
            loaded = true;
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

    async handleEvent(evt: EventEnvelope) {
        const payload = evt.getBody();
        if (payload && payload instanceof Object) {
            // interpret the incoming HTTP request
            const request = new AsyncHttpRequest(payload);
            if (request) {
                if ('/info' == request.getUrl()) {
                    return await ActuatorServices.doInfo();
                }
                if ('/health' == request.getUrl()) {
                    return await ActuatorServices.doHealthChecks();
                }
                if ('/livenessprobe' == request.getUrl()) {
                    return new EventEnvelope().setHeader(CONTENT_TYPE, TEXT_PLAIN).setBody('OK');
                }
            }
        }
        return null;
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
        const upstream = new Array<object>();
        for (let i=0; i < healthServices.length; i++) {
            const service = healthServices[i];
            const info = {'route': service};  
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
            } catch (e) {
                up = false;
                const rc = e instanceof AppException ? e.getStatus() : 500;
                status = rc;
                info['status_code'] = rc;
                info['message'] = e.message;
            }
            upstream.push(info);
        }
        const result = {'up': up, 'origin': origin, 'name': appName, 'dependency': upstream};
        if (upstream.length == 0) {
            result['message'] = 'Did you forget to define health.dependencies in application configuration?';
        }
        return new EventEnvelope().setStatus(status).setHeader(CONTENT_TYPE, APPLICATION_JSON).setBody(result);
    }
}
