
import { Utility } from '../util/utility.js';
import { Platform } from '../system/platform.js';
import { PostOffice } from '../system/post-office.js';
import { Composable } from '../models/composable.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { AppException } from '../models/app-exception.js';

const util = new Utility();
const po = new PostOffice();

const CONTENT_TYPE = "Content-Type";
const APPLICATION_OCTET_STREAM = "application/octet-stream";
const EVENT_API_SERVICE = 'event.api.service';

function eventApiError(status: number, message: string): EventEnvelope {
    const result = new EventEnvelope().setStatus(status).setBody(message);
    return new EventEnvelope()
                .setStatus(status)
                .setHeader(CONTENT_TYPE, APPLICATION_OCTET_STREAM)
                .setBody(result.toBytes());
}

async function relayRequest(request: EventEnvelope, timeout: number, isAsync: boolean) {
    const target = request.getTo();
    if (po.exists(target)) {
        if (Platform.getInstance().isPrivate(target)) {
            return eventApiError(403, `Route ${target} is private`);
        }
        if (isAsync) {
            await po.send(request);
            const ack = {type: 'async', delivered: true, time: new Date().toISOString()};
            const res = new EventEnvelope().setBody(ack);
            return new EventEnvelope()
                        .setStatus(202)
                        .setHeader(CONTENT_TYPE, APPLICATION_OCTET_STREAM)
                        .setBody(res.toBytes());
        } else {
            try {
                const result = await po.request(request, timeout);
                // encapsulate result into the response body
                return new EventEnvelope()
                            .setHeader(CONTENT_TYPE, APPLICATION_OCTET_STREAM)
                            .setBody(result.toBytes());
            } catch (e) {
                return eventApiError(e instanceof AppException? e.getStatus() : 500, e.message);
            }                                                                   
        }
    } else {
        return eventApiError(400, `Route ${target} not found`);
    }   
}

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class EventApiService implements Composable { 
    static readonly routeName = EVENT_API_SERVICE;

    initialize(): Composable {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        const payload = evt.getBody();
        if (payload && payload.constructor == Object) {
            const req = new AsyncHttpRequest(evt.getBody() as object);
            const timeout = Math.max(100, util.str2int(req.getHeader('X-TTL')));
            const isAsync = 'true' == req.getHeader('X-Async');
            const data = req.getBody();
            if (data.constructor == Buffer || data.constructor == Uint8Array) {
                const request = new EventEnvelope(data as Buffer);
                const sessionInfo = req.getSession();
                // Propagate session information from authentication service
                Object.keys(sessionInfo).forEach(k => {
                    request.setHeader(k, sessionInfo[k]);
                });
                return request.getTo()? relayRequest(request, timeout, isAsync) : eventApiError(400, 'Missing routing path');
            }   
        }
        return eventApiError(400, 'Invalid request');
    }
}
