import { Logger } from '../util/logger.js';
import { ObjectStreamIO, ObjectStreamReader, ObjectStreamWriter } from '../system/stream-io.js'
import { EventEnvelope } from '../models/event-envelope.js';
import { Platform } from '../system/platform.js';
import { PO } from '../system/post-office.js';
// Import and start worker thread in the background
import { Connector } from '../cloud/connector.js';

const CONNECTOR_LIFECYCLE = 'cloud.connector.lifecycle';
const CYCLES = 100;

const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();
const connector = new Connector().getInstance();

// Set this function as 'async' so that we can use 'await' to get the next block of data from the stream
async function demo() {
    const io = new ObjectStreamIO(60);
    const inRoute = await io.getInputStream();
    const outRoute = await io.getOutputStream();

    console.log('Input stream handle - '+inRoute);
    console.log('Output stream handle - '+outRoute);

    console.log('Writing '+CYCLES+' items to output stream...');
    const outStream = new ObjectStreamWriter(outRoute);
    for (let i=0; i < CYCLES; i++) {
        outStream.write('hello world '+i);
    }
    outStream.close();

    console.log('Reading '+CYCLES+' items from input stream...');
    const inStream = new ObjectStreamReader(inRoute);
    let eof = false;
    const reader = inStream.reader(5000);
    while (!eof) {
        const block = await reader.next();
        if (block.done) {
            eof = true;
            break;
        }
        log.info('Got '+block.value);
    }
    inStream.close();
}

// Subscribe to 'connector life cycle' to find out when the app has connected to the cloud via the language connector
platform.register('ws.status', (evt: EventEnvelope) => {
    log.info(JSON.stringify(evt));
    if ('ready' == evt.getHeader('type')) {
        log.info('Cloud is ready');
        demo().then(() => {
            log.info('Streaming I/O demo completed');
            platform.stop();
        });
    }
}, true);
po.send(new EventEnvelope().setTo(CONNECTOR_LIFECYCLE).setHeader('type', 'subscribe').setHeader('route', 'ws.status'));

// Connect to cloud because the streaming I/O service is provided by the language connector
connector.connectToCloud();
