import { Logger, Platform, PostOffice, EventEnvelope } from 'mercury';
import { fileURLToPath } from "url";

// Load system components
const log = Logger.getInstance();

const HELLO_WORLD = 'hello.world';
const ANOTHER_FUNCTION = 'another.function';
const TEST_MESSAGE = 'test message';

function getResourceFoler() {
    const folder = fileURLToPath(new URL("../resources/", import.meta.url));
    return folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
}

// Your service should be declared as an async function with input as EventEnvelope
async function hello(evt: EventEnvelope) {
    // propage tracing information from the event metadata
    const po = new PostOffice(evt.getHeaders());
    const myRoute = evt.getHeader('my_route');
    const myInstance = evt.getHeader('my_instance');
    log.info({'headers': evt.getHeaders(), 'body': evt.getBody()});
    // make a RPC call to another function
    return await po.request(new EventEnvelope().setTo(ANOTHER_FUNCTION).setBody(evt.getBody()).setHeader('sender', myRoute+'#'+myInstance), 5000);
}

async function anotherFunction(evt: EventEnvelope) {
    // retrieve the system provided metadata
    const myRoute = evt.getHeader('my_route');
    const myInstance = evt.getHeader('my_instance');
    log.info({'headers': evt.getHeaders(), 'body': evt.getBody()});
    return {'input': evt.getBody(), 'from': `${myRoute} worker-${myInstance}`, 'upstream': `${evt.getHeader('sender')}`};
}

// Set this function as "async" so we can use the "await" method to write code in "sequential non-blocking" manner
async function main() {
    // Start platform with user provided config file
    // IMPORTANT - this must be the first instantiation of the Platform object in your application
    const configFile = getResourceFoler() + 'application.yml';
    const platform = Platform.getInstance(configFile);
    log.info(`Platform ${platform.getOriginId()} ready`);    
    // Obtain a trackable PostOffice instance to enable distributed tracing
    const po = new PostOffice();
    // Register your service with the named route "hello.world"
    platform.register(HELLO_WORLD, hello, true, 5);
    platform.register(ANOTHER_FUNCTION, anotherFunction, true, 10);
    // Make multiple RPC calls to the service
    for (let i=1; i <= 5; i++) {
        const result = await po.request(new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE + ' ' + i), 5000);
        log.info({'data': result.getBody()})
    }
    log.info('Nested RPC completed');
}

// run this application
main();

