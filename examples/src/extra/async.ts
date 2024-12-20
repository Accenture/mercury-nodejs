import { Logger, Platform, PostOffice, EventEnvelope } from 'mercury';
import { ComposableLoader } from '../preload/preload.js'; 
import { fileURLToPath } from "url";

// Load system components
const log = Logger.getInstance();

const HELLO_WORLD = 'hello.world'
const TEST_MESSAGE = 'test message';

function getResourceFoler() {
    const folder = fileURLToPath(new URL("../resources/", import.meta.url));
    return folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
}

// Set this function as "async" so we can use the "await" method to write code in "sequential non-blocking" manner
async function main() {
    // Start platform with user provided config file
    // IMPORTANT - this must be the first instantiation of the Platform object in your application
    const configFile = getResourceFoler() + 'application.yml';
    const platform = Platform.getInstance(configFile);
    log.info(`Platform ${platform.getOriginId()} ready`);
    // Load composable functions into memory
    ComposableLoader.initialize();
    // Obtain a trackable PostOffice instance to enable distributed tracing
    const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '200', 'my_trace_path': '/api/async/test'});
    // Make multiple RPC calls to the service
    for (let i=1; i <= 10; i++) {
        po.send(new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE + ' ' + i));
    }
    log.info('Demo application completed <--- this will show before the events are processed');
    // demonstrate running forever
    platform.runForever();
}

// run this application
main();


