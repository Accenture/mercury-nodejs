import { Logger, Platform, PO, EventEnvelope } from 'mercury';
// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const po = new PO().getInstance();

const MY_HELLO_WORLD = 'hello.world';
const MY_CALLBACK = 'my.callback.function';
const TEST_MESSAGE = 'Test message';

function demo() {
    platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
        log.info(`${MY_HELLO_WORLD} got headers=${JSON.stringify(evt.getHeaders())}, body=${JSON.stringify(evt.getBody())}`);
        // just return a new event with the given headers/parameters and payload
        return new EventEnvelope().setHeaders(evt.getHeaders()).setBody(evt.getBody());
    });

    for (let i=0; i < 5; i++) {
        po.send(new EventEnvelope().setTo(MY_HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE).setReplyTo(MY_CALLBACK));
    }
    log.info('Send completed');
}

function myCallback(evt: EventEnvelope): void {
    log.info(`${MY_CALLBACK} got headers=${JSON.stringify(evt.getHeaders())}, body=${JSON.stringify(evt.getBody())}`);
}
platform.register(MY_CALLBACK, myCallback);

// run the demo in standalone mode. i.e. without connecting to the cloud via language connector.
//
// In standalone mode, many event driven programming patterns are available. e.g. RPC, callback, async.
demo();

// demonstrate running forever
platform.runForever();
