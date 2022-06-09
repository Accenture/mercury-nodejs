import { Logger } from "../util/logger.js";
import { PO } from "../system/post-office.js";
import { Utility } from '../util/utility.js';
import { EventEnvelope } from '../models/event-envelope.js';

const log = new Logger().getInstance();
const po = new PO().getInstance();
const util = new Utility().getInstance();
// global map of all subscriptions
const subscription = new Map();

/**
 * This is a standard event listener that can be used to subscribe a route name for forwarding to a number of subscribers.
 * You can then send a subscribe request using 'type=subscribe' and 'route=recipientRoute' headers.
 * To unsubscribe from this forwarder, you can send a unsubsribe event using the 'type=unsubscribe' header.
 * 
 * To get a list of all subscribers, send a list event using the 'type=subscription' header.
 * 
 * Since the platform enforces 'exclusive consumer' pattern, this listener addresses the use case when you need
 * more than one subscriber to listen to the same route.
 * 
 * @param event to be forwarded
 * @returns future 'promise'
 */
export function forwarder(event: EventEnvelope) {
    return new Promise((resolve) => {
        const me = event.getTo();
        if (!subscription.has(me)) {
            subscription.set(me, new Map());
        }
        const recipients = subscription.get(me);
        if ('subscription' == event.getHeader('type')) {
            const list = [];
            for (const k of recipients.keys()) {
                list.push(k);
            }
            resolve(list);
        } else if ('subscribe' == event.getHeader('type') && event.getHeader('route')) {
            const subscriber = event.getHeader('route');
            if (recipients.has(subscriber)) {
                resolve(false);
            } else {
                recipients.set(subscriber, event.getHeader('permanent')? true : false);
                log.info(subscriber+' subscribed to '+me);
                resolve(true);
            }

        } else if ('unsubscribe' == event.getHeader('type') && event.getHeader('route')) {
            const subscriber = event.getHeader('route');
            if (recipients.has(subscriber)) {
                if (recipients.get(subscriber)) {
                    log.error('Cannot unsubscribe '+subscriber+' from '+me+' because it was set as a permanent subscriber');
                    resolve(false);
                } else {
                    recipients.delete(subscriber);
                    log.info(subscriber+' unsubscribed from '+me);
                    resolve(true);
                }

            } else {
                resolve(false);
            }

        } else {
            for (const k of recipients.keys()) {
                const forward = new EventEnvelope(event.toMap()).setId(util.getUuid());
                po.send(forward.setTo(k));
            }
            resolve(true);
        }
    });
}



