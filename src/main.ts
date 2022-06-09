import { Logger } from "./util/logger.js";
import { Platform } from "./system/platform.js";
import { PO } from "./system/post-office.js";
import { Utility } from './util/utility.js';
import { EventEnvelope } from './models/event-envelope.js';
import { AppException } from './models/app-exception.js';
import { AsyncHttpRequest } from "./models/async-http-request.js";
// import and start worker thread in the background
import { Connector } from './cloud/connector.js';

const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();
const util = new Utility().getInstance();
const connector = new Connector().getInstance();
const CONNECTOR_LIFECYCLE = 'cloud.connector.lifecycle';

platform.register('hello.world', (evt: EventEnvelope) => {
    return new Promise((resolve, reject) => {
        const response = new EventEnvelope().setBody(evt.getBody()).setHeaders(evt.getHeaders());
        log.info('IN HELLO WORLD ---->'+JSON.stringify(evt));
        // check if input is an AsyncHttpRequest
        const httpRequest = new AsyncHttpRequest(evt.getBody());
        if (httpRequest.getMethod()) {
            log.info("HTTP request - "+httpRequest.getMethod()+" "+httpRequest.getUrl());
        }
        if ('exception' == evt.getHeader('type')) {
            reject(new Error('demo exception'));
        }
        if ('test.route' == evt.getFrom()) {
            util.sleep(3000).then(() => {
                po.request(new EventEnvelope().setTo('test.route').setHeader('type', 'echo').setBody(evt.getBody())).then(log.info);
            });
            
        }
        resolve(response);
    });
});

platform.register('hello.f1', (evt: EventEnvelope) => {
    log.info("F1------>"+JSON.stringify(evt));
    return true;
}, true);

const event = new EventEnvelope().setTo('hello.world').setBody('hello world').setHeader('x', 'y').setReplyTo('hello.f1');
po.send(event);

const event2 = new EventEnvelope().setTo('hello.world').setBody('promise me').setHeader('Test', 'message');
po.request(event2, 500).then(v => log.info(JSON.stringify(v))).catch(e => {
    if (e instanceof AppException) {
        log.error('AppException status='+e.getStatus(), e);
    } else {
        log.error(e.message);
    }
});

util.sleep(2000).then(() => {
    connector.connectToCloud();
});

// set to 68000 to generate larger payload over 64 KB to test automatic payload segmentation
const CYCLE = 6800;
const SAMPLE = '123456789.';
let text = '';
for (let i = 0; i < CYCLE; i++) {
    text += SAMPLE;
}

platform.register('ws.status', (evt: EventEnvelope) => {
    if ('ready' == evt.getHeader('type')) {
        log.info("---CLOUD IS READY---");

        po.exists('test.route').then((found) => {
            if (found) {
                for (let i=0; i < 3; i++) {
                    po.request(new EventEnvelope().setTo('test.route').setBody(text).setHeader('type', 'echo '+i)).then((d) => {
                        log.info(d.getId());
                        log.info(d.getHeaders());
                        log.info('body size='+d.getBody()['body'].length);
                        log.info('status='+d.getStatus());
                        log.info(String(d.getExecTime()));
                        log.info(String(d.getRoundTrip()));
                    });
                }
            } else {
                log.error('test.route not found');
            }
        });
    }
}, true);
po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'subscribe').setHeader('route', 'ws.status'));

util.sleep(3000).then(() => {
    po.request(new EventEnvelope().setTo('hello.world').setBody('hello world').setHeader('type', 'exception')).then(console.log).catch((e) => {
        log.info("------ GOT EXCEPTION-----");
        log.error(e.stack);
    });
    
});
