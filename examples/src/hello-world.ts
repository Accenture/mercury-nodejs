import { Logger, Platform, Connector, EventEnvelope } from 'mercury';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();

const MY_HELLO_WORLD = 'hello.world';

// Register and announce that 'hello.world' service is available as this function with EventEnvelope as input
platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
    log.info(`GOT headers=${JSON.stringify(evt.getHeaders())}, body=${JSON.stringify(evt.getBody())}`);
    return evt.getBody();
});

// Connect to the cloud via language connector
connector.connectToCloud();
