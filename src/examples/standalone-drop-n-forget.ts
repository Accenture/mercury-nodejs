import { Logger } from '../util/logger.js';
import { Platform } from '../system/platform.js';
import { PO } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();

const HELLO_WORLD = 'hello world';
const MY_HELLO_WORLD = 'hello.world';

// this example illustrates 'drop-n-forget' by sending the events asynchronously without waiting for a response
function demo() {
    for (let i=0; i < 5; i++) {
        po.send(new EventEnvelope().setTo(MY_HELLO_WORLD).setHeader('n', String(i)).setBody(HELLO_WORLD));
    }
    log.info('Send completed');
}

function myHelloWorld(evt: EventEnvelope): void {
    log.info('hello.world receives headers='+JSON.stringify(evt.getHeaders())+', body='+JSON.stringify(evt.getBody()));
}
platform.register(MY_HELLO_WORLD, myHelloWorld);

// run the demo in standalone mode. i.e. without connecting to the cloud via language connector.
//
// In standalone mode, many event driven programming patterns are available. e.g. RPC, callback, async.
demo();

// demonstrate running forever
platform.runForever();
