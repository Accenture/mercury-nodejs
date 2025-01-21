/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class JoinTaskInfo {
    forks;
    joinTask;
    resultCount = 0;
    constructor(forks, joinTask) {
        this.forks = forks;
        this.joinTask = joinTask;
    }
    getType() {
        return 'join';
    }
}
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class PipelineInfo {
    task;
    ptr = -1;
    completed = false;
    constructor(task) {
        this.task = task;
    }
    getType() {
        return 'pipeline';
    }
    nextStep() {
        if (this.ptr < this.task.pipelineSteps.length) {
            this.ptr++;
            return this.ptr;
        }
        else {
            return this.task.pipelineSteps.length - 1;
        }
    }
    getExitTask() {
        return this.task.nextSteps[0];
    }
    getTaskName(n) {
        return this.task.pipelineSteps[n];
    }
    isLastStep(n) {
        return n >= this.task.pipelineSteps.length - 1;
    }
    resetPointer() {
        this.ptr = 0;
        this.completed = false;
    }
    setCompleted() {
        this.completed = true;
    }
    isCompleted() {
        return this.completed;
    }
    getTask() {
        return this.task;
    }
}
//# sourceMappingURL=pipe.js.map