import { Flow } from './flow.js';
import { FlowInstance } from './flow_instance.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class Flows {
    static readonly allFlows: {};
    static readonly flowInstances: {};
    static getFlow(id: string): Flow;
    static getAllFlows(): string[];
    static getFlowInstance(id?: string): FlowInstance;
    static flowExists(id: string): boolean;
    static addFlow(flow: Flow): void;
    static addFlowInstance(instance: FlowInstance): void;
    static closeFlowInstance(id: string): void;
}
