import { Task } from './task.js';
export interface PipeInfo {
    getType(): string;
}
export declare class JoinTaskInfo implements PipeInfo {
    forks: number;
    joinTask: string;
    resultCount: number;
    constructor(forks: number, joinTask: string);
    getType(): string;
}
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
    resetPointer(): void;
    setCompleted(): void;
    isCompleted(): boolean;
    getTask(): Task;
}
