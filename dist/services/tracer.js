import { Logger } from '../util/logger.js';
import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
const log = Logger.getInstance();
const po = new PostOffice();
const DISTRIBUTED_TRACING = 'distributed.tracing';
const DISTRIBUTED_TRACE_FORWARDER = 'distributed.trace.forwarder';
const TRACE = 'trace';
const SERVICE = 'service';
export class DistributedTrace {
    name = DISTRIBUTED_TRACING;
    initialize() {
        // no-op
    }
    getName() {
        return this.name;
    }
    async handleEvent(evt) {
        const body = evt.getBody();
        if (body && body.constructor == Object) {
            const payload = body;
            if (payload && TRACE in payload) {
                const metrics = payload[TRACE];
                const routeName = metrics[SERVICE];
                // ignore tracing for "distributed.tracing" and "distributed.trace.forwarder"
                if (DISTRIBUTED_TRACING != routeName && DISTRIBUTED_TRACE_FORWARDER != routeName) {
                    log.info(body);
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
//# sourceMappingURL=tracer.js.map