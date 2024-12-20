import fs from 'fs';
import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { Platform } from './platform.js';
import { PostOffice } from './post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';

const log = Logger.getInstance();
const util = new Utility();
const po = new PostOffice();
let platform: Platform = null;

const streams = new Map<string, StreamInfo>();

const TEMP_DIR = "/tmp/node/streams";
const STREAM_PREFIX = "stream.";
const IN = ".in";
const OUT = ".out";
const TYPE = "type";
const READ = "read";
const CLOSE = "close";
const END_OF_STREAM = "eof";
const DATA = "data";
const DEFAULT_TIMEOUT = 30 * 60; // 30 minutes
const OBJECT_STREAM_MANAGER = "object.stream.manager";
const RPC = "rpc";

async function housekeeper(evt: EventEnvelope) {
    if (CLOSE == evt.getHeader(TYPE)) {
        const keys = Array.from(streams.keys());     
        if (keys.length > 0) {
            for (const k of keys) {
                const stream = streams.get(k);
                if (stream) {
                    stream.close();
                }
            }
            const s = keys.length == 1? '' : 's';
            log.info(`Total ${keys.length} outstanding stream${s} released`);
        }
    }
}

export class ObjectStreamIO {
    private streamIn: string;
    private streamOut: string;

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
    constructor(expirySeconds = DEFAULT_TIMEOUT) {
        const expiry = Math.max(1, parseInt(String(expirySeconds)));
        const id = util.getUuid();
        if (platform == null) {
            platform = Platform.getInstance();
            util.mkdirsIfNotExist(TEMP_DIR);
            platform.register(OBJECT_STREAM_MANAGER, housekeeper);
        }        
        const worker = new StreamWorker();
        this.streamIn = STREAM_PREFIX + id + IN;
        this.streamOut = STREAM_PREFIX + id + OUT;
        platform.register(this.streamIn, worker.consumer, true, 1, true);
        platform.register(this.streamOut, worker.publisher);
        streams.set(id, new StreamInfo(expiry, id));
        const elapsed = util.getElapsedTime(expiry * 1000);
        log.info(`Stream ${id} created, idle expiry ${elapsed}`);
    }

    /**
     * Retrieve the input stream ID to be used in ObjectStreamReader
     * 
     * @returns stream ID
     */
    getInputStreamId(): string {
        return this.streamIn;
    }

    /**
     * Retrieve the output stream ID to be used in ObjectStreamWriter
     * 
     * @returns stream ID
     */
    getOutputStreamId(): string {
        return this.streamOut;
    }
}

/**
 * Use this to connect to an output object stream
 */
export class ObjectStreamWriter {
    private streamOut: string;

    /**
     * Create an output stream
     * 
     * @param streamId that you get from a new ObjectStreamIO
     */
    constructor(streamId: string) {
        this.streamOut = streamId;
    }

    /**
     * Write an object to the output stream
     * 
     * @param data can be a string, bytes or JSON object
     */
    write(data: string | Buffer | object): void {
        if (po.exists(this.streamOut)) {
            if (data instanceof EventEnvelope) {
                po.send(new EventEnvelope().setTo(this.streamOut).setHeader(TYPE, DATA).setBody(data.getBody()));
            } else {
                po.send(new EventEnvelope().setTo(this.streamOut).setHeader(TYPE, DATA).setBody(data));
            }           
        }        
    }

    /**
     * Close the output stream to indicate a EOF condition.
     * 
     * @returns true when the stream is properly closed.
     */
    async close() {
        if (po.exists(this.streamOut)) {
            const req = new EventEnvelope().setTo(this.streamOut).setHeader(TYPE, END_OF_STREAM);
            const result = await po.request(req);
            return result.getBody();
        } else {
            return false;
        }
    }
}

/**
 * Use this to connect to an input object stream
 */
export class ObjectStreamReader {
    private streamIn: string;
    private timeout: number;
    private eof = false;

    /**
     * Create an input stream
     * 
     * @param streamId that you get from a calling service
     * @param timeout value for reading a data block from the stream
     */
    constructor(streamId: string, timeout: number) {
        this.streamIn = streamId;
        this.timeout = Math.max(1000, timeout);
    }

    /**
     * Read a data block from a stream
     * 
     * @returns data block or null when EOF
     * @throws AppException(408, 'timeout') when there is no data in the stream
     */
    async read() {
        if (!this.eof) {
            const block = await po.request(new EventEnvelope().setTo(this.streamIn).setHeader(TYPE, READ), this.timeout);
            if (DATA == block.getHeader(TYPE)) {
                return block.getBody();
            }
            if (END_OF_STREAM == block.getHeader(TYPE)) {
                this.eof = true;
                // automatically close input and output streams
                await po.request(new EventEnvelope().setTo(this.streamIn).setHeader(TYPE, CLOSE), this.timeout);
            }
        }
        return null;
    }

    /**
     * Close an input stream. This would release both input and output streams associated with an ObjectStreamIO object.
     * (Note that a stream is automatically closed when EOF is read)
     * 
     * @returns true
     */
    async close() {
        if (!this.eof) {
            this.eof = true;
            const result = await po.request(new EventEnvelope().setTo(this.streamIn).setHeader(TYPE, CLOSE), this.timeout);
            return result.getBody();
        }
        return true;
    }

    /**
     * Check if the stream is closed.
     * 
     * @returns true if the stream has been closed
     */
    closed(): boolean {
        return this.eof;
    }

}

class StreamWorker {

    static getIdFromRoute(route: string): string {
        if (route) {
            const parts = route.split('.');
            if (parts.length > 2) {
                return parts[1];
            }
        }
        return null;
    }

    static async fetchNextBlock(replyTo: string, stream: StreamInfo, timeout: number) {
        const begin = new Date().getTime();
        let now = begin;
        let n = 0;
        while (now - begin < timeout) {
            if (stream.write_count >= stream.read_count) {                
                const filename = TEMP_DIR + '/' + stream.id + '-' + stream.read_count;
                const exists = fs.existsSync(filename);
                if (exists) {
                    const data = await fs.promises.readFile(filename);
                    if (data) {                            
                        stream.read_count++;                                               
                        fs.promises.unlink(filename);
                        const block = new EventEnvelope(data);
                        if (DATA == block.getHeader(TYPE)) {
                            stream.touch();
                            po.send(new EventEnvelope().setTo(replyTo).setHeader(TYPE, DATA).setBody(block.getBody()));
                            return;
                        } else if (END_OF_STREAM == block.getHeader(TYPE)) {
                            // EOF detected
                            stream.eof_read = true;
                            po.send(new EventEnvelope().setTo(replyTo).setHeader(TYPE, END_OF_STREAM));
                            return;
                        }
                    }
                }
            }
            //
            // Since file I/O is asynchronous, it is possible that newly written file is not immediately available.
            //
            // Furthermore, object streaming may also be used in "continuous" mode where the publisher keeps
            // the output stream active. Therefore, the consumer must wait for the next data block until the
            // data block arrives or when read timeout occurs.
            //
            // The retry mechanism includes faster cycles for the first 5 retries where the first retry
            // is in the next tick of the event loop.
            //
            await util.sleep(n < 5? 10 * n : 100);
            n++;
            now = new Date().getTime();
        } 
    }

    async publisher(evt: EventEnvelope) {
        const id = StreamWorker.getIdFromRoute(evt.getHeader('my_route'));
        if (id) {
            const stream = streams.get(id);
            if (stream) {
                let block: EventEnvelope = null;
                if (DATA == evt.getHeader(TYPE) && !stream.eof_write && evt.getBody() != null) {
                    block = new EventEnvelope().setHeader(TYPE, DATA).setBody(evt.getBody());
                }
                if (END_OF_STREAM == evt.getHeader(TYPE) && !stream.eof_write) {
                    block = new EventEnvelope().setHeader(TYPE, END_OF_STREAM);
                    stream.eof_write = true;
                }
                if (block) {
                    const b = block.toBytes();
                    stream.touch();
                    stream.write_count++;
                    const filename = TEMP_DIR + '/' + stream.id + '-' + stream.write_count;
                    // Let "writeFile" to run asynchronously. DO NOT use 'await' as it has unintended side-effect.
                    fs.promises.writeFile(filename, b);
                    return true;
                }
            }
        }
        return false;
    }
    
    async consumer(evt: EventEnvelope) {
        const rpcTag = evt.getTag(RPC);
        const readTimeout = rpcTag? util.str2int(rpcTag) : 1000;
        const replyTo = evt.getReplyTo();
        if (replyTo) {   
            const id = StreamWorker.getIdFromRoute(evt.getHeader('my_route'));
            const stream = streams.get(id);
            if (stream) {
                if (READ == evt.getHeader(TYPE)) {
                    if (stream.eof_read) {
                        po.send(new EventEnvelope().setTo(replyTo).setHeader(TYPE, END_OF_STREAM));
                    } else {
                        await StreamWorker.fetchNextBlock(replyTo, stream, readTimeout);
                    }
                }
                if (CLOSE == evt.getHeader(TYPE)) {
                    if (stream.closed) {
                        po.send(new EventEnvelope().setTo(replyTo).setBody(false));
                    } else {
                        po.send(new EventEnvelope().setTo(replyTo).setBody(true));
                        stream.close();
                    }                                            
                }
            }
        }
    }
}

class StreamInfo {
    id: string;
    streamIn: string;
    streamOut: string;
    created: number;
    updated: number;
    expiryMs: number;
    write_count = 0;
    read_count = 1;
    eof_write = false;
    eof_read = false;
    closed = false;
    timer = null;

    constructor(expirySeconds: number, id: string) {
        this.id = id;
        this.created = new Date().getTime();
        this.updated = this.created;
        this.expiryMs = expirySeconds * 1000;
        this.streamIn = STREAM_PREFIX + this.id + IN;
        this.streamOut = STREAM_PREFIX + this.id + OUT;
        this.startTimer();
    }

    stopTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    startTimer(): void {
        this.stopTimer();
        this.timer = setTimeout(() => {
            const elapsed = util.getElapsedTime(this.expiryMs);
            log.warn(`Stream ${this.id} expired due to inactivity for ${elapsed}`);
            this.close();
        }, this.expiryMs);
    }

    touch(): void {
        this.updated = new Date().getTime();
        this.startTimer();
    }

    close() {
        if (!this.closed) {
            this.closed = true;
            this.stopTimer();
            streams.delete(this.id);
            let count = 0;
            if (this.write_count >= this.read_count) {
                for (let i = this.read_count; i <= this.write_count; i++) {
                    const filename = TEMP_DIR + '/' + this.id + '-' + i;
                    const exists = fs.existsSync(filename);
                    if (exists) {
                        fs.promises.unlink(filename);
                        count++;                                        
                    }
                }
            }
            if (count > 0) {
                const s = count == 1? '' : 's';
                log.warn(`Deleted ${count} unread block${s} from stream ${this.id}`);
            }
            // release the input and output stream services
            platform.release(this.streamIn);
            platform.release(this.streamOut);
        }
    }
}
