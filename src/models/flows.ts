import { Flow } from './flow.js';
import { FlowInstance } from './flow_instance.js';

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class Flows {
    static allFlows = {};
    static flowInstances = {};

    static getFlow(id: string): Flow {
        return Flows.allFlows[id];
    }

    static getAllFlows(): string[] {
        return Object.keys(Flows.allFlows);
    }

    static getFlowInstance(id?: string) {
        return id? Flows.flowInstances[id] : null;
    }

    static flowExists(id: string): boolean {
        return id in Flows.allFlows;
    }

    static addFlow(flow: Flow): void {
        Flows.allFlows[flow.id] = flow;
    }

    static addFlowInstance(instance: FlowInstance): void {
        Flows.flowInstances[instance.id] = instance;
    }

    static closeFlowInstance(id: string): void {
        if (id in Flows.flowInstances) {
            delete Flows.flowInstances[id];
        }
    }
}
