import { Logger } from '../util/logger.js';
import { PostOffice } from '../system/post-office.js';
import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';

const log = new Logger();
const po = new PostOffice();
const DISTRIBUTED_TRACING = 'distributed.tracing';
const DISTRIBUTED_TRACE_FORWARDER = 'distributed.trace.forwarder';
const TRACE = 'trace';
const SERVICE = 'service';

export class DistributedTrace implements Composable {
    
    name: string = DISTRIBUTED_TRACING;

    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
    }

    async handleEvent(evt: EventEnvelope) {
        const body = evt.getBody();
        if (body && body.constructor == Object) {
            const payload = body as object;
            if (payload && TRACE in payload) {
                const metrics = payload[TRACE] as object;
                const routeName = metrics[SERVICE];
                // ignore tracing for "distributed.tracing" and "distributed.trace.forwarder"
                if (DISTRIBUTED_TRACING != routeName && DISTRIBUTED_TRACE_FORWARDER != routeName) {
                    log.info(body as object);
                    if (po.exists(DISTRIBUTED_TRACE_FORWARDER)) {
                        const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACE_FORWARDER).setBody(payload);
                        po.send(trace);
                    }
                }
            }
        }
        return null;
    }

}