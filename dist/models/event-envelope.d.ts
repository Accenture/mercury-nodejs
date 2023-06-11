/// <reference types="node" />
export declare class EventEnvelope {
    private id;
    private headers;
    private body;
    private status;
    private to;
    private sender;
    private replyTo;
    private extra;
    private correlationId;
    private traceId;
    private tracePath;
    private execTime;
    private roundTrip;
    /**
     * Create a new EventEnvelope
     *
     * @param event - optional as a JSON object, Buffer or EventEnvelope
     */
    constructor(event?: object | Buffer | EventEnvelope);
    /**
     * Override the original event ID
     *
     * @param id - unique UUID
     * @returns this
     */
    setId(id: string): EventEnvelope;
    /**
     * Retrieve event ID
     *
     * @returns id
     */
    getId(): string;
    /**
     * Set a header (aka parameter)
     *
     * @param k key
     * @param v value
     * @returns this
     */
    setHeader(k: string, v: string): EventEnvelope;
    /**
     * Retrieve a header value using case-insensitive key
     *
     * @param k key
     * @returns value or null if not found
     */
    getHeader(k: string): string;
    /**
     * Retrieve all headers / parameters
     *
     * @returns key-values
     */
    getHeaders(): object;
    /**
     * Override existing headers / parameters
     *
     * @param headers to override
     * @returns this
     */
    setHeaders(headers: object): EventEnvelope;
    /**
     * Set an optional payload for an event.
     * The payload can be string, number, JSON object, boolean or bytes
     *
     * @param body
     * @returns
     */
    setBody(body: string | number | object | boolean | Buffer | Uint8Array): EventEnvelope;
    /**
     * Retrieve the payload if any
     *
     * @returns body (aka payload)
     */
    getBody(): string | number | object | boolean | Buffer | Uint8Array;
    /**
     * Set processing status code if you want to manually define the value.
     *
     * Note that status code should be compliant with the 3-digit numeric HTTP status code convention.
     * i.e. HTTP-2xx for success, HTTP-4xx for application related issues and HTTP-5xx for infrastructure failures.
     *
     * @param status code
     * @returns this
     */
    setStatus(status: number): EventEnvelope;
    /**
     * Retrieve the event processing status.
     *
     * Note that status code should be compliant with the 3-digit numeric HTTP status code convention.
     * i.e. HTTP-2xx for success, HTTP-4xx for application related issues and HTTP-5xx for infrastructure failures.
     *
     * @returns status code
     */
    getStatus(): number;
    /**
     * This is used for routing purpose.
     * The "to" is a route name representing a target service / function.
     *
     * @param to destination route
     * @returns this
     */
    setTo(to: string): EventEnvelope;
    /**
     * Retrieve the destination route
     *
     * @returns route name
     */
    getTo(): string;
    /**
     * Sender route name is where the event comes from
     *
     * @param sender of the event
     * @returns this
     */
    setFrom(sender: string): EventEnvelope;
    /**
     * Retrieve sender route name of the event
     *
     * @returns sender
     */
    getFrom(): string;
    /**
     * ReplyTo is used for routing purpose.
     *
     * @param replyTo route name if this event is used for RPC or callback
     * @returns this
     */
    setReplyTo(replyTo: string): EventEnvelope;
    /**
     * Retrieve the route name for receiving the function return value
     *
     * @returns route name
     */
    getReplyTo(): string;
    /**
     * This method is reserved by the system. DO NOT call this directly.
     *
     * @param extra is used for tagging an event
     * @returns this
     */
    setExtra(extra: string): EventEnvelope;
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
    addTag(key: string, value?: string): EventEnvelope;
    /**
     * Remove a tag from an evvent
     *
     * @param key - tag name
     * @returns this
     */
    removeTag(key: string): EventEnvelope;
    /**
     * Retrieve a tag
     *
     * @param key - tag name
     * @returns this
     */
    getTag(key: string): string;
    /**
     * Retrieve the string representation of all tags.
     * Each tag is separated by the vertical bar character '|'.
     *
     * @returns all tags
     */
    getExtra(): string;
    /**
     * You may set a unique ID for tracking RPC or callback.
     *
     * @param correlationId for tracking
     * @returns this
     */
    setCorrelationId(correlationId: string): EventEnvelope;
    /**
     * Retrieve the correlation ID of an event
     *
     * @returns correlation ID
     */
    getCorrelationId(): string;
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
    setTraceId(traceId: string): EventEnvelope;
    /**
     * Retrieve trace ID of the event.
     *
     * @returns trace ID
     */
    getTraceId(): string;
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
    setTracePath(tracePath: string): EventEnvelope;
    /**
     * Retrieve the trace path of an event
     *
     * @returns trace path
     */
    getTracePath(): string;
    /**
     * You can indicate that an event contains an exception message in the body
     *
     * @param exception indicator
     * @returns this
     */
    setException(exception?: boolean): EventEnvelope;
    /**
     * Check if this event contains an exception message in the body
     *
     * @returns true or false
     */
    isException(): boolean;
    /**
     * This method is reserved by the system. DO NOT call this directly.
     *
     * @param execTime of the function processing this event
     * @returns this
     */
    setExecTime(execTime: number): EventEnvelope;
    /**
     * Retrieve execution time for the function that process this event
     *
     * @returns performance metrics
     */
    getExecTime(): number;
    /**
     * This method is reserved by the system. DO NOT call this directly.
     *
     * @param roundTrip end-to-end processing time
     * @returns this
     */
    setRoundTrip(roundTrip: number): EventEnvelope;
    /**
     * Retrieve the end-to-end processing time
     *
     * @returns performance metrics
     */
    getRoundTrip(): number;
    /**
     * Convert this event into a JSON object
     *
     * @returns object
     */
    toMap(): object;
    /**
     * Convert a JSON object into an event envelope.
     *
     * Note that the object must be compliant with the EventEnvelope interface contract.
     *
     * @param map input is a JSON object
     * @returns this
     */
    fromMap(map: object): EventEnvelope;
    /**
     * Convert this event into a byte array
     *
     * MsgPack (Binary JSON) is used as the transport protocol.
     *
     * @returns bytes
     */
    toBytes(): Buffer;
    /**
     * Convert a byte array into this event
     *
     * MsgPack (Binary JSON) is used as the transport protocol.
     *
     * @param b input is a byte array
     * @returns this
     */
    fromBytes(b: Buffer): EventEnvelope;
    /**
     * Clone from an event
     *
     * @param event input
     * @returns this
     */
    clone(event: EventEnvelope): EventEnvelope;
    toString(): string;
}
