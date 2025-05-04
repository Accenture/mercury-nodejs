import { __decorate } from "tslib";
import { EventEnvelope } from '../models/event-envelope.js';
import { preload } from '../models/composable.js';
import { PostOffice } from '../system/post-office.js';
import { Utility } from '../util/utility.js';
const util = new Utility();
export class ResilienceHandler {
    initialize() {
        return this;
    }
    async handleEvent(event) {
        if (event.getBody() instanceof Object && event.getReplyTo() && event.getCorrelationId()) {
            const po = new PostOffice(event.getHeaders());
            const that = po.getMyClass();
            const input = event.getBody();
            let cumulative = Math.max(0, 'cumulative' in input ? util.str2int(String(input['cumulative'])) : 0);
            const now = new Date().getTime();
            const result = {};
            // Still in the backoff period?
            if ('backoff' in input) {
                const lastBackoff = util.str2int(String(input['backoff']));
                if (now < lastBackoff) {
                    // tell the system to abort the request and execute the second one in the next task list                
                    const diff = Math.max(1, parseInt(String((lastBackoff - now) / 1000)));
                    const waitPeriod = diff + (diff == 1 ? " second" : " seconds");
                    result['decision'] = 2;
                    result['status'] = 503;
                    result['message'] = "Service temporarily not available - please try again in " + waitPeriod;
                    result['backoff'] = lastBackoff;
                    that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), result, 0);
                    return false;
                }
                else {
                    // reset cumulative counter because backoff period has ended
                    cumulative = 0;
                }
            }
            // Not in backoff period - evaluate condition for retry, abort or alternative path
            const status = Math.max(200, 'status' in input ? util.str2int(String(input['status'])) : 200);
            // When backoff feature is used, you must put the resilient handler as a gatekeeper to the user function.
            // If status code is 200, it should execute the user function immediately.
            if (status == 200) {
                result['decision'] = 1;
                result['cumulative'] = cumulative;
                that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), result, 0);
                return true;
            }
            // Needs to trigger backoff?
            if ('backoff_trigger' in input && 'backoff_seconds' in input) {
                const backoffTrigger = Math.max(1, 'backoff_trigger' in input ? util.str2int(String(input['backoff_trigger'])) : 1);
                const backoffSeconds = Math.max(1, 'backoff_trigger' in input ? util.str2int(String(input['backoff_seconds'])) : 1);
                cumulative++;
                if (cumulative > backoffTrigger) {
                    // trigger backoff
                    const waitPeriod = backoffSeconds + (backoffSeconds == 1 ? " second" : " seconds");
                    result['decision'] = 2;
                    result['status'] = 503;
                    result['message'] = "Service temporarily not available - please try again in " + waitPeriod;
                    result['backoff'] = now + backoffSeconds * 1000;
                    that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), result, 0);
                    return false;
                }
            }
            let routing;
            if ('alternative' in input) {
                routing = new AlternativePath(String(input['alternative']));
            }
            const maxAttempt = Math.max(1, 'max_attempts' in input ? util.str2int(String(input['max_attempts'])) : 1);
            let attemptCount = Math.max(0, 'attempt' in input ? util.str2int(String(input['attempt'])) : 0);
            let delay = Math.max(10, 'delay' in input ? util.str2int(String(input['delay'])) : 10);
            // increment attempts
            attemptCount++;
            result['attempt'] = attemptCount;
            result['cumulative'] = cumulative;
            if (attemptCount > maxAttempt) {
                delay = 0;
                const message = 'message' in input ? String(input['message']) : 'Runtime exception';
                // tell the system to abort the request by executing the 2nd task
                result['decision'] = 2;
                result['status'] = status;
                result['message'] = message;
            }
            else {
                if (attemptCount == 1) {
                    delay = 0;
                }
                if (routing != null && routing.needReroute(status)) {
                    // tell the system to execute the alternative execution path
                    result['decision'] = 3;
                }
                else {
                    // otherwise, retry the original task
                    result['decision'] = 1;
                }
            }
            that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), result, delay);
        }
        return true;
    }
    sendResult(po, replyTo, cid, result, delay) {
        const response = new EventEnvelope().setTo(replyTo).setCorrelationId(cid).setBody(result);
        if (delay > 0) {
            po.sendLater(response, delay);
        }
        else {
            po.send(response);
        }
    }
}
__decorate([
    preload('resilience.handler', 100, true, true)
], ResilienceHandler.prototype, "initialize", null);
class AlternativePath {
    statusCodes = new Array();
    statusRanges = new Array();
    constructor(codes) {
        const list = util.split(codes, ",");
        for (const item of list) {
            const s = item.trim();
            if (s.includes("-")) {
                const idx = s.indexOf('-');
                const n1 = util.str2int(s.substring(0, idx).trim());
                const n2 = util.str2int(s.substring(idx + 1).trim());
                if (n1 > 200 && n2 > 200) {
                    const range = new Array();
                    if (n2 > n1) {
                        range.push(n1);
                        range.push(n2);
                    }
                    else {
                        range.push(n2);
                        range.push(n1);
                    }
                    this.statusRanges.push(range);
                }
            }
            else {
                const rc = util.str2int(s);
                if (rc > 200) {
                    this.statusCodes.push(rc);
                }
            }
        }
    }
    needReroute(status) {
        for (const i of this.statusCodes) {
            if (i == status) {
                return true;
            }
        }
        for (const range of this.statusRanges) {
            if (status >= range[0] && status <= range[1]) {
                return true;
            }
        }
        return false;
    }
}
//# sourceMappingURL=resilience-handler.js.map