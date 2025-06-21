/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class Flows {
    static allFlows = {};
    static flowInstances = {};
    static getFlow(id) {
        const result = Flows.allFlows[id];
        return result ?? null;
    }
    static getAllFlows() {
        return Object.keys(Flows.allFlows);
    }
    static getFlowInstance(id) {
        const result = id ? Flows.flowInstances[id] : null;
        return result ?? null;
    }
    static flowExists(id) {
        return id in Flows.allFlows;
    }
    static addFlow(flow) {
        Flows.allFlows[flow.id] = flow;
    }
    static addFlowInstance(instance) {
        Flows.flowInstances[instance.id] = instance;
    }
    static closeFlowInstance(id) {
        if (id in Flows.flowInstances) {
            delete Flows.flowInstances[id];
        }
    }
}
//# sourceMappingURL=flows.js.map