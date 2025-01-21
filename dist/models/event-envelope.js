import { unpack, pack } from 'msgpackr';
import { Utility } from '../util/utility.js';
import { AppException } from './app-exception.js';
const util = new Utility();
// constants for binary serialization
const ID_FLAG = "0";
const EXECUTION_FLAG = "1";
const ROUND_TRIP_FLAG = "2";
const EXTRA_FLAG = "3";
// EXCEPTION_FLAG ("4") is reserved for Java exception
const STACK_FLAG = "5";
const TO_FLAG = "T";
const REPLY_TO_FLAG = "R";
const FROM_FLAG = "F";
const STATUS_FLAG = "S";
const HEADERS_FLAG = "H";
const BODY_FLAG = "B";
const TRACE_ID_FLAG = "t";
const TRACE_PATH_FLAG = "p";
const CID_FLAG = "X";
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
    id;
    headers = {};
    body;
    status;
    to;
    sender;
    replyTo;
    extra;
    stackTrace;
    correlationId;
    traceId;
    tracePath;
    execTime;
    roundTrip;
    /**
     * Create a new EventEnvelope
     *
     * @param event - optional as a JSON object, Buffer or EventEnvelope
     */
    constructor(event) {
        this.id = util.getUuid();
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
        return this.id ? this.id : null;
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
     * Retrieve a header value using case-insensitive key
     *
     * @param k key
     * @returns value or null if not found
     */
    getHeader(k) {
        if (k) {
            const lc = k.toLowerCase();
            for (const h in this.headers) {
                if (lc == h.toLowerCase()) {
                    return this.headers[h];
                }
            }
        }
        return null;
        // return k in this.headers? this.headers[k] : null;
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
        if (headers && headers.constructor == Object) {
            this.headers = headers;
        }
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
        return this.status ? this.status : 200;
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
        return this.to ? this.to : null;
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
        return this.sender ? this.sender : null;
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
        return this.replyTo ? this.replyTo : null;
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
    addTag(key, value = '_') {
        if (key && key.length > 0) {
            const map = extraToKeyValues(this.extra);
            map[key] = String(value);
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
        const result = key && key.length > 0 ? extraToKeyValues(this.extra)[key] : null;
        return result ? result : null;
    }
    /**
     * Retrieve the string representation of all tags.
     * Each tag is separated by the vertical bar character '|'.
     *
     * @returns all tags
     */
    getExtra() {
        return this.extra ? this.extra : '';
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
        return this.correlationId ? this.correlationId : null;
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
        return this.traceId ? this.traceId : null;
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
        return this.tracePath ? this.tracePath : null;
    }
    /**
     * Set exception status and message
     *
     * @param status code
     * @param error message
     * @returns this
     */
    setException(error) {
        this.setStatus(error instanceof AppException ? error.getStatus() : 500);
        if (error instanceof Error) {
            // user function must throw AppException or Error object
            // where AppException extends Error.
            this.setBody(error.message);
            const text = error.stack ? error.stack : error.message;
            // limit the depth of stack trace to 10 lines
            let result = '';
            const lines = util.split(text, '\r\n').map(k => k.trim());
            for (let i = 0; i < 10 && i < lines.length; i++) {
                result += lines[i];
                result += '\n';
            }
            if (lines.length > 10) {
                result += `...(${lines.length})\n`;
            }
            this.stackTrace = result;
        }
        else {
            // in case the user function throws something other than an Error object
            const message = String(error);
            this.setBody(message);
            this.stackTrace = message;
        }
        return this;
    }
    getStackTrace() {
        return this.stackTrace;
    }
    /**
     * Check if this event contains an exception
     *
     * @returns true or false
     */
    isException() {
        return this.stackTrace ? true : false;
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
        return this.execTime ? this.execTime : 0;
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
        if (this.id) {
            result['id'] = String(this.id);
        }
        if (this.to) {
            result['to'] = String(this.to);
        }
        if (this.sender) {
            result['from'] = String(this.sender);
        }
        result['headers'] = this.headers;
        if (this.body) {
            result['body'] = this.body;
        }
        if (this.replyTo) {
            result['reply_to'] = String(this.replyTo);
        }
        if (this.extra) {
            result['extra'] = String(this.extra);
        }
        if (this.correlationId) {
            result['cid'] = String(this.correlationId);
        }
        if (this.traceId) {
            result['trace_id'] = String(this.traceId);
        }
        if (this.tracePath) {
            result['trace_path'] = String(this.tracePath);
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
            this.id = String(map['id']);
        }
        if ('to' in map) {
            this.to = String(map['to']);
        }
        if ('from' in map) {
            this.sender = String(map['from']);
        }
        if ('headers' in map) {
            const headers = map['headers'];
            this.headers = headers && headers.constructor == Object ? headers : {};
        }
        if ('body' in map) {
            // "body" can be one of (string | number | object | boolean | Buffer | Uint8Array).
            // Casting to object for compilation only. It is irrelevant at run-time.
            this.body = map['body'];
        }
        if ('reply_to' in map) {
            this.replyTo = String(map['reply_to']);
        }
        if ('extra' in map) {
            this.extra = String(map['extra']);
        }
        if ('cid' in map) {
            this.correlationId = String(map['cid']);
        }
        if ('trace_id' in map) {
            this.traceId = String(map['trace_id']);
        }
        if ('trace_path' in map) {
            this.tracePath = String(map['trace_path']);
        }
        if ('status' in map) {
            this.status = parseInt(String(map['status']));
        }
        if ('exec_time' in map) {
            this.execTime = util.getFloat(parseFloat(String(map['exec_time'])), 3);
        }
        if ('round_trip' in map) {
            this.roundTrip = util.getFloat(parseFloat(String(map['round_trip'])), 3);
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
        const result = {};
        if (this.id) {
            result[ID_FLAG] = this.id;
        }
        if (this.to) {
            result[TO_FLAG] = String(this.to);
        }
        if (this.sender) {
            result[FROM_FLAG] = String(this.sender);
        }
        result[HEADERS_FLAG] = this.headers;
        if (this.body) {
            result[BODY_FLAG] = this.body;
        }
        if (this.replyTo) {
            result[REPLY_TO_FLAG] = this.replyTo;
        }
        if (this.extra) {
            result[EXTRA_FLAG] = this.extra;
        }
        if (this.stackTrace) {
            result[STACK_FLAG] = this.stackTrace;
        }
        if (this.correlationId) {
            result[CID_FLAG] = this.correlationId;
        }
        if (this.traceId) {
            result[TRACE_ID_FLAG] = this.traceId;
        }
        if (this.tracePath) {
            result[TRACE_PATH_FLAG] = this.tracePath;
        }
        result[STATUS_FLAG] = this.getStatus();
        if (this.execTime) {
            result[EXECUTION_FLAG] = util.getFloat(this.execTime, 3);
        }
        if (this.roundTrip) {
            result[ROUND_TRIP_FLAG] = util.getFloat(this.roundTrip, 3);
        }
        return pack(result);
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
        const o = unpack(b);
        if (o && o.constructor == Object) {
            const map = o;
            if (ID_FLAG in map) {
                this.id = String(map[ID_FLAG]);
            }
            if (TO_FLAG in map) {
                this.to = String(map[TO_FLAG]);
            }
            if (FROM_FLAG in map) {
                this.sender = String(map[FROM_FLAG]);
            }
            if (HEADERS_FLAG in map) {
                const headers = map[HEADERS_FLAG];
                this.headers = headers && headers.constructor == Object ? headers : {};
            }
            if (BODY_FLAG in map) {
                // "body" can be one of (string | number | object | boolean | Buffer | Uint8Array).
                // Casting to object for compilation only. It is irrelevant at run-time.
                this.body = map[BODY_FLAG];
            }
            if (REPLY_TO_FLAG in map) {
                this.replyTo = String(map[REPLY_TO_FLAG]);
            }
            if (EXTRA_FLAG in map) {
                this.extra = String(map[EXTRA_FLAG]);
            }
            if (STACK_FLAG in map) {
                this.stackTrace = String(map[STACK_FLAG]);
            }
            if (CID_FLAG in map) {
                this.correlationId = String(map[CID_FLAG]);
            }
            if (TRACE_ID_FLAG in map) {
                this.traceId = String(map[TRACE_ID_FLAG]);
            }
            if (TRACE_PATH_FLAG in map) {
                this.tracePath = String(map[TRACE_PATH_FLAG]);
            }
            if (STATUS_FLAG in map) {
                this.status = parseInt(String(map[STATUS_FLAG]));
            }
            if (EXECUTION_FLAG in map) {
                this.execTime = util.getFloat(parseFloat(String(map[EXECUTION_FLAG])), 3);
            }
            if (ROUND_TRIP_FLAG in map) {
                this.roundTrip = util.getFloat(parseFloat(String(map[ROUND_TRIP_FLAG])), 3);
            }
        }
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
        Object.keys(event.headers).forEach(k => {
            // drop reserved key-values
            if (k != 'my_route' && k != 'my_trace_id' && k != 'my_trace_path' && k != 'my_instance') {
                this.headers[k] = event.headers[k];
            }
        });
        this.body = event.body;
        this.replyTo = event.replyTo;
        this.extra = event.extra;
        this.correlationId = event.correlationId;
        this.traceId = event.traceId;
        this.tracePath = event.tracePath;
        this.status = event.status;
        this.execTime = event.execTime;
        this.roundTrip = event.roundTrip;
        return this;
    }
    toString() {
        return JSON.stringify(this.toMap());
    }
}
//# sourceMappingURL=event-envelope.js.map