import { Logger } from '../util/logger.js';
import { Platform } from '../system/platform.js';
import { EventEnvelope } from '../models/event-envelope.js';
// Import and start worker thread in the background
import { Connector } from '../cloud/connector.js';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();

const MY_HELLO_WORLD = 'hello.world';
const MY_CALLBACK = "connector.listener";

// Register and announce that 'hello.world' service is available as this function with EventEnvelope as input
platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
    log.info('GOT headers='+JSON.stringify(evt.getHeaders()));
    return evt.getBody();
});

// Register a private scope service to listen to cloud connector life cycle events
platform.register(MY_CALLBACK, (evt: EventEnvelope) => {
    log.info('Connector life cycle event: '+JSON.stringify(evt.getHeaders()));
    return true;
}, true);
platform.subscribeLifeCycle(MY_CALLBACK);

// Connect to the cloud via language connector
connector.connectToCloud();
