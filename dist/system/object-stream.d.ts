export declare class ObjectStreamIO {
    private streamIn;
    private streamOut;
    /**
     * Create an object stream
     *
     * For REST automation, the payload must be either string or Buffer (i.e. bytes).
     * For other use cases, you can stream text, bytes and JSON objects.
     *
     * You can use the ObjectStreamWriter to write and the ObjectStreamReader to read the stream.
     *
     * @param expirySeconds for the stream object
     */
    constructor(expirySeconds?: number);
    /**
     * Retrieve the input stream ID to be used in ObjectStreamReader
     *
     * @returns stream ID
     */
    getInputStreamId(): string;
    /**
     * Retrieve the output stream ID to be used in ObjectStreamWriter
     *
     * @returns stream ID
     */
    getOutputStreamId(): string;
}
/**
 * Use this to connect to an output object stream
 */
export declare class ObjectStreamWriter {
    private streamOut;
    /**
     * Create an output stream
     *
     * @param streamId that you get from a new ObjectStreamIO
     */
    constructor(streamId: string);
    /**
     * Write an object to the output stream
     *
     * @param data can be a string, bytes or JSON object
     */
    write(data: string | Buffer | object): void;
    /**
     * Close the output stream to indicate a EOF condition.
     *
     * @returns true when the stream is properly closed.
     */
    close(): Promise<string | number | boolean | object | Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike>>;
}
/**
 * Use this to connect to an input object stream
 */
export declare class ObjectStreamReader {
    private streamIn;
    private timeout;
    private eof;
    /**
     * Create an input stream
     *
     * @param streamId that you get from a calling service
     * @param timeout value for reading a data block from the stream
     */
    constructor(streamId: string, timeout: number);
    /**
     * Read a data block from a stream
     *
     * @returns data block or null when EOF
     * @throws AppException(408, 'timeout') when there is no data in the stream
     */
    read(): Promise<string | number | boolean | object | Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike>>;
    /**
     * Close an input stream. This would release both input and output streams associated with an ObjectStreamIO object.
     * (Note that a stream is automatically closed when EOF is read)
     *
     * @returns true
     */
    close(): Promise<string | number | boolean | object | Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike>>;
    /**
     * Check if the stream is closed.
     *
     * @returns true if the stream has been closed
     */
    closed(): boolean;
}
