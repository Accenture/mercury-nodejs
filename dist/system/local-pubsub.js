import { PostOffice } from './post-office.js';
import { Platform } from './platform.js';
import { Logger } from '../util/logger.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { Utility } from '../util/utility.js';
const log = new Logger();
let platform = null;
const util = new Utility();
const topics = new Map();
async function publisher(evt) {
    const po = new PostOffice(evt.getHeaders());
    const myTopic = evt.getHeader('my_route');
    const members = topics.get(myTopic);
    if (members && members.length > 0) {
        members.forEach(m => {
            if (po.exists(m)) {
                po.send(new EventEnvelope(evt).setTo(m));
            }
        });
    }
}
export class LocalPubSub {
    constructor() {
        if (Platform.initialized()) {
            platform = new Platform();
        }
        else {
            throw new Error('Please load platform class before using PubSub');
        }
    }
    createTopic(topic) {
        if (!util.validRouteName(topic)) {
            throw new Error('Invalid topic name - use 0-9, a-z, period, hyphen or underscore characters');
        }
        if (!topics.has(topic)) {
            topics.set(topic, []);
            log.info(`Topic ${topic} created`);
        }
        platform.register(topic, publisher, true, 1, true);
    }
    deleteTopic(topic) {
        if (topic && topic.length > 0) {
            if (topics.has(topic)) {
                platform.release(topic);
                topics.delete(topic);
                log.info(`Topic ${topic} deleted`);
            }
        }
    }
    getTopics() {
        return Array.from(topics.keys());
    }
    topicExists(topic) {
        return topic && topics.has(topic);
    }
    getSubscribers(topic) {
        return this.topicExists(topic) ? topics.get(topic) : [];
    }
    subscribe(topic, memberRoute) {
        if (!util.validRouteName(topic)) {
            throw new Error('Invalid topic name');
        }
        if (!util.validRouteName(memberRoute)) {
            throw new Error('Invalid member route');
        }
        if (this.topicExists(topic)) {
            const members = topics.get(topic);
            if (members.includes(memberRoute)) {
                log.warn(`${memberRoute} already subscribed to ${topic}`);
                return false;
            }
            else {
                members.push(memberRoute);
                topics.set(topic, members);
                log.info(`${memberRoute} subscribed to ${topic}`);
                return true;
            }
        }
        else {
            throw new Error(`Topic ${topic} does not exist`);
        }
    }
    unsubscribe(topic, memberRoute) {
        if (this.topicExists(topic)) {
            const members = topics.get(topic);
            if (members.includes(memberRoute)) {
                topics.set(topic, members.filter(m => m != memberRoute));
                log.info(`${memberRoute} unsubscribed from ${topic}`);
            }
        }
    }
}
//# sourceMappingURL=local-pubsub.js.map