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
            const po = new PostOffice(event);
            const that = po.getMyClass();
            const input = event.getBody();
            const md = new ResilienceMetadata();
            md.cumulative = Math.max(0, 'cumulative' in input ? util.getInteger(input['cumulative']) : 0);
            md.now = new Date().getTime();
            // Still in the backoff period?
            if ('backoff' in input && that.handleBackoff(po, md, input, that, event)) {
                return false;
            }
            // Not in backoff period - evaluate condition for retry, abort or alternative path
            const status = Math.max(200, 'status' in input ? util.getInteger(input['status']) : 200);
            // When backoff feature is used, you must put the resilient handler as a gatekeeper to the user function.
            // If status code is 200, it should execute the user function immediately.
            if (status == 200) {
                md.result['decision'] = 1;
                md.result['cumulative'] = md.cumulative;
                that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), md.result, 0);
                return true;
            }
            // Needs to trigger backoff?
            if ('backoff_trigger' in input && 'backoff_seconds' in input && that.triggerBackoff(po, md, input, that, event)) {
                return false;
            }
            that.makeDecision(po, md, input, that, event, status);
        }
        return true;
    }
    makeDecision(po, md, input, that, event, status) {
        let routing;
        if ('alternative' in input) {
            routing = new AlternativePath(util.getString(input['alternative']));
        }
        const maxAttempt = Math.max(1, 'max_attempts' in input ? util.getInteger(input['max_attempts']) : 1);
        let attemptCount = Math.max(0, 'attempt' in input ? util.getInteger(input['attempt']) : 0);
        let delay = Math.max(10, 'delay' in input ? util.getInteger(input['delay']) : 10);
        // increment attempts
        attemptCount++;
        md.result['attempt'] = attemptCount;
        md.result['cumulative'] = md.cumulative;
        if (attemptCount > maxAttempt) {
            delay = 0;
            const message = 'message' in input ? util.getString(input['message']) : 'Runtime exception';
            // tell the system to abort the request by executing the 2nd task
            md.result['decision'] = 2;
            md.result['status'] = status;
            md.result['message'] = message;
        }
        else {
            if (attemptCount == 1) {
                delay = 0;
            }
            if (routing?.needReroute(status)) {
                // tell the system to execute the alternative execution path
                md.result['decision'] = 3;
            }
            else {
                // otherwise, retry the original task
                md.result['decision'] = 1;
            }
        }
        that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), md.result, delay);
    }
    triggerBackoff(po, md, input, that, event) {
        const backoffTrigger = Math.max(1, 'backoff_trigger' in input ? util.getInteger(input['backoff_trigger']) : 1);
        const backoffSeconds = Math.max(1, 'backoff_trigger' in input ? util.getInteger(input['backoff_seconds']) : 1);
        md.cumulative++;
        if (md.cumulative > backoffTrigger) {
            // trigger backoff
            const waitPeriod = backoffSeconds + (backoffSeconds == 1 ? " second" : " seconds");
            md.result['decision'] = 2;
            md.result['status'] = 503;
            md.result['message'] = "Service temporarily not available - please try again in " + waitPeriod;
            md.result['backoff'] = md.now + backoffSeconds * 1000;
            that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), md.result, 0);
            return true;
        }
        else {
            return false;
        }
    }
    handleBackoff(po, md, input, that, event) {
        const lastBackoff = util.getInteger(input['backoff']);
        if (md.now < lastBackoff) {
            // tell the system to abort the request and execute the second one in the next task list                
            const diff = Math.max(1, parseInt(String((lastBackoff - md.now) / 1000)));
            const waitPeriod = diff + (diff == 1 ? " second" : " seconds");
            md.result['decision'] = 2;
            md.result['status'] = 503;
            md.result['message'] = "Service temporarily not available - please try again in " + waitPeriod;
            md.result['backoff'] = lastBackoff;
            that.sendResult(po, event.getReplyTo(), event.getCorrelationId(), md.result, 0);
            return true;
        }
        else {
            // reset cumulative counter because backoff period has ended
            md.cumulative = 0;
            return false;
        }
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
class ResilienceMetadata {
    result = {};
    cumulative;
    now;
}
class AlternativePath {
    statusCodes = new Array();
    statusRanges = new Array();
    constructor(codes) {
        const list = util.split(codes, ",");
        for (const item of list) {
            const s = item.trim();
            if (s.includes("-")) {
                const range = this.getRange(s);
                if (range) {
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
    getRange(item) {
        const idx = item.indexOf('-');
        const n1 = util.str2int(item.substring(0, idx).trim());
        const n2 = util.str2int(item.substring(idx + 1).trim());
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
            return range;
        }
        return null;
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