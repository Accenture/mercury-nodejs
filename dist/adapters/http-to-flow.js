import { EventEnvelope } from '../models/event-envelope.js';
import { PostOffice } from '../system/post-office.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { AppException } from '../models/app-exception.js';
import { FlowExecutor } from './flow-executor.js';
import { Utility } from '../util/utility.js';
const util = new Utility();
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class HttpToFlow {
    initialize() {
        return this;
    }
    async handleEvent(evt) {
        const cid = evt.getCorrelationId() ? evt.getCorrelationId() : util.getUuid();
        const po = new PostOffice(evt.getHeaders());
        const self = po.getMyClass();
        try {
            await self.processRequest(po, evt, cid);
        }
        catch (e) {
            if (evt.getReplyTo()) {
                const status = e instanceof AppException ? e.getStatus() : 500;
                const message = e instanceof AppException ? e.getMessage() : e.message;
                const result = { 'status': status, 'message': message, 'type': 'error' };
                const error = new EventEnvelope().setTo(evt.getReplyTo());
                error.setCorrelationId(cid).setStatus(status).setBody(result);
                await po.send(error);
            }
        }
        return null;
    }
    async processRequest(po, evt, cid) {
        const payload = evt.getBody();
        if (payload && payload instanceof Object) {
            // interpret the incoming HTTP request
            const request = new AsyncHttpRequest(payload);
            if (request) {
                const flowId = request.getHeader('x-flow-id');
                if (!flowId) {
                    throw new AppException(400, 'Missing x-flow-id in HTTP request headers');
                }
                const dataset = {};
                dataset['header'] = request.getHeaders();
                dataset['body'] = request.getBody();
                dataset['cookie'] = request.getCookies();
                dataset['path_parameter'] = request.getPathParameters();
                dataset['method'] = request.getMethod();
                dataset['uri'] = request.getUrl();
                dataset['query'] = request.getQueryParameters();
                dataset['stream'] = request.getStreamRoute();
                dataset['ip'] = request.getRemoteIp();
                dataset['filename'] = request.getFileName();
                dataset['session'] = request.getSession();
                await FlowExecutor.getInstance().launch(po, flowId, dataset, cid, evt.getReplyTo());
            }
        }
    }
}
//# sourceMappingURL=http-to-flow.js.map