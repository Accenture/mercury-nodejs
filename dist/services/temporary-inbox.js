import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { Utility } from '../util/utility.js';
const TEMPORARY_INBOX = 'temporary.inbox';
const DISTRIBUTED_TRACING = 'distributed.tracing';
// update ZERO_TRACING_FILTER if there are additional routes to filter out
const ASYNC_HTTP_CLIENT = "async.http.request";
const ZERO_TRACING_FILTER = [ASYNC_HTTP_CLIENT];
const RPC = "rpc";
const promises = {};
const util = new Utility();
let po;
function trimOrigin(route) {
    return route.includes("@") ? route.substring(0, route.indexOf('@')) : route;
}
function sendTrace(response, route, utc, from, traceId, tracePath, diff) {
    const to = trimOrigin(route);
    if (!ZERO_TRACING_FILTER.includes(to)) {
        const metrics = { 'origin': po.getId(), 'id': traceId, 'path': tracePath,
            'service': to, 'start': utc, 'success': true,
            'exec_time': response.getExecTime(), 'round_trip': diff };
        if (from) {
            metrics['from'] = trimOrigin(from);
        }
        if (Object.keys(response.getAnnotations()).length > 0) {
            metrics['annotations'] = response.getAnnotations();
        }
        if (response.getStatus() >= 400) {
            metrics['success'] = false;
            metrics['status'] = response.getStatus();
            metrics['exception'] = response.getError();
        }
        const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
        po.send(trace);
    }
}
function updateResponse(response, diff) {
    // remove some metadata
    response.removeTag(RPC).setTo(null).setReplyTo(null).setTraceId(null).setTracePath(null);
    response.setRoundTrip(diff);
    // filter out protected metadata
    const headers = {};
    for (const h in response.getHeaders()) {
        if (h != 'my_route' && h != 'my_instance' && h != 'my_trace_id' && h != 'my_trace_path') {
            headers[h] = response.getHeader(h);
        }
    }
    response.setHeaders(headers);
    // remove annotations if any because annotations are used for tracing only
    response.clearAnnotations();
}
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class TemporaryInbox {
    static routeName = TEMPORARY_INBOX;
    initialize() {
        po ??= new PostOffice();
        return this;
    }
    static setPromise(cid, map) {
        promises[cid] = map;
    }
    static clearPromise(cid) {
        delete promises[cid];
    }
    async handleEvent(response) {
        const cid = response.getCorrelationId();
        if (cid) {
            const p = promises[cid];
            if (p && Object.keys(p).length > 0 && 'route' in p) {
                const timer = p['timer'];
                const resolve = p['resolve'];
                const reject = p['reject'];
                const route = p['route'];
                const from = p['from'];
                const oid = p['oid'];
                const utc = p['utc'];
                const start = p['start'];
                const traceId = p['traceId'];
                const tracePath = p['tracePath'];
                // clear promise and timer
                TemporaryInbox.clearPromise(cid);
                clearTimeout(timer);
                if (response.isException()) {
                    reject(new AppException(response.getStatus(), util.getString(response.getBody())));
                }
                else {
                    const diff = Math.max(0, parseFloat((performance.now() - start).toFixed(3)));
                    // send tracing information
                    if (traceId && tracePath) {
                        sendTrace(response, route, utc, from, traceId, tracePath, diff);
                    }
                    updateResponse(response, diff);
                    // restore original correlation ID and send response with promise's resolve function                    
                    resolve(response.setCorrelationId(oid));
                }
            }
        }
        return null;
    }
}
//# sourceMappingURL=temporary-inbox.js.map