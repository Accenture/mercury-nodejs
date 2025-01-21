/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class Task {
    init: string[];
    comparator: string[];
    sequencer: string[];
    conditions: object[];
    input: string[];
    output: string[];
    nextSteps: string[];
    pipelineSteps: string[];
    service: string;
    functionRoute: string;
    execution: string;
    private delay;
    private delayVar;
    private joinTask;
    private exceptionTask;
    private loopType;
    private whileModelKey;
    constructor(service: string, functionRoute: string, execution: string);
    reAssign(functionRoute: string): void;
    setJoinTask(task: string): void;
    getJoinTask(): string;
    setExceptionTask(task: string): void;
    getExceptionTask(): string;
    toString(): string;
    setDelay(delay: number): void;
    getDelay(): number;
    getDelayVar(): string;
    setDelayVar(delayVar: string): void;
    setLoopType(loopType: string): void;
    getLoopType(): string;
    getWhileModelKey(): string;
    setWhileModelKey(whileModelKey: string): void;
}
