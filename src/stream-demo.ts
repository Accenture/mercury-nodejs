import { Logger } from "./util/logger.js";

import { ObjectStreamIO, ObjectStreamReader, ObjectStreamWriter } from "./system/stream-io.js"
// import { ObjectStreamIO } from "./system/stream-io.js"

import { EventEnvelope } from './models/event-envelope.js';

import { Platform } from "./system/platform.js";
import { PO } from "./system/post-office.js";
// import and start worker thread in the background
import { Connector } from './cloud/connector.js';

const CONNECTOR_LIFECYCLE = 'cloud.connector.lifecycle';

const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();
const connector = new Connector().getInstance();
connector.connectToCloud();

async function demo() {

    const io = new ObjectStreamIO(60);
    const inRoute = await io.getInputStream();
    const outRoute = await io.getOutputStream();

    console.log(inRoute);
    console.log(outRoute);

    const outStream = new ObjectStreamWriter(outRoute);
    for (let i=0; i < 100; i++) {
        outStream.write('hello world '+i);
    }
    outStream.close();

    const inStream = new ObjectStreamReader(inRoute);

    let eof = false;
    const reader = inStream.reader(5000);
    while (!eof) {
        const block = await reader.next();
        if (block.done) {
            eof = true;
            break;
        }
        log.info("Got "+block.value);
    }
    inStream.close();
}


platform.register('ws.status', (evt: EventEnvelope) => {
    log.info(JSON.stringify(evt));
    if ('ready' == evt.getHeader('type')) {
        log.info("---CLOUD IS READY---");

        demo();
    }
}, true);
po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'subscribe').setHeader('route', 'ws.status'));

