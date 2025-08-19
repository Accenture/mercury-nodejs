import { Flows } from './flows.js';
import { Flow } from './flow.js';
import { Utility } from '../util/utility.js';
import { Logger } from '../util/logger.js';
import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from './event-envelope.js';

const TIMEOUT = "timeout";
const util = new Utility();
const po = new PostOffice();
const log = Logger.getInstance();

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class FlowInstance {
    dataset = {};
    shared = {};
    tasks = [];
    pendingTasks = {};
    pipeCounter = 0;
    pipeMap = {};
    start = new Date();
    id = util.getUuid();
    cid: string;
    replyTo: string;
    private readonly timeoutWatcher: NodeJS.Timeout;
    private readonly template: Flow;
    private readonly parentId: string;
    private traceId: string;
    private tracePath: string;
    private responded = false;
    private topLevelException = false;
    private running = true;

    constructor(flowId: string, cid: string, replyTo: string, template: Flow, parentId: string) {
        this.template = template;
        this.cid = cid;
        this.replyTo = replyTo;
        // initialize the state machine
        const model = {'instance': this.id, 'cid': cid, 'flow': flowId}
        
        if (parentId) {
            const parent = this.resolveParent(parentId);
            if (parent) {
                model['parent'] = parent.shared;
                model['root'] = parent.shared;
                this.parentId = parent.id;
                log.info(`${this.getFlow().id}:${this.id} extends ${parent.getFlow().id}:${parent.id}`);
            }
        } else {
            // this is a sub-flow if parent flow instance is available
            this.parentId = null;
            model['parent'] = this.shared;
            model['root'] = this.shared;
        }
        this.dataset['model'] = model;
        const timeoutTask = new EventEnvelope().setTo('task.executor');
        timeoutTask.setCorrelationId(this.id).setHeader(TIMEOUT, 'true');
        this.timeoutWatcher = po.sendLater(timeoutTask, template.ttl);
    }

    private resolveParent(parentId: string): FlowInstance {
        const parent = Flows.getFlowInstance(parentId);
        if (parent) {
            const pid = parent.parentId;
            if (pid) {
                return this.resolveParent(pid);                
            } else {
                return parent;
            }
        } else {
            return null;
        }
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

    topLevelExceptionHappened(): boolean {
        return this.topLevelException;
    }

    setExceptionAtTopLevel(state: boolean): void {
        this.topLevelException = state;
    }

    getFlow(): Flow {
        return this.template;
    }
}
