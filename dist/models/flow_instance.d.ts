import { Flow } from './flow.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class FlowInstance {
    dataset: {};
    shared: {};
    tasks: any[];
    pendingTasks: {};
    pipeCounter: number;
    pipeMap: {};
    start: Date;
    id: string;
    cid: string;
    replyTo: string;
    private readonly timeoutWatcher;
    private readonly template;
    private readonly parentId;
    private traceId;
    private tracePath;
    private responded;
    private topLevelException;
    private running;
    constructor(flowId: string, cid: string, replyTo: string, template: Flow, parentId: string);
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
    topLevelExceptionHappened(): boolean;
    setExceptionAtTopLevel(state: boolean): void;
    getFlow(): Flow;
}
