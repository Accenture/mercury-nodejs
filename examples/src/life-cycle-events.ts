import { Logger, Platform, Connector, EventEnvelope } from 'mercury';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();

const MY_HELLO_WORLD = 'hello.world';
const CLOUD_MONITOR = "connector.event.listener";

// Register and announce that 'hello.world' service is available as this function with EventEnvelope as input
platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
    log.info(`GOT headers=${JSON.stringify(evt.getHeaders())}`);
    return evt.getBody();
});

let ready = false;

function lifeCycleListener(evt: EventEnvelope) {
    const headers = evt.getHeaders();
    log.info(`Connector life cycle event: ${JSON.stringify(headers)}`);
    if ('ready' == headers['type']) {
        ready = true;
        log.info('Cloud is ready');
        // TODO: some logic to communicate with other service thru the cloud
    }
    // The 'disconnected' can come repeatedly until cloud is re-connected.
    // Therefore, we use a 'ready' signal to filter out repeated ones.
    if ('disconnected' == headers['type']) {
        if (ready) {
            ready = false;
            log.info('Cloud is not ready');
            // TODO: some logic to clean up resources
        }
    }
    return true;
}

// Register a private scope service to listen to cloud connector life cycle events
platform.register(CLOUD_MONITOR, lifeCycleListener, true);
platform.subscribeLifeCycle(CLOUD_MONITOR);

// Connect to the cloud via language connector
connector.connectToCloud();
