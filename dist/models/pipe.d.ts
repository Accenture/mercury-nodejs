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
export declare class JoinTaskInfo implements PipeInfo {
    forks: number;
    joinTask: string;
    resultCount: number;
    constructor(forks: number, joinTask: string);
    getType(): string;
}
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class PipelineInfo implements PipeInfo {
    task: Task;
    ptr: number;
    completed: boolean;
    constructor(task: Task);
    getType(): string;
    nextStep(): number;
    getExitTask(): string;
    getTaskName(n: number): string;
    isLastStep(n: number): boolean;
    isSingleton(): boolean;
    resetPointer(): void;
    setCompleted(): void;
    isCompleted(): boolean;
    getTask(): Task;
}
