import { Logger, Platform, PostOffice, EventEnvelope } from 'mercury';
import { ComposableLoader } from '../preload/preload.js'; 

// Load system components
const log = new Logger();
const platform = new Platform();

const HELLO_WORLD = 'hello.world'
const TEST_MESSAGE = 'test message';

// Set this function as "async" so we can use the "await" method to write code in "sequential non-blocking" manner
async function main() {
    // Load composable functions into memory
    ComposableLoader.initialize();
    // Obtain a trackable PostOffice instance to enable distributed tracing
    const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '200', 'my_trace_path': '/api/async/test'});
    // Make multiple RPC calls to the service
    for (let i=1; i <= 10; i++) {
        po.send(new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE + ' ' + i));
    }
    log.info('Demo application completed <--- this will show before the events are processed');
}

// run this application
main();

// demonstrate running forever
platform.runForever();
