import { unpack, pack } from 'msgpackr';
import { Utility } from '../util/utility.js';
import { AppException } from './app-exception.js';

const util = new Utility();

// constants for binary serialization
const ID_FLAG = "0";
const EXECUTION_FLAG = "1";
const ROUND_TRIP_FLAG = "2";
// extra flag "3" has been retired
// exception flag "4" is reserved for Java exception
const STACK_FLAG = "5";
const ANNOTATION_FLAG = "6";
const TAG_FLAG = "7";
const TO_FLAG = "T";
const REPLY_TO_FLAG = "R";
const FROM_FLAG = "F";
const STATUS_FLAG = "S";
const HEADERS_FLAG = "H";
const BODY_FLAG = "B";
const TRACE_ID_FLAG = "t";
const TRACE_PATH_FLAG = "p";
const CID_FLAG = "X";

type eventPayload = string | number | object | boolean | Buffer | Uint8Array;

export class EventEnvelope {

    private id: string;
    private headers: object = {};
    private tags: object = {};
    private annotations: object = {};
    private body: eventPayload;
    private status: number;
    private to: string;
    private sender: string;
    private replyTo: string;
    private stackTrace: string;
    private correlationId: string;
    private traceId: string;
    private tracePath: string;
    private execTime: number;
    private roundTrip: number;

    /**
     * Create a new EventEnvelope
     * 
     * @param event - optional as a JSON object, Buffer or EventEnvelope
     */
    constructor(event?: object | Buffer | EventEnvelope) {
        this.id = util.getUuid();
        this.body = null;
        this.status = 200;
        if (event) {
            if (event.constructor == EventEnvelope) {
                this.copy(event);
            }
            if (event.constructor == Object) {
                this.fromMap(event as object);
            } 
            if (event.constructor == Buffer || event.constructor == Uint8Array) {
                this.fromBytes(event as Buffer);
            }
        }
    }

    /**
     * Override the original event ID
     * 
     * @param id - unique UUID
     * @returns this
     */
    setId(id: string): this {
        this.id = id;
        return this;
    }

    /**
     * Retrieve event ID
     * 
     * @returns id
     */
    getId(): string {
        return this.id? this.id : null;
    }

    /**
     * Set a header (aka parameter)
     * 
     * @param k key
     * @param v value
     * @returns this
     */
    setHeader(k: string, v: string): this {
        this.headers[k] = v;
        return this;
    }

    /**
     * Retrieve a header value using case-insensitive key
     * 
     * @param k key
     * @returns value or null if not found
     */
    getHeader(k: string): string {
        if (k) {
            const lc = k.toLowerCase();
            for (const h in this.headers) {
                if (lc == h.toLowerCase()) {
                    return this.headers[h];
                }
            }
        }
        return null;
    }

    /**
     * Retrieve all headers / parameters
     * 
     * @returns key-values
     */
    getHeaders(): object {
        return this.headers;
    }

    /**
     * Override existing headers / parameters
     * 
     * @param headers to override
     * @returns this
     */
    setHeaders(headers: object): this {
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
    setBody(body: eventPayload): this {
        this.body = body;
        return this;
    }

    /**
     * Retrieve the payload if any
     * 
     * @returns body (aka payload)
     */
    getBody(): eventPayload {
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
    setStatus(status: number): this {
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
    getStatus(): number {
        return this.status? this.status : 200;
    }

    /**
     * This is used for routing purpose.
     * The "to" is a route name representing a target service / function.
     * 
     * @param to destination route
     * @returns this
     */
    setTo(to: string): this {
        this.to = to;
        return this;
    }

    /**
     * Retrieve the destination route
     * 
     * @returns route name
     */
    getTo(): string {
        return this.to? this.to : null;
    }

    /**
     * Sender route name is where the event comes from
     * 
     * @param sender of the event
     * @returns this
     */
    setFrom(sender: string): this {
        this.sender = sender;
        return this;
    }

    /**
     * Retrieve sender route name of the event
     * 
     * @returns sender
     */
    getFrom(): string {
        return this.sender? this.sender : null;
    }

    /**
     * ReplyTo is used for routing purpose.
     * 
     * @param replyTo route name if this event is used for RPC or callback
     * @returns this
     */
    setReplyTo(replyTo: string): this {
        this.replyTo = replyTo;
        return this;
    }

    /**
     * Retrieve the route name for receiving the function return value
     * 
     * @returns route name
     */
    getReplyTo(): string {
        return this.replyTo? this.replyTo: null;
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
    addTag(key: string, value = 'true'): this {
        if (key && key.length > 0) {
            this.tags[key] = String(value);
        }
        return this;
    }

    /**
     * Set tags
     * 
     * @param tags of key-values
     * @returns this
     */
    setTags(tags: object): this {
        this.tags = tags;
        return this;
    }

    /**
     * Remove a tag from an evvent
     * 
     * @param key - tag name
     * @returns this
     */
    removeTag(key: string): this {
        if (key && key.length > 0) {
            delete this.tags[key];
        }
        return this;
    }

    /**
     * Retrieve a tag
     * 
     * @param key - tag name
     * @returns this
     */
    getTag(key: string): string {
        return key && key.length > 0 && this.tags[key]? this.tags[key] : null;
    }

    /**
     * Retrieve all tags
     * 
     * @returns tags
     */
    getTags(): object {
        return this.tags;
    }

    /**
     * Annotate the event to propagate to a trace
     * 
     * @param key of an annotation
     * @param value of an annotation
     * @returns 
     */
    annotate(key: string, value: string | object): this {
        if (key && value) {
            this.annotations[key] = value;
        }        
        return this;
    }

    /**
     * Retrieve all annotations
     * 
     * @returns annotations
     */
    getAnnotations(): object {
        return this.annotations;
    }

    /**
     * Set annotations
     * 
     * @param annotations to set
     * @returns this
     */
    setAnnotations(annotations: object): this {
        this.annotations = annotations;
        return this;
    }

    /**
     * Clear annotations
     * 
     * @returns this
     */
    clearAnnotations(): this {
        this.annotations = {};
        return this;
    }

    /**
     * You may set a unique ID for tracking RPC or callback.
     * 
     * @param correlationId for tracking
     * @returns this
     */
    setCorrelationId(correlationId: string): this {
        if (correlationId) {
            this.correlationId = correlationId;
        } else {
            this.correlationId = null;
        }
        return this;
    }

    /**
     * Retrieve the correlation ID of an event
     * 
     * @returns correlation ID
     */
    getCorrelationId(): string {
        return this.correlationId? this.correlationId : null;
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
    setTraceId(traceId: string): this {
        this.traceId = traceId;
        return this;
    }

    /**
     * Retrieve trace ID of the event.
     * 
     * @returns trace ID
     */
    getTraceId(): string {
        return this.traceId? this.traceId : null;
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
    setTracePath(tracePath: string): this {
        this.tracePath = tracePath;
        return this;
    }

    /**
     * Retrieve the trace path of an event
     * 
     * @returns trace path
     */
    getTracePath(): string {
        return this.tracePath? this.tracePath : null;
    }

    /**
     * Set exception status and message
     * 
     * @param status code
     * @param error message
     * @returns this
     */
    setException(error: Error): this {
        this.setStatus(error instanceof AppException? error.getStatus() : 500);
        if (error instanceof Error) {
            // user function must throw AppException or Error object
            // where AppException extends Error.
            this.setBody(error.message);
            const text = error.stack? error.stack : error.message;
            // limit the depth of stack trace to 10 lines
            let result = '';
            const lines = util.split(text, '\r\n').map(k => k.trim());
            for (let i=0; i < 10 && i < lines.length; i++) {
                result += lines[i];
                result += '\n';
            }
            if (lines.length > 10) {
                result += `...(${lines.length})\n`;
            }
            this.stackTrace = result;
        } else {
            // in case the user function throws something other than an Error object
            const message = String(error);
            this.setBody(message);
            this.stackTrace = message;
        }
        return this;
    }

    /**
     * Convert body as an error message
     * 
     * @returns error message
     */
    getError(): string | object {
        if (this.body) {
            if (typeof this.body == 'string' || typeof this.body == 'boolean' || typeof this.body == 'number') {
                return String(this.body);
            } else if (this.body instanceof Buffer) {
                return "***";
            } else if (this.body instanceof Object && !Array.isArray(this.body) && 
                'error' == this.body['type'] && 'status' in this.body && 'message' in this.body && typeof this.body['message'] == 'string') {
                return this.body['message'];
            } else {
                return this.body;
            }
        } else {
            return "null";
        }
    }

    setStackTrace(stackTrace: string): this {
        this.stackTrace = stackTrace;
        return this;
    }

    getStackTrace(): string {
        return this.stackTrace;
    }

    /**
     * Check if this event contains an exception
     * 
     * @returns true or false
     */
    isException(): boolean {
        return !!this.stackTrace;
    }

    /**
     * This method is reserved by the system. DO NOT call this directly.
     * 
     * @param execTime of the function processing this event
     * @returns this
     */
    setExecTime(execTime: number): this {
        this.execTime = Math.max(0, execTime);
        return this;
    }

    /**
     * Retrieve execution time for the function that process this event
     * 
     * @returns performance metrics
     */
    getExecTime(): number {
        return this.execTime? Math.max(0, this.execTime) : 0;
    }

    /**
     * This method is reserved by the system. DO NOT call this directly.
     * 
     * @param roundTrip end-to-end processing time
     * @returns this
     */
    setRoundTrip(roundTrip: number): this {
        this.roundTrip = Math.max(0, roundTrip);
        return this;
    }

    /**
     * Retrieve the end-to-end processing time
     * 
     * @returns performance metrics
     */
    getRoundTrip(): number {
        return this.roundTrip? Math.max(0, this.roundTrip) : 0;
    }

    /**
     * Convert this event into a JSON object
     * 
     * @returns object
     */
    toMap(): object {
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
        if (Object.keys(this.tags).length > 0) {
            result['tags'] = this.tags;
        }
        if (Object.keys(this.annotations).length > 0) {
            result['annotations'] = this.annotations;
        }
        if (this.body || typeof this.body == 'boolean') {
            result['body'] = this.body;
        }
        if (this.replyTo) {
            result['reply_to'] = String(this.replyTo);
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
            result['exec_time'] = Math.max(0, util.getFloat(this.execTime, 3));
        }
        if (this.roundTrip) {
            result['round_trip'] = Math.max(0, util.getFloat(this.roundTrip, 3));
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
    fromMap(map: object): this {
        if (typeof map['id'] == 'string') {
            this.id = map['id'];
        }
        if (typeof map['to'] == 'string') {
            this.to = map['to'];
        }
        if (typeof map['from'] == 'string') {
            this.sender = map['from'];
        }
        if ('headers' in map) {
            const headers = map['headers'];
            this.headers = headers && headers.constructor == Object? headers as object : {};
        }
        if ('body' in map) {
            // "body" can be one of (string | number | object | boolean | Buffer | Uint8Array).
            // Casting to object for compilation only. It is irrelevant at run-time.
            this.body = map['body'] as object;
        }
        if (typeof map['reply_to'] == 'string') {
            this.replyTo = map['reply_to'];
        }
        this.metadataFromMap(map);
        return this;
    }

    private metadataFromMap(map: object) {
        if ('tags' in map) {
            this.tags = map['tags'] as object;
        }
        if ('annotations' in map) {
            this.annotations = map['annotations'] as object;
        }
        if (typeof map['cid'] == 'string') {
            this.correlationId = map['cid'];
        }
        if (typeof map['trace_id'] == 'string') {
            this.traceId = String(map['trace_id']);
        }
        if (typeof map['trace_path'] == 'string') {
            this.tracePath = String(map['trace_path']);
        }
        if (typeof map['status'] == 'number') {
            this.status = parseInt(String(map['status']));
        }
        if (typeof map['exec_time'] == 'number') {
            this.execTime = Math.max(0, util.getFloat(parseFloat(String(map['exec_time'])), 3));
        }
        if (typeof map['round_trip'] == 'number') {
            this.roundTrip = Math.max(0, util.getFloat(parseFloat(String(map['round_trip'])), 3));
        }
    }

    /**
     * Convert this event into a byte array
     * 
     * MsgPack (Binary JSON) is used as the transport protocol.
     * 
     * @returns bytes
     */
    toBytes(): Buffer {
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
        if (Object.keys(this.tags).length > 0) {
            result[TAG_FLAG] = this.tags;
        }
        if (Object.keys(this.annotations).length > 0) {
            result[ANNOTATION_FLAG] = this.annotations;
        }
        if (this.body || typeof this.body == 'boolean') {
            result[BODY_FLAG] = this.body;
        }
        if (this.replyTo) {
            result[REPLY_TO_FLAG] = this.replyTo;
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
            result[EXECUTION_FLAG] = Math.max(0, util.getFloat(this.execTime, 3));
        }
        if (this.roundTrip) {
            result[ROUND_TRIP_FLAG] = Math.max(0, util.getFloat(this.roundTrip, 3));
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
    fromBytes(b: Buffer): this {
        const o = unpack(b);
        if (o && o.constructor == Object) {
            const map = o as object;
            if (typeof map[ID_FLAG] == 'string') {
                this.id = map[ID_FLAG];
            }
            if (typeof map[TO_FLAG] == 'string') {
                this.to = map[TO_FLAG];
            }
            if (typeof map[FROM_FLAG] == 'string') {
                this.sender = map[FROM_FLAG];
            }
            if (HEADERS_FLAG in map) {
                const headers = map[HEADERS_FLAG];
                this.headers = headers && headers.constructor == Object? headers as object : {};
            }
            this.bodyFromMap(map);
        }
        return this;
    }

    private bodyFromMap(map: object) {
        if (BODY_FLAG in map) {
            // "body" can be one of (string | number | object | boolean | Buffer | Uint8Array).
            // Casting to object for compilation only. It is irrelevant at run-time.
            this.body = map[BODY_FLAG] as object;
        }
        if (typeof map[REPLY_TO_FLAG] == 'string') {
            this.replyTo = map[REPLY_TO_FLAG];
        }
        if (TAG_FLAG in map) {
            this.tags = map[TAG_FLAG] as object;
        }
        if (ANNOTATION_FLAG in map) {
            this.annotations = map[ANNOTATION_FLAG] as object;
        }
        if (typeof map[STACK_FLAG] == 'string') {
            this.stackTrace = map[STACK_FLAG];
        }
        if (typeof map[CID_FLAG] == 'string') {
            this.correlationId = map[CID_FLAG];
        }
        if (typeof map[TRACE_ID_FLAG] == 'string') {
            this.traceId = map[TRACE_ID_FLAG];
        }
        if (typeof map[TRACE_PATH_FLAG] == 'string') {
            this.tracePath = map[TRACE_PATH_FLAG];
        }
        if (typeof map[STATUS_FLAG] == 'number') {
            this.status = parseInt(String(map[STATUS_FLAG]));
        }
        if (typeof map[EXECUTION_FLAG] == 'number') {
            this.execTime = Math.max(0, util.getFloat(parseFloat(String(map[EXECUTION_FLAG])), 3));
        }
        if (typeof map[ROUND_TRIP_FLAG] == 'number') {
            this.roundTrip = Math.max(0, util.getFloat(parseFloat(String(map[ROUND_TRIP_FLAG])), 3));
        }        
    }

    /**
     * Copy from an event into this
     * 
     * @param event input
     * @returns this
     */
    copy(event: EventEnvelope): this {
        this.to = event.to;
        this.id = event.id;
        this.sender = event.sender;
        this.headers = {};
        Object.keys(event.headers).forEach(k => {
            // drop reserved key-values
            if (k != 'my_route' && k != 'my_trace_id' && k!= 'my_trace_path' && k != 'my_instance') {
                this.headers[k] = event.headers[k];
            }            
        });
        this.body = event.body;
        this.replyTo = event.replyTo;
        this.tags = event.tags;
        this.annotations = event.annotations;
        this.correlationId = event.correlationId;
        this.traceId = event.traceId;
        this.tracePath = event.tracePath;
        this.status = event.status;
        this.execTime = event.execTime;
        this.roundTrip = event.roundTrip;
        this.stackTrace = event.stackTrace;
        return this;
    }

    toString(): string {
        return JSON.stringify(this.toMap());
    }
}
