/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class Task {
    init = [];
    comparator = [];
    sequencer = [];
    conditions = [];
    input = [];
    output = [];
    nextSteps = [];
    pipelineSteps = [];
    service;
    functionRoute;
    execution;
    delay = -1;
    delayVar = null;
    joinTask = null;
    exceptionTask = null;
    loopType = "none";
    whileModelKey = null;
    constructor(service, functionRoute, execution) {
        this.service = service;
        this.functionRoute = functionRoute ?? service;
        this.execution = execution;
    }
    reAssign(functionRoute) {
        this.functionRoute = functionRoute;
    }
    setJoinTask(task) {
        this.joinTask = task;
    }
    getJoinTask() {
        return this.joinTask;
    }
    setExceptionTask(task) {
        this.exceptionTask = task;
    }
    getExceptionTask() {
        return this.exceptionTask;
    }
    toString() {
        return JSON.stringify(this);
    }
    setDelay(delay) {
        this.delay = delay;
    }
    getDelay() {
        return this.delay;
    }
    getDelayVar() {
        return this.delayVar;
    }
    setDelayVar(delayVar) {
        this.delayVar = delayVar;
    }
    setLoopType(loopType) {
        this.loopType = loopType;
    }
    getLoopType() {
        return this.loopType;
    }
    getWhileModelKey() {
        return this.whileModelKey;
    }
    setWhileModelKey(whileModelKey) {
        this.whileModelKey = whileModelKey;
    }
}
//# sourceMappingURL=task.js.map