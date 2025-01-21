import { Flows } from '../models/flows.js';
import { AppException } from '../models/app-exception.js';
import { Logger } from '../util/logger.js';
const log = Logger.getInstance();
export class EventScriptMock {
    flow;
    constructor(flowId) {
        if (!flowId) {
            throw new AppException(400, 'Missing flow ID');
        }
        this.flow = Flows.getFlow(flowId);
        if (!this.flow) {
            throw new AppException(400, `Flow ${String(flowId)} does not exist`);
        }
    }
    getFunctionRoute(taskName) {
        if (!taskName) {
            throw new AppException(400, 'Missing task name');
        }
        const task = this.flow.tasks[taskName];
        if (!task) {
            throw new AppException(400, `Task ${taskName} does not exist`);
        }
        return task.functionRoute;
    }
    assignFunctionRoute(taskName, mockFunction) {
        if (!taskName) {
            throw new AppException(400, 'Missing task name');
        }
        if (!mockFunction) {
            throw new AppException(400, "Missing mock function route");
        }
        const task = this.flow.tasks[taskName];
        if (!task) {
            throw new AppException(400, `Task ${taskName} does not exist`);
        }
        const previous = task.functionRoute;
        task.reAssign(mockFunction);
        log.info(`Reassigned '${mockFunction}' to task(${taskName}}) of flow(${this.flow.id}), previous function '${previous}'`);
        return this;
    }
}
//# sourceMappingURL=event-script-mock.js.map