import { Flow } from './flow.js';
import { Utility } from '../util/utility.js';
import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from './event-envelope.js';

const TIMEOUT = "timeout";
const util = new Utility();
const po = new PostOffice();

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class FlowInstance {
    dataset = {};
    tasks = [];
    pendingTasks = {};
    pipeCounter = 0;
    pipeMap = {};
    start = new Date();
    id = util.getUuid();
    cid: string;
    replyTo: string;
    private timeoutWatcher: NodeJS.Timeout;
    private flow: Flow;
    private traceId: string;
    private tracePath: string;
    private responded = false;
    private running = true;

    constructor(flowId: string, cid: string, replyTo: string, flow: Flow) {
        this.flow = flow;
        this.cid = cid;
        this.replyTo = replyTo;
        // initialize the state machine
        const model = {'instance': this.id, 'cid': cid, 'flow': flowId}
        this.dataset['model'] = model;
        const timeoutTask = new EventEnvelope().setTo('task.executor');
        timeoutTask.setCorrelationId(this.id).setHeader(TIMEOUT, 'true');
        this.timeoutWatcher = po.sendLater(timeoutTask, flow.ttl);
    }

    setTrace(traceId: string, tracePath: string): void {
        this.traceId = traceId;
        this.tracePath = tracePath;
        if (traceId) {
            const model = this.dataset['model'];
            model['trace'] = traceId;
        }
    }

    getStartMillis() {
        return this.start.getTime();
    }

    close(): void {
        if (this.running) {
            this.running = false;
            po.cancelFutureEvent(this.timeoutWatcher);
        }
    }

    isNotResponded(): boolean {
        return !this.responded;
    }

    setResponded(responded: boolean): void {
        this.responded = responded;
    }

    getTraceId(): string {
        return this.traceId;
    }

    setTraceId(traceId: string): void {
        this.traceId = traceId;
    }

    getTracePath(): string {
        return this.tracePath;
    }

    setTracePath(tracePath: string): void {
        this.tracePath = tracePath;
    }

    getFlow(): Flow {
        return this.flow;
    }
}
