import { Logger } from '../util/logger.js';
import { PostOffice } from '../system/post-office.js';
import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';

const log = Logger.getInstance();
const po = new PostOffice();
const DISTRIBUTED_TRACING = 'distributed.tracing';
const DISTRIBUTED_TRACE_FORWARDER = 'distributed.trace.forwarder';
const TRACE = 'trace';
const SERVICE = 'service';

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class DistributedTrace implements Composable {
    static name = DISTRIBUTED_TRACING;

    initialize(): Composable {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        const body = evt.getBody();
        if (body && body.constructor == Object) {
            const payload = body as object;
            if (payload && TRACE in payload) {
                const metrics = payload[TRACE] as object;
                const exception = metrics['exception'];
                // for security reason, encoded binary data is removed
                if (exception instanceof Buffer) {
                    metrics['exception'] = '***';
                }
                const routeName = metrics[SERVICE];
                // ignore tracing for "distributed.tracing" and "distributed.trace.forwarder"
                if (DISTRIBUTED_TRACING != routeName && DISTRIBUTED_TRACE_FORWARDER != routeName) {
                    log.always(payload);
                    if (po.exists(DISTRIBUTED_TRACE_FORWARDER)) {
                        const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACE_FORWARDER).setBody(payload);
                        await po.send(trace);
                    }
                }
            }
        }
        return null;
    }
}
