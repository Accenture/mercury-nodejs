/// <reference types="node" />
export declare class ObjectStreamIO {
    private inStream;
    private outStream;
    private ready;
    private error;
    private status;
    private start;
    /**
     * Create an event I/O stream with an expiry timer
     *
     * @param expirySeconds of a stream
     */
    constructor(expirySeconds?: number);
    /**
     * Retrieve the input stream route reference
     *
     * @returns input stream handle
     */
    getInputStream(): Promise<string>;
    /**
     * Retrieve the output stream route reference
     *
     * @returns output stream handle
     */
    getOutputStream(): Promise<string>;
    private waitForStream;
}
export declare class ObjectStreamReader {
    private inputStream;
    private closed;
    private eof;
    /**
     * Create a input stream wrapper
     *
     * @param inputStream handle
     */
    constructor(inputStream: string);
    /**
     * Obtain the generator function to fetch incoming blocks of data
     *
     * @param timeout in milliseconds
     */
    reader(timeout: number): AsyncGenerator<string | number | boolean | object | Uint8Array | Buffer, void, unknown>;
    /**
     * Close the input stream, thus releasing the underlying I/O stream resource
     */
    close(): void;
}
export declare class ObjectStreamWriter {
    private outputStream;
    private closed;
    /**
     * Create an output stream wrapper
     *
     * @param outputStream handle
     */
    constructor(outputStream: string);
    /**
     * Write a block of data to the output stream
     *
     * @param payload for the outgoing block of data
     */
    write(payload: string | number | object | boolean | Buffer | Uint8Array): void;
    /**
     * Close the output stream, thus indicating EOF
     *
     * Note:
     *  1. If you do not close an output stream, it is active until the I/O stream expires.
     *  2. The I/O stream is not released until the recipient closes the corresponding input stream.
     */
    close(): void;
}
