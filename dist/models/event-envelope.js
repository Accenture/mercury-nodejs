import { unpack, pack } from 'msgpackr';
import { Utility } from '../util/utility.js';
const util = new Utility().getInstance();
function extraToKeyValues(extra) {
    const map = {};
    if (extra && extra.length > 0) {
        const list = extra.split('|').filter(v => v.length > 0);
        for (const kv of list) {
            const sep = kv.indexOf('=');
            if (sep != -1) {
                map[kv.substring(0, sep)] = kv.substring(sep + 1);
            }
            else {
                map[kv] = '';
            }
        }
    }
    return map;
}
function mapToString(map) {
    const keys = Object.keys(map);
    if (keys.length == 0) {
        return '';
    }
    let result = '';
    for (const k of keys) {
        result += k;
        const v = map[k];
        if (v && v.length > 0) {
            result += ('=' + v);
        }
        result += '|';
    }
    return result.substring(0, result.length - 1);
}
export class EventEnvelope {
    /**
     * Create a new EventEnvelope
     *
     * @param event - optional as a JSON object, Buffer or EventEnvelope
     */
    constructor(event) {
        this.id = 'js' + util.getUuid();
        this.headers = {};
        this.body = null;
        this.status = 200;
        if (event) {
            if (event.constructor == EventEnvelope) {
                this.clone(event);
            }
            if (event.constructor == Object) {
                this.fromMap(event);
            }
            if (event.constructor == Buffer || event.constructor == Uint8Array) {
                this.fromBytes(event);
            }
        }
    }
    /**
     * Override the original event ID
     *
     * @param id - unique UUID
     * @returns this
     */
    setId(id) {
        this.id = id;
        return this;
    }
    /**
     * Retrieve event ID
     *
     * @returns id
     */
    getId() {
        return this.id;
    }
    /**
     * This method is reserved by the system. DO NOT set this directly.
     *
     * @param evt - this must be the input EventEnvelope in your event listener
     * @returns this
     */
    setTrace(evt) {
        if (evt.traceId && evt.tracePath) {
            this.setTraceId(evt.traceId);
            this.setTracePath(evt.tracePath);
        }
        if (evt.to) {
            this.setFrom(evt.to);
        }
        return this;
    }
    /**
     * Set a header (aka parameter)
     *
     * @param k key
     * @param v value
     * @returns this
     */
    setHeader(k, v) {
        this.headers[k] = v;
        return this;
    }
    /**
     * Retrieve a header (aka parameter)
     *
     * @param k key
     * @returns value or null if not found
     */
    getHeader(k) {
        return k in this.headers ? this.headers[k] : null;
    }
    /**
     * Retrieve all headers / parameters
     *
     * @returns key-values
     */
    getHeaders() {
        return this.headers;
    }
    /**
     * Override existing headers / parameters
     *
     * @param headers to override
     * @returns this
     */
    setHeaders(headers) {
        this.headers = headers;
        return this;
    }
    /**
     * Set an optional payload for an event.
     * The payload can be string, number, JSON object, boolean or bytes
     *
     * @param body
     * @returns
     */
    setBody(body) {
        this.body = body;
        return this;
    }
    /**
     * Retrieve the payload if any
     *
     * @returns body (aka payload)
     */
    getBody() {
        return this.body;
    }
    /**
     * Set processing status code if you want to manually define the value.
     *
     * Note that status code should be compliant with the 3-digit numeric HTTP status code convention.
     * i.e. HTTP-2xx for success, HTTP-4xx for application related issues and HTTP-5xx for infrastructure failures.
     *
     * @param status code
     * @returns this
     */
    setStatus(status) {
        this.status = status;
        return this;
    }
    /**
     * Retrieve the event processing status.
     *
     * Note that status code should be compliant with the 3-digit numeric HTTP status code convention.
     * i.e. HTTP-2xx for success, HTTP-4xx for application related issues and HTTP-5xx for infrastructure failures.
     *
     * @returns status code
     */
    getStatus() {
        return this.status;
    }
    /**
     * This is used for routing purpose.
     * The "to" is a route name representing a target service / function.
     *
     * @param to destination route
     * @returns this
     */
    setTo(to) {
        this.to = to;
        return this;
    }
    /**
     * Retrieve the destination route
     *
     * @returns route name
     */
    getTo() {
        return this.to;
    }
    /**
     * Sender route name is where the event comes from
     *
     * @param sender of the event
     * @returns this
     */
    setFrom(sender) {
        this.sender = sender;
        return this;
    }
    /**
     * Retrieve sender route name of the event
     *
     * @returns sender
     */
    getFrom() {
        return this.sender;
    }
    /**
     * ReplyTo is used for routing purpose.
     *
     * @param replyTo route name if this event is used for RPC or callback
     * @returns this
     */
    setReplyTo(replyTo) {
        this.replyTo = replyTo;
        return this;
    }
    /**
     * Retrieve the route name for receiving the function return value
     *
     * @returns route name
     */
    getReplyTo() {
        return this.replyTo;
    }
    /**
     * This method is reserved by the system. DO NOT call this directly.
     *
     * @param extra is used for tagging an event
     * @returns this
     */
    setExtra(extra) {
        this.extra = extra;
        return this;
    }
    /**
     * Add a tag to an event. The language pack uses tags for routing purpose.
     *
     * This tagging system is designed for a small number of tags (less than 10).
     * DO NOT set more than 10 as this would reduce system performance.
     *
     * @param key - tag name
     * @param value - tag value
     * @returns this
     */
    addTag(key, value = '') {
        if (key && key.length > 0) {
            const map = extraToKeyValues(this.extra);
            map[key] = value;
            this.extra = mapToString(map);
        }
        return this;
    }
    /**
     * Remove a tag from an evvent
     *
     * @param key - tag name
     * @returns this
     */
    removeTag(key) {
        if (key && key.length > 0) {
            const map = extraToKeyValues(this.extra);
            delete map[key];
            this.extra = mapToString(map);
        }
        return this;
    }
    /**
     * Retrieve a tag
     *
     * @param key - tag name
     * @returns this
     */
    getTag(key) {
        return key && key.length > 0 ? extraToKeyValues(this.extra)[key] : null;
    }
    /**
     * Retrieve the string representation of all tags.
     * Each tag is separated by the vertical bar character '|'.
     *
     * @returns all tags
     */
    getExtra() {
        return this.extra;
    }
    /**
     * You may set a unique ID for tracking RPC or callback.
     *
     * @param correlationId for tracking
     * @returns this
     */
    setCorrelationId(correlationId) {
        this.correlationId = correlationId;
        return this;
    }
    /**
     * Retrieve the correlation ID of an event
     *
     * @returns correlation ID
     */
    getCorrelationId() {
        return this.correlationId;
    }
    /**
     * Set a trace ID to enable distributed trace.
     *
     * When using REST automation, the system will set a unique ID automatically
     * when tracing is turned on in the rest.yaml configuration file.
     *
     * Note that traceId and tracePath are used together.
     *
     * @param traceId of the event
     * @returns this
     */
    setTraceId(traceId) {
        this.traceId = traceId;
        return this;
    }
    /**
     * Retrieve trace ID of the event.
     *
     * @returns trace ID
     */
    getTraceId() {
        return this.traceId;
    }
    /**
     * Set a trace path to enable distributed trace.
     *
     * When using REST automation, the system will set the HTTP method and URI as the trace path automatically
     * when tracing is turned on in the rest.yaml configuration file.
     *
     * Note that traceId and tracePath are used together.
     *
     * @param tracePath of the event
     * @returns this
     */
    setTracePath(tracePath) {
        this.tracePath = tracePath;
        return this;
    }
    /**
     * Retrieve the trace path of an event
     *
     * @returns trace path
     */
    getTracePath() {
        return this.tracePath;
    }
    /**
     * When broadcast is turned on, the language connector will broadcast the event to all application container
     * instances that serve the target route
     *
     * @param broadcast indicator
     * @returns this
     */
    setBroadcast(broadcast) {
        this.broadcast = broadcast;
        return this;
    }
    /**
     * Check if this event is designated as broadcast
     *
     * @returns broadcast indicator
     */
    getBroadcast() {
        return this.broadcast;
    }
    /**
     * You can indicate that an event contains an exception message in the body
     *
     * @param exception indicator
     * @returns this
     */
    setException(exception = true) {
        if (exception) {
            this.addTag('exception');
        }
        else {
            this.removeTag('exception');
        }
        return this;
    }
    /**
     * Check if this event contains an exception message in the body
     *
     * @returns true or false
     */
    isException() {
        return this.getTag('exception') != null ? true : false;
    }
    /**
     * This method is reserved by the system. DO NOT call this directly.
     *
     * @param execTime of the function processing this event
     * @returns this
     */
    setExecTime(execTime) {
        this.execTime = execTime;
        return this;
    }
    /**
     * Retrieve execution time for the function that process this event
     *
     * @returns performance metrics
     */
    getExecTime() {
        return this.execTime;
    }
    /**
     * This method is reserved by the system. DO NOT call this directly.
     *
     * @param roundTrip end-to-end processing time
     * @returns this
     */
    setRoundTrip(roundTrip) {
        this.roundTrip = roundTrip;
        return this;
    }
    /**
     * Retrieve the end-to-end processing time
     *
     * @returns performance metrics
     */
    getRoundTrip() {
        return this.roundTrip;
    }
    /**
     * Convert this event into a JSON object
     *
     * @returns object
     */
    toMap() {
        const result = {};
        result['id'] = this.id;
        if (this.to != null) {
            result['to'] = this.to;
        }
        if (this.sender != null) {
            result['from'] = this.sender;
        }
        result['headers'] = this.headers instanceof Object ? this.headers : {};
        if (this.body != null) {
            result['body'] = this.body;
        }
        if (this.replyTo != null) {
            result['reply_to'] = this.replyTo;
        }
        if (this.extra != null) {
            result['extra'] = this.extra;
        }
        if (this.correlationId != null) {
            result['cid'] = this.correlationId;
        }
        if (this.traceId != null && this.tracePath != null) {
            result['trace_id'] = this.traceId;
            result['trace_path'] = this.tracePath;
        }
        if (this.broadcast) {
            result['broadcast'] = true;
        }
        result['status'] = this.getStatus();
        if (this.execTime) {
            result['exec_time'] = util.getFloat(this.execTime, 3);
        }
        if (this.roundTrip) {
            result['round_trip'] = util.getFloat(this.roundTrip, 3);
        }
        return result;
    }
    /**
     * Convert a JSON object into an event envelope.
     *
     * Note that the object must be compliant with the EventEnvelope interface contract.
     *
     * @param map input is a JSON object
     * @returns this
     */
    fromMap(map) {
        if ('id' in map) {
            this.id = map['id'];
        }
        if ('to' in map) {
            this.to = map['to'];
        }
        if ('from' in map) {
            this.sender = map['from'];
        }
        if ('headers' in map) {
            const headers = map['headers'];
            this.headers = headers instanceof Object ? headers : {};
        }
        if ('body' in map) {
            this.body = map['body'];
        }
        if ('reply_to' in map) {
            this.replyTo = map['reply_to'];
        }
        if ('extra' in map) {
            this.extra = map['extra'];
        }
        if ('cid' in map) {
            this.correlationId = map['cid'];
        }
        if ('trace_id' in map && 'trace_path' in map) {
            this.traceId = map['trace_id'];
            this.tracePath = map['trace_path'];
        }
        if ('status' in map) {
            this.status = map['status'];
        }
        if ('broadcast' in map) {
            this.broadcast = map['broadcast'] ? true : false;
        }
        if ('exec_time' in map) {
            this.execTime = util.getFloat(map['exec_time'], 3);
        }
        if ('round_trip' in map) {
            this.roundTrip = util.getFloat(map['round_trip'], 3);
        }
        return this;
    }
    /**
     * Convert this event into a byte array
     *
     * MsgPack (Binary JSON) is used as the transport protocol.
     *
     * @returns bytes
     */
    toBytes() {
        return pack(this.toMap());
    }
    /**
     * Convert a byte array into this event
     *
     * MsgPack (Binary JSON) is used as the transport protocol.
     *
     * @param b input is a byte array
     * @returns this
     */
    fromBytes(b) {
        this.fromMap(unpack(b));
        return this;
    }
    /**
     * Clone from an event
     *
     * @param event input
     * @returns this
     */
    clone(event) {
        this.to = event.to;
        this.sender = event.sender;
        this.headers = event.headers;
        this.body = event.body;
        this.replyTo = event.replyTo;
        this.extra = event.extra;
        this.correlationId = event.correlationId;
        this.traceId = event.traceId;
        this.tracePath = event.tracePath;
        this.status = event.status;
        this.broadcast = event.broadcast;
        this.execTime = event.execTime;
        this.roundTrip = event.roundTrip;
        return this;
    }
}
//# sourceMappingURL=event-envelope.js.map