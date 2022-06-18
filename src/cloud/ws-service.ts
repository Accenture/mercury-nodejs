import { Worker, isMainThread, parentPort } from 'worker_threads';
import { WebSocket } from 'ws';
import { unpack, pack } from 'msgpackr';
import { Platform } from "../system/platform.js";
import { PO } from "../system/post-office.js";
import { forwarder } from "../util/forwarder.js";
import { EventEnvelope } from '../models/event-envelope.js';
import { Logger } from "../util/logger.js";
import { Utility } from '../util/utility.js';

const CONNECTOR_LIFECYCLE = 'cloud.connector.lifecycle';
const CLOUD_CONNECTION_RETRY = 'cloud.connection.retry';
const WS_WORKER = 'ws.worker';
const KEEP_ALIVE = 'KeepAlive ';
const KEEP_ALIVE_INTERVAL = 30 * 1000;

const log = new Logger().getInstance();
const util = new Utility().getInstance();
const MSG_ID = '_id_';
const COUNT = '_blk_';
const TOTAL = '_max_';
let running = false;

if (isMainThread) {
    if (!running) {
        // Main thread
        running = true;
        log.info("Connector started");
        const platform = new Platform().getInstance();
        const po = new PO().getInstance();
        let loaded = false;
        let connected = false;
        let disconnected = false;
        let blockSize = 32 * 1024;
        const filename = import.meta.url.substring(7);
        const parts = filename.split('/');
        const scriptName = parts.length > 2 && parts[1].endsWith(':')? filename.substring(1) : filename;
        const worker = new Worker(scriptName);
        worker.on('message', (message) => {
            // event from worker thread
            const evt = unpack(message);
            const eventType = evt['type'];
            if ('event' == eventType && 'event' in evt) {
                const incoming = new EventEnvelope(evt['event']);
                try {
                    po.send(incoming);
                } catch (e) {
                    log.warn('Unable to relay incoming event - '+e.message);
                }   
            }
            if ('block' == eventType && 'block' in evt) {
                const incoming = new EventEnvelope(evt['block']);
                const msgId = incoming.getHeader(MSG_ID);
                const count = incoming.getHeader(COUNT);
                const total = incoming.getHeader(TOTAL);
                const data = incoming.getBody();
                if (msgId && count && total && data) {
                    let raw: Buffer = null;
                    if (data instanceof Buffer) {                        
                        raw = data;
                        log.debug('Receiving '+msgId+', '+count+' of '+total+', size='+raw.length+' as Buffer');
                    } else if (data instanceof Uint8Array) {
                        raw = Buffer.from(data);
                        log.debug('Receiving '+msgId+', '+count+' of '+total+', size='+raw.length+' as Uint8Array');
                    } else {
                        log.error('Unable to process incoming event '+msgId+' block-'+count+'. Expect: Buffer, Actual:'+data.constructor.name);
                        return;
                    }
                    const blocks = util.cacheExists(msgId)? util.getCached(msgId) as Array<Buffer> : [];
                    blocks.push(raw);
                    if (count == total) {
                        util.removeCache(msgId);
                        const restored = new EventEnvelope(Buffer.concat(blocks));
                        log.debug('Restored '+restored.getId()+' for delivery to '+restored.getTo());
                        try {
                            po.send(restored);
                        } catch (e) {
                            log.warn('Unable to relay incoming event - '+e.message);
                        }                    
                    } else {
                        util.saveCache(msgId, blocks, 30);
                    }
                }
            }
            if ('text' == eventType && 'message' in evt) {
                log.debug(evt['message']);
            }
            if ('connected' == eventType && 'message' in evt) {
                connected = true;
                disconnected = false;
                po.setStatus('connected');
                log.info(evt['message']);
                po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'connected').setHeader('message', evt['message']));
            }
            if ('disconnected' == eventType && 'message' in evt && 'error' in evt) {
                connected = false;
                po.setStatus('disconnected');
                if (evt['error']) {
                    log.warn(evt['message']);
                } else {
                    log.info(evt['message']);
                }
                po.send(new EventEnvelope().setTo(CLOUD_CONNECTION_RETRY).setHeader('type', 'retry'));
                if (!disconnected) {
                    disconnected = true;
                    po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'disconnected').setHeader('message', evt['message']));
                }
            }
            if ('error' == eventType && 'message' in evt) {
                log.warn(evt['message']);
                po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'error').setHeader('message', evt['message']));
            }
            if ('stop' == eventType) {
                // worker has closed websocket connection and it is safe to stop
                worker.terminate();
                log.info("Connector stopped");
            }
        });
        // register a forwarder to broadcast to subscribers about life cycle events
        po.subscribe(CONNECTOR_LIFECYCLE, forwarder);
        po.subscribe(WS_WORKER, (evt: EventEnvelope) => {
            if ('connect' == evt.getHeader('type') && evt.getHeader('target') && evt.getHeader('key')) {
                const target = evt.getHeader('target') + '/' + platform.getOriginId();
                const reconnect = evt.getHeader('reconnect')? true : false;
                if (!reconnect && loaded) {
                    log.warn('Websocket connection request ignored because '+target+' is already loaded');
                } else {
                    loaded = true;
                    if (!connected) {
                        const event = new EventEnvelope().setHeader('type', 'connect').setHeader('origin', platform.getOriginId())
                                            .setHeader('target', target).setHeader('key', evt.getHeader('key'));
                        worker.postMessage(event.toBytes());
                    }
                }
            }
            if ('authorized' == evt.getHeader('type') && evt.getHeader('block_size')) {
                blockSize = parseInt(evt.getHeader('block_size'));
                // advertise all public routes
                po.setStatus('authenticated');
                platform.advertise();
                log.info('Authenticated');
                log.info('Automatic payload segmentation at '+blockSize+' bytes');
                po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'authenticated'));
                // send 'ready' signal to cloud after connection authentication
                worker.postMessage(new EventEnvelope().setHeader('type', 'ready'));
            }
            if ('event' == evt.getHeader('type') && evt.getBody() instanceof Object) {
                // perform outgoing payload segmentation for large payload
                const payload = pack(evt.getBody());
                const len = payload.length;
                if (len > blockSize) {
                    const msgId = evt.getId();
                    let total = parseInt(String(len / blockSize));
                    if (len > total) {
                        total++;
                    }
                    let start = 0;
                    let remaining = len;
                    for (let i=0; i < total; i++) {
                        const count = i + 1;
                        const block = new EventEnvelope().setHeader(MSG_ID, msgId).setHeader(COUNT, String(count)).setHeader(TOTAL, String(total));
                        const end = start + (remaining > blockSize? blockSize : remaining);
                        const segment = payload.subarray(start, end);
                        block.setBody(segment);
                        remaining -= segment.length;
                        start = end;
                        log.debug('Sending '+msgId+', '+count+' of '+total+', size='+segment.length);
                        const transport = new EventEnvelope().setHeader('type', 'block').setBody(block.toMap());
                        worker.postMessage(transport.toBytes());
                    }

                } else {
                    const relay = new EventEnvelope().setHeader('type', 'event').setBody(payload);
                    worker.postMessage(relay.toBytes());
                }                
            }
            if ('add' == evt.getHeader('type') && evt.getHeader('route')) {
                worker.postMessage(evt.toBytes());
            }
            if ('remove' == evt.getHeader('type') && evt.getHeader('route')) {
                worker.postMessage(evt.toBytes());
            }
            if ('stop' == evt.getHeader('type')) {
                worker.postMessage(new EventEnvelope().setHeader('type', 'stop').toBytes());
            }
        });
    }
} else {
    const UNREACHABLE = 'Unreachable';
    const CONNECTION_REFUSED = 'ECONNREFUSED';
    // Worker thread where the websocket connection is made
    let apiKey: string = null;
    let session: string = null;
    let target: string = null;
    let ws: WebSocket = null;
    let originId = null;
    let connected = false;
    let authenticated = false;
    let keepAlive = null;
    let errorMessage = null;

    parentPort.on('message', (message) => {
        const evt = new EventEnvelope(message);
        if ('connect' == evt.getHeader('type') && evt.getHeader('target') && evt.getHeader('key') && evt.getHeader('origin')) {
            originId = evt.getHeader('origin');
            apiKey = evt.getHeader('key');
            session = util.getUuid().substring(0, 6);
            target = evt.getHeader('target');
            ws = new WebSocket(target);
            ws.on('open', () => {
                errorMessage = null;
                connected = true;
                ws.send(pack({'type': 'login', 'api_key': apiKey}), {binary: true});
                parentPort.postMessage(pack({'type': 'connected', 'message': 'Session '+session+' connected to '+target}));
            });
            ws.on('message', (data: Buffer, isBinary: boolean) => {
                if (isBinary) {
                    parentPort.postMessage(data);
                } else {
                    parentPort.postMessage(pack({'type': 'text', 'message': String(data)}));
                }
            });
            ws.on('close', (code: number, reason: Buffer) => {
                connected = false;
                authenticated = false;
                if (keepAlive) {
                    clearInterval(keepAlive);
                    keepAlive = null;
                }
                let hasError = false;
                let closeReason = String(reason);
                if (errorMessage && closeReason.length == 0) {
                    closeReason = errorMessage;
                    hasError = true;
                }
                parentPort.postMessage(pack({ 'type': 'disconnected', 'error': hasError, 'message': 'Session ' + 
                                            session + ' closed (' + code + ') ' + closeReason }));
                errorMessage = null;
            });
            ws.on('error', (e: Error) => {
                // when cloud connection is not reachable
                if (e.message.includes(CONNECTION_REFUSED)) {                    
                    errorMessage = UNREACHABLE + ' ' + e.message.substring(e.message.indexOf(CONNECTION_REFUSED) + CONNECTION_REFUSED.length).trim();
                } else {                
                    parentPort.postMessage(pack({'type': 'error', 'message': e.message}));
                }
                if (connected) {
                    ws.close(1001);
                }
            });
        }
        if ('ready' == evt.getHeader('type')) {
            authenticated = true;
            keepAlive = setInterval(() => {
                ws.send(KEEP_ALIVE+(new Date().toISOString()));
            }, KEEP_ALIVE_INTERVAL);
            ws.send(pack({'type': 'ready'}), {binary: true});
        }
        if ('event' == evt.getHeader('type') && evt.getBody()) {
            if (authenticated) {
                ws.send(pack({'type': 'event', 'event': evt.getBody()}), {binary: true});
            }
        }
        if ('block' == evt.getHeader('type') && evt.getBody()) {
            if (authenticated) {
                ws.send(pack({'type': 'block', 'block': evt.getBody()}), {binary: true});
            }
        }
        if ('add' == evt.getHeader('type') && evt.getHeader('route')) {
            ws.send(pack({'type': 'add', 'route': evt.getHeader('route')}), {binary: true});
        }
        if ('remove' == evt.getHeader('type') && evt.getHeader('route')) {
            ws.send(pack({'type': 'remove', 'route': evt.getHeader('route')}), {binary: true});
        }
        if ('stop' == evt.getHeader('type')) {
            if (connected) {
                ws.close(1000, 'Application '+originId+' is stopping');
            }
            parentPort.postMessage(pack({'type': 'stop'}));
        }
    });
}
