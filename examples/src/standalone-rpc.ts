import { Logger, Platform, PO, EventEnvelope } from 'mercury';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();

const MY_HELLO_WORLD = 'hello.world';
const TEST_MESSAGE = 'test message';

// Set this function as 'async' so that we can use 'await' instead of using 'promise.then' method
async function demo() {
    platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
        log.info(`${MY_HELLO_WORLD} got headers=${JSON.stringify(evt.getHeaders())}, body=${JSON.stringify(evt.getBody())}`);
        return evt.getBody();
    });

    for (let i=0; i < 5; i++) {
        const result = await po.request(new EventEnvelope().setTo(MY_HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE));
        log.info(`Payload match? ${TEST_MESSAGE == result.getBody()}`);
        log.info(`Received ${i + 1}`);
    }
    log.info('Demo (standalone mode) completed');
}

// run the demo in standalone mode. i.e. without connecting to the cloud via language connector.
//
// In standalone mode, many event driven programming patterns are available. e.g. RPC, callback, async.
demo();
