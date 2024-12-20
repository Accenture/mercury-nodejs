
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

let platform: Platform;

export class EventApiService implements Composable { 

    name = EVENT_API_SERVICE;
    
    constructor() {
        platform = Platform.getInstance();
    }

    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
    }

    async handleEvent(evt: EventEnvelope) {
        const payload = evt.getBody();
        if (payload && payload.constructor == Object) {
            const req = new AsyncHttpRequest(evt.getBody() as object);
            const timeout = Math.max(100, util.str2int(req.getHeader('X-TTL')));
            const async = 'true' == req.getHeader('X-Async');
            const data = req.getBody();
            if (data.constructor == Buffer || data.constructor == Uint8Array) {
                const request = new EventEnvelope(data as Buffer);
                const sessionInfo = req.getSession();
                // Propagate session information from authentication service
                Object.keys(sessionInfo).forEach(k => {
                    request.setHeader(k, sessionInfo[k]);
                });
                const target = request.getTo();
                if (target) {
                    if (po.exists(target)) {
                        if (platform.isPrivate(target)) {
                            return EventApiService.eventApiError(403, `Route ${target} is private`);
                        }
                        if (async) {
                            po.send(request);
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
                                return EventApiService.eventApiError(e instanceof AppException? e.getStatus() : 500, e.message);
                            }
                                                                   
                        }
                    } else {
                        return EventApiService.eventApiError(400, `Route ${target} not found`);
                    }
                } else {
                    return EventApiService.eventApiError(400, 'Missing routing path');
                }
            }   
        }
        return EventApiService.eventApiError(400, 'Invalid request');
    }
    
    static eventApiError(status: number, message: string): EventEnvelope {
        const result = new EventEnvelope().setStatus(status).setBody(message);
        return new EventEnvelope()
                    .setStatus(status)
                    .setHeader(CONTENT_TYPE, APPLICATION_OCTET_STREAM)
                    .setBody(result.toBytes());
    }
}