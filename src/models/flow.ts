import { Task } from './task.js';

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class Flow {
    tasks = {};
    id: string;
    ttl: number;
    firstTask: string;
    externalStateMachine: string;
    exception: string;

    constructor(id: string, firstTask: string, externalStateMachine: string, duration: number, exception: string) {
        this.id = id;
        this.firstTask = firstTask;
        this.externalStateMachine = externalStateMachine;
        this.exception = exception;
        this.ttl = duration;
    }

    addTask(entry: Task) {
        this.tasks[entry.service] = entry;
    }
}