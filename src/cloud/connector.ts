import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { Logger } from "../util/logger.js";
import { Utility } from '../util/utility.js';
import { Platform } from "../system/platform.js";
import { PO } from "../system/post-office.js";
import { EventEnvelope } from '../models/event-envelope.js';
// load web socket worker by importing it
import "./ws-service.js"

const log = new Logger().getInstance();
const util = new Utility().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();

const CONNECTOR_LIFECYCLE = 'cloud.connector.lifecycle';
const WS_WORKER = 'ws.worker';
const API_KEY_ENV = 'LANGUAGE_PACK_KEY';
const API_KEY_FILE = '/tmp/config/lang-api-key.txt';

let self: CloudConnector = null;

function cloud(message: string) {
    log.info(message);
}

function ensureDir(filePath: string) {
    const slash = filePath.lastIndexOf('/');
    if (slash != -1) {
        const parent = filePath.substring(0, slash);
        if (!existsSync(parent)) {
            mkdirSync(parent, { recursive: true });
            log.info('Folder '+parent+' created');
        }
    }
}

export class Connector {

    constructor() {
        if (self == null) {
            self = new CloudConnector();
        }
    }
  
    getInstance() {
        return self;
    }
}

class CloudConnector {

    private target: string;
    private apiKey: string;

    constructor() {
        self = this;
        const config = platform.getConfig();
        self.target = config.getElement('network.connector');
        const apiKeyEnv = config.getElement('language.pack.key', API_KEY_ENV);
        self.apiKey = process.env[apiKeyEnv];
        if (!self.apiKey) {
            if (!existsSync(API_KEY_FILE)) {
                ensureDir(API_KEY_FILE);
                writeFileSync(API_KEY_FILE, util.getUuid()+'\r\n');                
            }
            self.apiKey = readFileSync(API_KEY_FILE, {encoding:'utf-8', flag:'r'}).trim();
        }
        po.subscribe('cloud.status', (evt: EventEnvelope) => {
            if ('disconnected' == evt.getHeader('type')) {
                util.sleep(5000).then(() => self.connectToCloud(true));
            }
        });
        po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'subscribe')
            .setHeader('route', 'cloud.status').setHeader('permanent', 'true'));

        po.subscribe('system.config', (evt: EventEnvelope) => {
            if ('ready' == evt.getHeader('type')) {
                po.setStatus('ready');
                po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'ready'));
            }
            if ('system.config' == evt.getHeader('type') && evt.getBody()) {
                const m = evt.getBody();
                const maxPayload = m['max.payload'];
                if (maxPayload) {
                    po.send(new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'authorized')
                        .setHeader('block_size', String(maxPayload)));
                }
                const traceSupported = m['trace.aggregation'];
                if (traceSupported != null) {
                    platform.setTraceSupport(traceSupported);
                }
            }
        });
        po.subscribe('system.alerts', (evt: EventEnvelope) => {
            if (evt.getBody()) {
                log.info(String(evt.getBody()));
            }
        });
    }

    /**
     * Tell the system to connect to the cloud via a language connector
     * 
     * @param reconnect is true or false
     */
    connectToCloud(reconnect = false): void {
        cloud((reconnect? 'Reconnecting' : 'Connecting') + ' to cloud');
        const req = new EventEnvelope().setTo(WS_WORKER).setHeader('type', 'connect')
                                       .setHeader('target', self.target).setHeader('key', self.apiKey);
        if (reconnect) {
            req.setHeader('reconnect', 'true');
        }
        po.send(req);
    }

}


