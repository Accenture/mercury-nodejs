import { Logger, Platform, PO, EventEnvelope, Utility } from 'mercury';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();
const util = new Utility().getInstance();

const MY_HELLO_WORLD = 'hello.world';
const TEST_MESSAGE = 'test message';

// Set this function as 'async' so that we can use 'await' instead of using 'promise.then' method
async function demo() {
    platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
        log.info(`${MY_HELLO_WORLD} got headers=${JSON.stringify(evt.getHeaders())}, body=${JSON.stringify(evt.getBody())}`);
        return evt.getBody();
    });

    // If you use the built-in REST automation feature in the language connector and tracing is turned on for the REST endpoint,
    // traceId and tracePath will be inserted automatically.
    //
    // In this example, we set the traceId and tracePath programmatically as a demo.
    // When you run the application, you will see distributed trace log correlating the events together.
    const tracePath = 'GET /api/hello/world';
    for (let i=0; i < 2; i++) {
        const traceId = util.getUuid();
        const result = await po.request(new EventEnvelope().setTo(MY_HELLO_WORLD)
                                .setTraceId(traceId).setTracePath(tracePath).setFrom('this.demo')
                                .setHeader('n', String(i)).setBody(TEST_MESSAGE));
        log.info(`Payload match? ${TEST_MESSAGE == result.getBody()}`);
        log.info(`Received ${i + 1}`);
    }
    log.info('Demo (standalone mode with tracing) completed');
}

// run the demo in standalone mode. i.e. without connecting to the cloud via language connector.
//
// In standalone mode, many event driven programming patterns are available. e.g. RPC, callback, async.
demo();
