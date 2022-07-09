import { EventEnvelope } from '../models/event-envelope.js';
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
export declare function forwarder(event: EventEnvelope): Promise<unknown>;
