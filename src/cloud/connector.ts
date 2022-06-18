import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { Platform } from '../system/platform.js';
import { PO } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
// load web socket worker by importing it
import './ws-service.js'

const log = new Logger().getInstance();
const util = new Utility().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();

const CONNECTOR_LIFECYCLE = 'cloud.connector.lifecycle';
const CLOUD_CONNECTION_RETRY = 'cloud.connection.retry';
const SYSTEM_CONFIG = 'system.config';
const SYSTEM_ALERTS = 'system.alerts';
const WS_WORKER = 'ws.worker';
const TYPE = 'type';
const READY = 'ready';
const RETRY = 'retry';
const AUTHORIZED = 'authorized';
const BLOCK_SIZE = 'block_size';
const MAX_PAYLOAD = 'max.payload';
const TRACE_AGGREGATION = 'trace.aggregation';
const CONNECT = 'connect';
const TARGET = 'target';
const KEY = 'key';
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
        po.subscribe(CLOUD_CONNECTION_RETRY, (evt: EventEnvelope) => {
            if (RETRY == evt.getHeader(TYPE)) {
                util.sleep(5000).then(() => self.connectToCloud(true));
            }
        });

        po.subscribe(SYSTEM_CONFIG, (evt: EventEnvelope) => {
            if (READY == evt.getHeader(TYPE)) {
                po.setStatus(READY);
                po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader(TYPE, READY));
            }
            if (SYSTEM_CONFIG == evt.getHeader(TYPE) && evt.getBody()) {
                const m = evt.getBody();
                const maxPayload = m[MAX_PAYLOAD];
                if (maxPayload) {
                    po.send(new EventEnvelope().setTo(WS_WORKER).setHeader(TYPE, AUTHORIZED)
                        .setHeader(BLOCK_SIZE, String(maxPayload)));
                }
                const traceSupported = m[TRACE_AGGREGATION];
                if (traceSupported != null) {
                    platform.setTraceSupport(traceSupported);
                }
            }
        });
        po.subscribe(SYSTEM_ALERTS, (evt: EventEnvelope) => {
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
        if (!reconnect) {
            cloud('Connecting to cloud');
        }
        const req = new EventEnvelope().setTo(WS_WORKER).setHeader(TYPE, CONNECT)
                                       .setHeader(TARGET, self.target).setHeader(KEY, self.apiKey);
        if (reconnect) {
            req.setHeader('reconnect', 'true');
        }
        po.send(req);
    }

}


