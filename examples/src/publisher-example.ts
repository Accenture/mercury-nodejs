import { Logger, Platform, Connector, EventEnvelope, PubSub } from 'mercury';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();
const ps = new PubSub().getInstance();

const CLOUD_MONITOR = "connector.event.listener";

async function lifeCycleListener(evt: EventEnvelope) {
    const headers = evt.getHeaders();
    log.info(`Connector life cycle event: ${JSON.stringify(headers)}`);
    if ('ready' == headers['type']) {
        log.info('Cloud is ready');
        await publishSomething();
        platform.stop();
    }
    if ('disconnected' == headers['type']) {
        log.info('Cloud is not ready');            
    }
    return true;
}

async function publishSomething() {
    if (await ps.featureEnabled()) {
        try {
            for (let i=0; i < 10; i++) {
                await publishOneItem(i);
            }
            return true;
        } catch (e) {
            log.error('Pub/Sub failed - ' + e.message);
        }

    } else {
        log.info('Pub/Sub feature is not available from the underlying event stream');
        log.info('Did you start the language connector with cloud.connector=Kafka or cloud.services=kafka.pubsub?');
        log.warn('e.g. java -Dcloud.connector=kafka -Dcloud.services=kafka.reporter -jar language-connector.jar');
        platform.stop();
    }
    return false;
}

async function publishOneItem(seq: number) {
    log.info(`sending ${seq}`);
    return ps.publish('hello.topic', {'some_parameter': 'some_value', 'n': seq}, 'hello node.js - ' + new Date().toISOString());
}

// Register a private scope service to listen to cloud connector life cycle events
platform.register(CLOUD_MONITOR, lifeCycleListener, true);
platform.subscribeLifeCycle(CLOUD_MONITOR);

// Connect to the cloud via language connector
connector.connectToCloud();