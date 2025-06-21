/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class Task {
    init: string[] = [];
    comparator: string[] = [];
    sequencer: string[] = [];
    conditions: object[] = [];
    input: string[] = [];
    output: string[] = [];
    nextSteps: string[] = [];
    pipelineSteps: string[] = [];
    service: string;
    functionRoute: string;
    execution: string;
    private delay = -1;
    private delayVar: string = null;
    private joinTask: string = null;
    private exceptionTask: string = null;
    private loopType = "none";
    private whileModelKey: string = null;

    constructor(service: string, functionRoute: string, execution: string) {
        this.service = service;
        this.functionRoute = functionRoute ?? service;
        this.execution = execution;
    }

    reAssign(functionRoute: string): void {
        this.functionRoute = functionRoute;
    }

    setJoinTask(task: string) {
        this.joinTask = task;
    }

    getJoinTask(): string {
        return this.joinTask;
    }

    setExceptionTask(task: string) {
        this.exceptionTask = task;
    }

    getExceptionTask(): string {
        return this.exceptionTask;
    }

    toString(): string {
        return JSON.stringify(this);
    }

    setDelay(delay: number) {
        this.delay = delay;
    }

    getDelay(): number {
        return this.delay;
    }

    getDelayVar(): string {
        return this.delayVar;
    }

    setDelayVar(delayVar: string) {
        this.delayVar = delayVar;
    }

    setLoopType(loopType: string) {
        this.loopType = loopType;
    }

    getLoopType(): string {
        return this.loopType;
    }

    getWhileModelKey(): string {
        return this.whileModelKey;
    }

    setWhileModelKey(whileModelKey: string) {
        this.whileModelKey = whileModelKey;
    }
}
