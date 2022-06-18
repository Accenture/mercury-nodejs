import { Logger } from '../util/logger.js';
import { Platform } from '../system/platform.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { PubSub } from '../system/pub-sub.js';
// Import and start worker thread in the background
import { Connector } from '../cloud/connector.js';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();
const ps = new PubSub().getInstance();

const MY_HELLO_WORLD = 'hello.world';
const CLOUD_MONITOR = "connector.event.listener";

// Register and announce that 'hello.world' service is available as this function with EventEnvelope as input
platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
    log.info('GOT headers='+JSON.stringify(evt.getHeaders())+', body='+JSON.stringify(evt.getBody()));
    return evt.getBody();
});

async function lifeCycleListener(evt: EventEnvelope) {
    const headers = evt.getHeaders();
    log.info('Connector life cycle event: '+JSON.stringify(headers));
    if ('ready' == headers['type']) {
        log.info('Cloud is ready');
        await subscribeToTopic();
    }
    if ('disconnected' == headers['type']) {
        log.info('Cloud is not ready');    
        await ps.unsubscribe('hello.topic', MY_HELLO_WORLD).catch((e) => log.info(e.message)); 
    }
    return true;
}

async function subscribeToTopic() {
    if (await ps.featureEnabled()) {
        try {
            await ps.createTopic('hello.topic');
            const count = await ps.partitionCount('hello.topic');
            log.info('topic hello.topic has ' + count + ' partitions');
            await ps.subscribe('hello.topic', MY_HELLO_WORLD, ["client1", "group1"]);

        } catch (e) {
            log.error('Pub/Sub failed - ' + e.message);
        }

    } else {
        log.info('Pub/Sub feature is not available from the underlying event stream');
        log.info('Did you start the language connector with cloud.connector=Kafka or cloud.services=kafka.pubsub?');
        log.warn('e.g. java -Dcloud.connector=kafka -Dcloud.services=kafka.reporter -jar language-connector.jar');
        platform.stop();
    }
}

// Register a private scope service to listen to cloud connector life cycle events
platform.register(CLOUD_MONITOR, lifeCycleListener, true);
platform.subscribeLifeCycle(CLOUD_MONITOR);

// Connect to the cloud via language connector
connector.connectToCloud();
