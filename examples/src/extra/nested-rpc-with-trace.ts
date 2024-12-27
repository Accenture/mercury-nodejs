import { Logger, Composable, Platform, PostOffice, EventEnvelope } from 'mercury';
import { ComposableLoader } from '../preload/preload.js'; 

// Load system components
const log = Logger.getInstance();

const HELLO_WORLD = 'hello.world';
const ANOTHER_FUNCTION = 'another.function';
const TEST_MESSAGE = 'test message';

class Hello implements Composable {
    initialize(): Hello {
        return this;
    }
    async handleEvent(evt: EventEnvelope) {
        // propage tracing information from the event metadata
        const po = new PostOffice(evt.getHeaders());
        const myRoute = evt.getHeader('my_route');
        const myInstance = evt.getHeader('my_instance');
        log.info({'headers': evt.getHeaders(), 'body': evt.getBody()});
        // make a RPC call to another function
        return await po.request(new EventEnvelope().setTo(ANOTHER_FUNCTION)
                        .setBody(evt.getBody()).setHeader('sender', myRoute+'#'+myInstance), 5000);
    }
}

class AnotherFunction implements Composable {
    initialize(): AnotherFunction {
        return this;
    }
    async handleEvent(evt: EventEnvelope) {
        // retrieve the system provided metadata
        const myRoute = evt.getHeader('my_route');
        const myInstance = evt.getHeader('my_instance');
        log.info({'headers': evt.getHeaders(), 'body': evt.getBody()});
        return {'input': evt.getBody(), 
                'from': `${myRoute} worker-${myInstance}`, 'upstream': `${evt.getHeader('sender')}`};
    }
}

// Set this function as "async" so we can use the "await" method to write code in "sequential non-blocking" manner
async function main() {
    // Load composable functions into memory
    ComposableLoader.initialize();
    // Obtain a trackable PostOffice instance to enable distributed tracing
    const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '200', 'my_trace_path': '/api/nested/rpc'});
    // Register your service with the named route "hello.world"
    const platform = Platform.getInstance();
    platform.register(HELLO_WORLD, new Hello(), 5);
    platform.register(ANOTHER_FUNCTION, new AnotherFunction(), 10);
    // Make multiple RPC calls to the service
    for (let i=1; i <= 5; i++) {
        const result = await po.request(new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', String(i)).setBody(TEST_MESSAGE + ' ' + i), 5000);
        log.info({'data': result.getBody()})
    }
    log.info('Nested RPC with tracing completed');
}

// run the application
main();

