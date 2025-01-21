/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class Flow {
    tasks = {};
    id;
    ttl;
    firstTask;
    externalStateMachine;
    exception;
    constructor(id, firstTask, externalStateMachine, duration, exception) {
        this.id = id;
        this.firstTask = firstTask;
        this.externalStateMachine = externalStateMachine;
        this.exception = exception;
        this.ttl = duration;
    }
    addTask(entry) {
        this.tasks[entry.service] = entry;
    }
}
//# sourceMappingURL=flow.js.map