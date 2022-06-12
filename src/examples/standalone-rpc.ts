import { Logger } from '../util/logger.js';
import { Platform } from '../system/platform.js';
import { PO } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
import assert from 'assert';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();

const MY_HELLO_WORLD = 'hello.world';
const TEST_MESSAGE = 'test message';

// Set this function as 'async' so that we can use 'await' instead of using 'promise.then' method
async function demo() {
    platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
        log.info('GOT headers='+JSON.stringify(evt.getHeaders())+', body='+JSON.stringify(evt.getBody()));
        return evt.getBody();
    });

    for (let i=0; i < 5; i++) {
        const result = await po.request(new EventEnvelope().setTo(MY_HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE));
        assert.equal(TEST_MESSAGE, result.getBody());
        log.info('Received item '+(i + 1));
    }
    log.info('Demo (standalone mode) completed');
}

// run the demo in standalone mode. i.e. without connecting to the cloud via language connector.
//
// In standalone mode, many event driven programming patterns are available. e.g. RPC, callback, async.
demo();
