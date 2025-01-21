import { Task } from './task.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class Flow {
    tasks: {};
    id: string;
    ttl: number;
    firstTask: string;
    externalStateMachine: string;
    exception: string;
    constructor(id: string, firstTask: string, externalStateMachine: string, duration: number, exception: string);
    addTask(entry: Task): void;
}
