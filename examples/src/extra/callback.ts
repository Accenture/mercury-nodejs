import { Logger, Platform, PostOffice, EventEnvelope } from 'mercury';
import { ComposableLoader } from '../preload/preload.js'; 

// Load system components
const log = Logger.getInstance();

const HELLO_WORLD = 'hello.world'
const MY_CALLBACK = 'my.callback';
const TEST_MESSAGE = 'test message';

async function callback(evt: EventEnvelope) {
    const myName = evt.getHeader('my_route');
    log.info(`${myName} received event ${evt.getId()}`);
    log.info({'headers': evt.getHeaders(), 'body': evt.getBody()});
}

// Set this function as "async" so we can use the "await" method to write code in "sequential non-blocking" manner
async function main() {
    // Load composable functions into memory
    ComposableLoader.initialize();
    // Obtain a trackable PostOffice instance to enable distributed tracing
    const po = new PostOffice({'my_route': 'callback.demo', 'my_trace_id': '300', 'my_trace_path': '/api/callback/demo'});
    // Register the callback function programmatically
    const platform = Platform.getInstance();
    platform.register(MY_CALLBACK, callback);
    // Make multiple RPC calls to the service
    for (let i=1; i <= 5; i++) {
        po.send(new EventEnvelope().setTo(HELLO_WORLD).setReplyTo(MY_CALLBACK)
                .setHeader('n', String(i)).setBody(TEST_MESSAGE + ' ' + i));
    }
    log.info('Demo application completed <--- this will show before the events are processed');
    // demonstrate running forever
    platform.runForever();
}

// run the application
main();
