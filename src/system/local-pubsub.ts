import { Composable } from '../models/composable.js';
import { PostOffice } from './post-office.js';
import { Platform } from './platform.js';
import { Logger } from '../util/logger.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { Utility } from '../util/utility.js';

const log = Logger.getInstance();
let platform: Platform = null;
const util = new Utility();
const topics = new Map<string, Array<string>>();

class LocalPublisher implements Composable{
    initialize(): LocalPublisher { 
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
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
        return null;
    }
}

export class LocalPubSub {

    constructor() {
        if (!platform) {
            platform = Platform.getInstance();
        }
    }

    createTopic(topic: string): void {
        if (!util.validRouteName(topic)) {
            throw new Error('Invalid topic name - use 0-9, a-z, period, hyphen or underscore characters');
        }
        if (!topics.has(topic)) {
            topics.set(topic, []);
            log.info(`Topic ${topic} created`);
        }
        platform.register(topic, new LocalPublisher(), 1, true, true);
    }

    deleteTopic(topic: string): void {
        if (topic && topic.length > 0) {
            if (topics.has(topic)) {
                platform.release(topic);
                topics.delete(topic);
                log.info(`Topic ${topic} deleted`);
            }
        }
    }

    getTopics(): Array<string> {
        return Array.from(topics.keys());
    }

    topicExists(topic: string): boolean {
        return topic && topics.has(topic);
    }

    getSubscribers(topic: string): Array<string> {
        return this.topicExists(topic)? topics.get(topic) : [];
    }

    subscribe(topic: string, memberRoute: string): boolean {
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
            } else {
                members.push(memberRoute);
                topics.set(topic, members);
                log.info(`${memberRoute} subscribed to ${topic}`);
                return true;
            }
        } else {
            throw new Error(`Topic ${topic} does not exist`);
        }
    }

    unsubscribe(topic: string, memberRoute: string): void {
        if (this.topicExists(topic)) {
            const members = topics.get(topic);
            if (members.includes(memberRoute)) {
                topics.set(topic, members.filter(m => m != memberRoute));
                log.info(`${memberRoute} unsubscribed from ${topic}`);
            }
        }
    }
}