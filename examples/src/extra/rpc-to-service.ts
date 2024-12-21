import { Logger, PostOffice, EventEnvelope } from 'mercury';
import { ComposableLoader } from '../preload/preload.js'; 

const log = Logger.getInstance();

const HELLO_WORLD = 'hello.world'
const TEST_MESSAGE = 'test message';
const REMOTE_EVENT_ENDPOINT = 'http://127.0.0.1:8086/api/event';

// Set this function as "async" so we can use the "await" method to write code in "sequential non-blocking" manner
async function main() {
    // Load composable functions into memory
    ComposableLoader.initialize();   
    // Obtain a trackable PostOffice instance to enable distributed tracing
    const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '200', 'my_trace_path': '/api/remote/rpc'});
    // Make multiple RPC calls to the service
    for (let i=1; i <= 3; i++) {
        // the default timeout is one minute if you do not provide the "timeout" value for RPC
        const req = new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE);
        const result = await po.remoteRequest(req, REMOTE_EVENT_ENDPOINT);
        if (result.getStatus() == 200) {
            if (result.getBody()) {
                log.info(`Payload match? ${TEST_MESSAGE == result.getBody()}`);
                log.info(`Received ${i}`);
            }
        } else {
            log.error(`Unable to connect to ${REMOTE_EVENT_ENDPOINT} - HTTP-${result.getStatus()} - ${result.getBody()}`);
            break;
        }
    }
    log.info('Demo application completed');
}

// run the application
main();
