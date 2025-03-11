import { Flow } from './flow.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class FlowInstance {
    dataset: {};
    tasks: any[];
    pendingTasks: {};
    pipeCounter: number;
    pipeMap: {};
    start: Date;
    id: string;
    cid: string;
    replyTo: string;
    private timeoutWatcher;
    private flow;
    private traceId;
    private tracePath;
    private parentId;
    private responded;
    private running;
    constructor(flowId: string, cid: string, replyTo: string, flow: Flow, parentId: string);
    private resolveParent;
    setTrace(traceId: string, tracePath: string): void;
    getStartMillis(): number;
    close(): void;
    isNotResponded(): boolean;
    setResponded(responded: boolean): void;
    getTraceId(): string;
    setTraceId(traceId: string): void;
    getTracePath(): string;
    setTracePath(tracePath: string): void;
    getFlow(): Flow;
}
