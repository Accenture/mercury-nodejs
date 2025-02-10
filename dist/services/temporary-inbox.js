import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
const TEMPORARY_INBOX = 'temporary.inbox';
const DISTRIBUTED_TRACING = 'distributed.tracing';
const RPC = "rpc";
const promises = {};
let po;
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class TemporaryInbox {
    static name = TEMPORARY_INBOX;
    initialize() {
        po = new PostOffice();
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
                    reject(new AppException(response.getStatus(), String(response.getBody())));
                }
                else {
                    // remove some metadata
                    response.removeTag(RPC).setTo(null).setReplyTo(null).setTraceId(null).setTracePath(null);
                    const diff = parseFloat((performance.now() - start).toFixed(3));
                    response.setRoundTrip(diff);
                    // send tracing information if needed
                    if (traceId && tracePath) {
                        const metrics = { 'origin': po.getId(), 'id': traceId, 'path': tracePath,
                            'service': route, 'start': utc, 'success': true,
                            'exec_time': response.getExecTime(), 'round_trip': diff };
                        if (from) {
                            metrics['from'] = from;
                        }
                        if (Object.keys(response.getAnnotations()).length > 0) {
                            metrics['annotations'] = response.getAnnotations();
                        }
                        if (response.getStatus() >= 400) {
                            metrics['success'] = false;
                            metrics['status'] = response.getStatus();
                            const error = response.getBody();
                            if (typeof error == 'string') {
                                metrics['exception'] = error;
                            }
                            else if (error instanceof Object) {
                                if ('message' in error) {
                                    metrics['exception'] = error['message'];
                                }
                                else {
                                    metrics['exception'] = error;
                                }
                            }
                            else {
                                metrics['exception'] = error ? error : 'null';
                            }
                        }
                        const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({ 'trace': metrics });
                        po.send(trace);
                    }
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
                    // restore original correlation ID and send response with promise's resolve function                    
                    resolve(response.setCorrelationId(oid));
                }
            }
        }
        return null;
    }
}
//# sourceMappingURL=temporary-inbox.js.map