import { PostOffice } from '../system/post-office.js';
import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';

const TEMPORARY_INBOX = 'temporary.inbox';
const DISTRIBUTED_TRACING = 'distributed.tracing';
// update ZERO_TRACING_FILTER if there are additional routes to filter out
const ASYNC_HTTP_CLIENT = "async.http.request";
const ZERO_TRACING_FILTER = [ASYNC_HTTP_CLIENT];
const RPC = "rpc";
const promises = {};
let po: PostOffice;

function trimOrigin(route: string): string {
    return route.includes("@")? route.substring(0, route.indexOf('@')) : route;
}

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class TemporaryInbox implements Composable {
    static routeName = TEMPORARY_INBOX;

    initialize(): Composable {
        if (po === undefined) {
            po = new PostOffice();
        }        
        return this;
    }

    static setPromise(cid: string, map: object): void {
        promises[cid] = map;
    }

    static clearPromise(cid: string): void {
        delete promises[cid];
    }

    async handleEvent(response: EventEnvelope) {
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
                const tracePath =  p['tracePath'];
                // clear promise and timer
                TemporaryInbox.clearPromise(cid);
                clearTimeout(timer);                
                if (response.isException()) {
                    reject(new AppException(response.getStatus(), String(response.getBody())));
                } else {
                    // remove some metadata
                    response.removeTag(RPC).setTo(null).setReplyTo(null).setTraceId(null).setTracePath(null);
                    const diff = parseFloat((performance.now() - start).toFixed(3));
                    response.setRoundTrip(diff);
                    // send tracing information if needed
                    if (traceId && tracePath) {
                        const to = trimOrigin(route);
                        if (!ZERO_TRACING_FILTER.includes(to)) {
                            const metrics = {'origin': po.getId(), 'id': traceId, 'path': tracePath, 
                                'service': to, 'start': utc, 'success': true, 
                                'exec_time': response.getExecTime(), 'round_trip': diff};
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
                            const trace = new EventEnvelope().setTo(DISTRIBUTED_TRACING).setBody({'trace': metrics});
                            po.send(trace);
                        }
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
