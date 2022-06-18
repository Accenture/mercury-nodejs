import { PO } from "../system/post-office.js";
import { Utility } from '../util/utility.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';

const po = new PO().getInstance();
const util = new Utility().getInstance();

const STREAM_IO_MANAGER = 'object.streams.io'
const EXPIRY = 6000;

export class ObjectStreamIO {

    private inStream: string = null;
    private outStream: string = null;
    private ready = false;
    private error: string = null;
    private status = 500;
    private start = Date.now();

    /**
     * Create an event I/O stream with an expiry timer
     * 
     * @param expirySeconds of a stream
     */
    constructor(expirySeconds = 1800) {
        po.request(new EventEnvelope().setTo(STREAM_IO_MANAGER).setHeader('type', 'create_stream').setHeader('expiry', String(expirySeconds)), EXPIRY)
            .then((res: EventEnvelope) => {
                const data = res.getBody();
                if (res.getStatus() == 200 && data && data instanceof Object) {
                    if ('in' in data && 'out' in data) {
                        this.inStream = data['in'];
                        this.outStream = data['out'];
                        this.ready = true;
                    }
                } 
            })
            .catch((e) => {
                this.error = e.message;
                if (e instanceof AppException) {
                    this.status = e.getStatus();
                }
            });
    }

    /**
     * Retrieve the input stream route reference
     * 
     * @returns input stream handle
     */
    async getInputStream() {
        await this.waitForStream();
        return this.inStream;
    }

    /**
     * Retrieve the output stream route reference
     * 
     * @returns output stream handle
     */
    async getOutputStream() {
        await this.waitForStream();
        return this.outStream;
    }

    private async waitForStream() {
        while (!this.ready && Date.now() - this.start <= EXPIRY) {
            await util.sleep(100);
        }
        if (this.error) {
            throw new AppException(this.status, this.error);
        }
    }

}

export class ObjectStreamReader {

    private inputStream: string;
    private closed = false;
    private eof = false;

    /**
     * Create a input stream wrapper
     * 
     * @param inputStream handle
     */
    constructor(inputStream: string) {
        this.inputStream = inputStream;
    }

    /**
     * Obtain the generator function to fetch incoming blocks of data
     * 
     * @param timeout in milliseconds
     */
    async * reader(timeout: number) {
        while (!this.eof) {
            const req = new EventEnvelope().setTo(this.inputStream).setHeader('type', 'read');
            const res = await po.request(req, timeout)
            if (res.getStatus() == 200) {
                const payloadType = res.getHeader('type');
                if ('eof' == payloadType) {
                    this.eof = true;
                    break;
                } else if ('data' == payloadType) {
                    yield res.getBody();
                }

            } else {
                throw new AppException(res.getStatus(), String(res.getBody()));
            }
        }
    }

    /**
     * Close the input stream, thus releasing the underlying I/O stream resource
     */
    close(): void {
        if (!this.closed) {
            this.closed = true;
            const req = new EventEnvelope().setTo(this.inputStream).setHeader('type', 'close');
            po.send(req);
        }

    }

}

export class ObjectStreamWriter {

    private outputStream: string;
    private closed = false;

    /**
     * Create an output stream wrapper
     * 
     * @param outputStream handle
     */
    constructor(outputStream: string) {
        this.outputStream = outputStream;
    }
    
    /**
     * Write a block of data to the output stream
     * 
     * @param payload for the outgoing block of data
     */
    write(payload: string | number | object | boolean | Buffer | Uint8Array): void {
        if (!this.closed && payload) {
            const req = new EventEnvelope().setTo(this.outputStream).setHeader('type', 'data').setBody(payload);
            po.send(req);  
        }
    }

    /**
     * Close the output stream, thus indicating EOF
     * 
     * Note:
     *  1. If you do not close an output stream, it is active until the I/O stream expires.
     *  2. The I/O stream is not released until the recipient closes the corresponding input stream.
     */
    close(): void {
        if (!this.closed) {
            this.closed = true;
            const req = new EventEnvelope().setTo(this.outputStream).setHeader('type', 'eof');
            po.send(req);
        }
    }

}
