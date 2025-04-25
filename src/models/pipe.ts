import { Task } from './task.js';

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export interface PipeInfo {
    getType(): string;
}

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class JoinTaskInfo implements PipeInfo {
    forks: number;
    joinTask: string;
    resultCount = 0;

    constructor(forks: number, joinTask: string) {
        this.forks = forks;
        this.joinTask = joinTask;
    }
    
    getType(): string {
        return 'join';
    }    
}

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class PipelineInfo implements PipeInfo {
    task: Task;
    ptr = -1;
    completed = false;

    constructor(task: Task) {
        this.task = task;
    }

    getType(): string {
        return 'pipeline';
    } 

    nextStep(): number {
        if (this.ptr < this.task.pipelineSteps.length) {
            this.ptr++;
            return this.ptr;
        } else {
            return this.task.pipelineSteps.length - 1;
        }
    }

    getExitTask(): string {
        return this.task.nextSteps[0];
    }

    getTaskName(n: number): string {
        return this.task.pipelineSteps[Math.min(n, this.task.pipelineSteps.length-1)];
    }

    isLastStep(n: number): boolean {
        return n >= this.task.pipelineSteps.length - 1;
    }

    isSingleton(): boolean {
        return this.task.pipelineSteps.length == 1;
    }

    resetPointer(): void {
        this.ptr = 0;
        this.completed = false;
    }

    setCompleted(): void {
        this.completed = true;
    }

    isCompleted(): boolean {
        return this.completed;
    }

    getTask(): Task {
        return this.task;
    }
}
