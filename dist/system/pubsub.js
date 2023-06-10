import { PostOffice } from '../system/post-office.js';
import { Platform } from '../system/platform.js';
import { Logger } from '../util/logger.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { Utility } from '../util/utility.js';
const log = new Logger();
let platform = null;
const postOffice = new PostOffice();
const util = new Utility();
const topics = new Map();
async function publisher(evt) {
    const po = new PostOffice(evt.getHeaders());
    const myTopic = evt.getHeader('my_route');
    const members = topics.get(myTopic);
    if (members && members.length > 0) {
        members.forEach(m => {
            po.send(new EventEnvelope(evt).setTo(m));
        });
    }
}
export class PubSub {
    constructor() {
        if (Platform.initialized()) {
            platform = new Platform();
        }
        else {
            throw new Error('Please load platform class before using PubSub');
        }
    }
    createTopic(topic) {
        if (topic && topic.length > 0) {
            if (!util.validRouteName(topic)) {
                throw new Error('Invalid topic name - use 0-9, a-z, period, hyphen or underscore characters');
            }
            if (!topics.has(topic)) {
                topics.set(topic, []);
                log.info(`Topic ${topic} created`);
                platform.register(topic, publisher, true, 1, true);
            }
        }
        else {
            throw new Error('Missing topic');
        }
    }
    deleteTopic(topic) {
        if (topic && topic.length > 0) {
            if (topics.has(topic)) {
                platform.release(topic);
                topics.delete(topic);
            }
        }
    }
    getTopics() {
        return Array.from(topics.keys());
    }
    getSubscribers(topic) {
        return topic && topic.length > 0 && topics.has(topic) ? topics.get(topic) : [];
    }
    subscribe(topic, memberRoute) {
        if (topic && topic.length > 0) {
            if (!topics.has(topic)) {
                throw new Error(`Topic ${topic} does not exist`);
            }
            if (memberRoute && postOffice.exists(memberRoute)) {
                const members = topics.get(topic);
                if (members.includes(memberRoute)) {
                    log.warn(`${memberRoute} already subscribed to topic ${topic}`);
                    return false;
                }
                members.push(memberRoute);
                topics.set(topic, members);
                log.info(`${memberRoute} subscribed to topic ${topic}`);
                return true;
            }
            else {
                throw new Error('Member route does not exist');
            }
        }
        else {
            throw new Error('Missing topic');
        }
    }
    unsubscribe(topic, memberRoute) {
        if (topics.has(topic)) {
            const members = topics.get(topic);
            if (members.includes(memberRoute)) {
                topics.set(topic, members.filter(m => m != memberRoute));
                log.info(`${memberRoute} unsubscribed from topic ${topic}`);
            }
        }
    }
}
//# sourceMappingURL=pubsub.js.map