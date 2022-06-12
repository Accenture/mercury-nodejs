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

// Register and announce that 'hello.world' service is available as this function with EventEnvelope as input
platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
    log.info('GOT headers='+JSON.stringify(evt.getHeaders())+', body='+JSON.stringify(evt.getBody()));
    return evt.getBody();
});

// Connect to the cloud via language connector
connector.connectToCloud();
