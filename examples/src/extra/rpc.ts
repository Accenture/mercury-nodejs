import { Logger, PostOffice, EventEnvelope } from 'mercury';
import { ComposableLoader } from '../preload/preload.js'; 

// Load system components
const log = Logger.getInstance();

const HELLO_WORLD = 'hello.world'
const TEST_MESSAGE = 'test message';

// Set this function as "async" so we can use the "await" method to write code in "sequential non-blocking" manner
async function main() {
    // Load composable functions into memory
    ComposableLoader.initialize();
    // Obtain a trackable PostOffice instance to enable distributed tracing
    const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '100', 'my_trace_path': '/api/rpc/test'});
    // Make multiple RPC calls to the service
    for (let i=1; i <= 5; i++) {
        // the default timeout is one minute if you do not provide the "timeout" value for RPC
        const req = new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE);
        const result = await po.request(req, 2000);     
        if (result.getBody()) {
            log.info(`Payload match? ${TEST_MESSAGE == result.getBody()}`);
            log.info(`Received ${i}`);
        }
    }
    log.info('Demo application completed');
}

// run this application
main();
