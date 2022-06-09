import { unpack, pack } from 'msgpackr';
import { Utility } from '../util/utility.js';

const util = new Utility().getInstance();

function extraToKeyValues(extra: string): object {
    const map = {};
    if (extra && extra.length > 0) {
        const list = extra.split('|').filter(v => v.length > 0);
        for (const kv of list) {
            const sep = kv.indexOf('=');
            if (sep != -1) {
                map[kv.substring(0, sep)] = kv.substring(sep+1);
            } else {
                map[kv] = '';
            }
        }
    }
    return map;
}

function mapToString(map: object): string {
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
    return result.substring(0, result.length-1);
}

export class EventEnvelope {

    private id: string;
    private headers: object;
    private body: string | number | object | boolean | Buffer | Uint8Array;
    private status: number;
    private to: string;
    private sender: string;
    private replyTo: string;
    private extra: string;
    private correlationId: string;
    private traceId: string;
    private tracePath: string;
    private broadcast: boolean;
    private execTime: number;
    private roundTrip: number;

    constructor(event?: object | Buffer | EventEnvelope) {
        this.id = 'js'+util.getUuid();
        this.headers = {};
        this.body = null;
        this.status = 200;
        if (event) {
            if (event.constructor == EventEnvelope) {
                this.clone(event as EventEnvelope);
            }
            if (event.constructor == Object) {
                this.fromMap(event as object);
            } 
            if (event.constructor == Buffer || event.constructor == Uint8Array) {
                this.fromBytes(event as Buffer);
            }
        }
    }

    setId(id: string): EventEnvelope {
        this.id = id;
        return this;
    }

    getId(): string {
        return this.id;
    }

    setHeader(k: string, v: string): EventEnvelope {
        this.headers[k] = v;
        return this;
    }

    getHeader(k: string): string {
        return k in this.headers? this.headers[k] : null;
    }

    getHeaders(): object {
        return this.headers;
    }

    setHeaders(headers: object): EventEnvelope {
        this.headers = headers;
        return this;
    }

    setBody(body: string | number | object | boolean | Buffer | Uint8Array): EventEnvelope {
        this.body = body;
        return this;
    }

    getBody() {
        return this.body;
    }

    setStatus(status: number): EventEnvelope {
        this.status = status;
        return this;
    }

    getStatus(): number {
        return this.status;
    }

    setTo(to: string): EventEnvelope {
        this.to = to;
        return this;
    }

    getTo(): string {
        return this.to;
    }

    setFrom(sender: string): EventEnvelope {
        this.sender = sender;
        return this;
    }

    getFrom(): string {
        return this.sender;
    }

    setReplyTo(replyTo: string): EventEnvelope {
        this.replyTo = replyTo;
        return this;
    }

    getreplyTo(): string {
        return this.replyTo;
    }

    setExtra(extra: string): EventEnvelope {
        this.extra = extra;
        return this;
    }

    addTag(key: string, value = ''): EventEnvelope {
        if (key && key.length > 0) {
            const map = extraToKeyValues(this.extra);
            map[key] = value;
            this.extra = mapToString(map);
        }
        return this;
    }

    removeTag(key: string): EventEnvelope {
        if (key && key.length > 0) {
            const map = extraToKeyValues(this.extra);
            delete map[key];
            this.extra = mapToString(map);
        }
        return this;
    }

    getTag(key: string): string {
        return key && key.length > 0? extraToKeyValues(this.extra)[key] : null;
    }

    getExtra(): string {
        return this.extra;
    }

    setCorrelationId(correlationId: string): EventEnvelope {
        this.correlationId = correlationId;
        return this;
    }

    getCorrelationId(): string {
        return this.correlationId;
    }
    
    setTraceId(traceId: string): EventEnvelope {
        this.traceId = traceId;
        return this;
    }

    getTraceId(): string {
        return this.traceId;
    }

    setTracePath(tracePath: string): EventEnvelope {
        this.tracePath = tracePath;
        return this;
    }

    getTracePath(): string {
        return this.tracePath;
    }

    setBroadcast(broadcast: boolean): EventEnvelope {
        this.broadcast = broadcast;
        return this;
    }

    getBroadcast(): boolean {
        return this.broadcast;
    }

    setException(exception = true): EventEnvelope {
        if (exception) {
            this.addTag('exception');
        } else {
            this.removeTag('exception');
        }
        return this;
    }

    isException(): boolean {
        return this.getTag('exception') != null? true : false;
    }

    setExecTime(execTime: number): EventEnvelope {
        this.execTime = execTime;
        return this;
    }

    getExecTime(): number {
        return this.execTime;
    }

    setRoundTrip(roundTrip: number): EventEnvelope {
        this.roundTrip = roundTrip;
        return this;
    }

    getRoundTrip(): number {
        return this.roundTrip;
    }

    toMap(): object {
        const result = {};
        result['id'] = this.id;
        if (this.to != null) {
            result['to'] = this.to;
        }
        if (this.sender != null) {
            result['from'] = this.sender;
        }
        result['headers'] = this.headers instanceof Object? this.headers : {};
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

    fromMap(map: object): EventEnvelope {
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
            this.headers = headers instanceof Object? headers : {};
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
            this.broadcast = map['broadcast']? true : false;
        }
        if ('exec_time' in map) {
            this.execTime = util.getFloat(map['exec_time'], 3);
        }
        if ('round_trip' in map) {
            this.roundTrip = util.getFloat(map['round_trip'], 3);
        }
        return this;
    }

    toBytes(): Buffer {
        return pack(this.toMap());
    }

    fromBytes(b: Buffer): EventEnvelope {
        this.fromMap(unpack(b));
        return this;
    }

    clone(event: EventEnvelope): EventEnvelope {
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