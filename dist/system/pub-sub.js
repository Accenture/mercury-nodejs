import { Logger } from '../util/logger.js';
import { PO } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
const log = new Logger().getInstance();
const po = new PO().getInstance();
const PUB_SUB = 'pub.sub.controller';
const TYPE = 'type';
const DOMAIN = 'domain';
const TOPIC = 'topic';
const PARTITION = 'partition';
const ROUTE = 'route';
let self = null;
export class PubSub {
    constructor(domain = 'system') {
        if (self == null) {
            self = new PS(domain);
        }
    }
    getInstance() {
        return self;
    }
}
class PS {
    constructor(domain) {
        this.subscription = new Map();
        self = this;
        const v = domain.trim();
        self.domain = v.length == 0 ? 'system' : v;
    }
    /**
     * Check if pub/sub feature is supported
     *
     * @returns true or false
     */
    async featureEnabled() {
        const result = await po.request(new EventEnvelope().setTo(PUB_SUB)
            .setHeader(TYPE, 'feature').setHeader(DOMAIN, self.domain), 10000);
        return result.getBody();
    }
    /**
     * Retrieve the list of topics
     *
     * @returns list of topics
     */
    async listTopics() {
        const result = await po.request(new EventEnvelope().setTo(PUB_SUB)
            .setHeader(TYPE, 'list').setHeader(DOMAIN, self.domain), 10000);
        return result.getBody();
    }
    /**
     * Check if a topic exists
     *
     * @param topic in the network event stream system
     * @returns true or false
     */
    async exists(topic) {
        const result = await po.request(new EventEnvelope().setTo(PUB_SUB).setHeader(TOPIC, topic)
            .setHeader(TYPE, 'exists').setHeader(DOMAIN, self.domain), 10000);
        return result.getBody();
    }
    /**
     * Create a topic with a given number of partitions
     * (Note that only journaled network event stream system like Kafka and Event Hubs support
     *  partitioning)
     *
     * @param topic in the network event stream system
     * @param partition Optional number of partitions to be created. Default -1 to disable the partitioning feature
     * @returns true or false
     */
    async createTopic(topic, partition = -1) {
        const result = await po.request(new EventEnvelope().setTo(PUB_SUB)
            .setHeader(TOPIC, topic).setHeader(PARTITION, String(partition))
            .setHeader(TYPE, 'create').setHeader(DOMAIN, self.domain), 10000);
        return result.getBody();
    }
    /**
     * Retrieve the number of partitions for a topic
     *
     * @param topic in the network event stream system
     * @returns number of partitions if any. Otherwise -1
     */
    async partitionCount(topic) {
        const result = await po.request(new EventEnvelope().setTo(PUB_SUB).setHeader(TOPIC, topic)
            .setHeader(TYPE, 'partition_count').setHeader(DOMAIN, self.domain), 10000);
        return result.getBody();
    }
    /**
     * Delete a topic
     * (IMPORTANT: do not delete a topic if the topic has subscribers. The underlying network event stream
     *  system may crash if you do that. Topic administration is usually done by DevSecOps.)
     *
     * @param topic in the network event stream system
     * @returns true or false
     */
    async deleteTopic(topic) {
        const result = await po.request(new EventEnvelope().setTo(PUB_SUB).setHeader(TOPIC, topic)
            .setHeader(TYPE, 'delete').setHeader(DOMAIN, self.domain), 10000);
        return result.getBody();
    }
    /**
     * Publish an event
     * (If it is a journaled network event stream system, this will publish the event randomly to any
     *  available partition)
     *
     * @param topic in the network event stream system
     * @param headers of the event, optional
     * @param body of the event
     * @returns true or false
     */
    async publish(topic, headers, body) {
        return self.publishToPartition(topic, -1, headers, body);
    }
    /**
     * Publish an event to a specific partition
     *
     * @param topic in the network event stream system
     * @param partition number of the topic
     * @param headers of the event, optional
     * @param body of the event
     * @returns true or false
     */
    async publishToPartition(topic, partition, headers, body) {
        const payload = { 'body': body, 'headers': headers };
        let result = null;
        if (partition < 0) {
            result = await po.request(new EventEnvelope().setTo(PUB_SUB).setHeader(TOPIC, topic)
                .setHeader(TYPE, 'publish').setHeader(DOMAIN, self.domain).setBody(payload), 10000);
        }
        else {
            result = await po.request(new EventEnvelope().setTo(PUB_SUB)
                .setHeader(TOPIC, topic).setHeader(PARTITION, String(partition))
                .setHeader(TYPE, 'publish').setHeader(DOMAIN, self.domain).setBody(payload), 10000);
        }
        return result.getBody();
    }
    /**
     * Subscribe to a topic with a listener service route
     *
     * @param topic in the network event stream system
     * @param route of your service that listens to the incoming events
     * @param parameters required if the target network event stream system is journaled
     * @returns true or false
     */
    async subscribe(topic, route, parameters) {
        return self.subscribeToPartition(topic, -1, route, parameters);
    }
    /**
     * Subscribe to a topic and a specific partition with a listener service route
     *
     * @param topic in the network event stream system
     * @param partition number of the topic
     * @param route of your service that listens to the incoming events
     * @param parameters required if the target network event stream system is journaled
     * @returns true or false
     */
    async subscribeToPartition(topic, partition, route, parameters) {
        if (topic == route) {
            throw new AppException(400, 'pub/sub topic name must be different from the subscriber function route name');
        }
        if (!po.exists(route)) {
            throw new AppException(400, `Unable to subscribe topic  ${topic} because route ${route} not registered`);
        }
        const prevMap = self.subscription.has(topic) ? self.subscription.get(topic) : {};
        if (route in prevMap) {
            throw new AppException(400, `Route ${route} has already subscribed to topic ${topic}`);
        }
        let result = null;
        if (partition < 0) {
            result = await po.request(new EventEnvelope().setTo(PUB_SUB).setHeader(TOPIC, topic)
                .setHeader(ROUTE, route).setBody(parameters)
                .setHeader(TYPE, 'subscribe').setHeader(DOMAIN, self.domain), 10000);
        }
        else {
            result = await po.request(new EventEnvelope().setTo(PUB_SUB)
                .setHeader(ROUTE, route).setBody(parameters)
                .setHeader(TOPIC, topic).setHeader(PARTITION, String(partition))
                .setHeader(TYPE, 'subscribe').setHeader(DOMAIN, self.domain), 10000);
        }
        if (result.getBody()) {
            if (!self.subscription.has(topic)) {
                self.subscription.set(topic, {});
                log.info(`Subscribed topic ${topic}`);
            }
            const routeMap = self.subscription.get(topic);
            if (!(route in routeMap)) {
                routeMap[route] = { 'parameters': parameters, 'partition': partition };
                if (partition < 0) {
                    log.info(`Attach ${route} to topic ${topic}`);
                }
                else {
                    log.info(`Attach ${route} to topic ${topic} partition ${partition}`);
                }
            }
            return true;
        }
        else {
            return false;
        }
    }
    /**
     * Unsubscribe your service route from a topic
     *
     * @param topic required if the target network event stream system is journale
     * @param route of your service that listens to the incoming events
     * @returns true or false
     */
    async unsubscribe(topic, route) {
        if (!po.exists(route)) {
            throw new AppException(400, `Unable to unsubscribe topic ${topic} because route ${route} not registered`);
        }
        const routeMap = self.subscription.has(topic) ? self.subscription.get(topic) : {};
        if (!(route in routeMap)) {
            throw new AppException(400, `Route ${route} was not subscribed to topic ${topic}`);
        }
        delete routeMap[route];
        log.info(`Detach ${route} from topic ${topic}`);
        if (Object.keys(routeMap).length == 0) {
            self.subscription.delete(topic);
            log.info(`Unsubscribed topic ${topic}`);
        }
        if (po.isReady()) {
            try {
                const result = await po.request(new EventEnvelope().setTo(PUB_SUB)
                    .setHeader(TOPIC, topic).setHeader(ROUTE, route)
                    .setHeader(TYPE, 'unsubscribe').setHeader(DOMAIN, self.domain), 10000);
                return result.getBody();
            }
            catch (e) {
                log.error(`Unable to unsubscribe ${route} from topic ${topic} - ${e.message}`);
                return false;
            }
        }
        else {
            log.warn('Subscription is ignored because cloud connection is not ready');
            return false;
        }
    }
}
//# sourceMappingURL=pub-sub.js.map