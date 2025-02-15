import { Flows } from '../models/flows.js';
import { AppException } from '../models/app-exception.js';
import { Logger } from '../util/logger.js';
const log = Logger.getInstance();
export class EventScriptMock {
    flow;
    constructor(flowId) {
        if (flowId) {
            this.flow = Flows.getFlow(flowId);
            if (!this.flow) {
                throw new AppException(400, `Flow ${String(flowId)} does not exist`);
            }
        }
        else {
            throw new AppException(400, 'Missing flow ID');
        }
    }
    getFunctionRoute(taskName) {
        if (taskName) {
            const task = this.flow.tasks[taskName];
            if (task) {
                return task.functionRoute;
            }
            else {
                throw new AppException(400, `Task ${taskName} does not exist`);
            }
        }
        else {
            throw new AppException(400, 'Missing task name');
        }
    }
    assignFunctionRoute(taskName, mockFunction) {
        if (taskName) {
            if (mockFunction) {
                const task = this.flow.tasks[taskName];
                if (task) {
                    const previous = task.functionRoute;
                    task.reAssign(mockFunction);
                    log.info(`Reassigned '${mockFunction}' to task(${taskName}}) of flow(${this.flow.id}), previous function '${previous}'`);
                    return this;
                }
                else {
                    throw new AppException(400, `Task ${taskName} does not exist`);
                }
            }
            else {
                throw new AppException(400, "Missing mock function route");
            }
        }
        else {
            throw new AppException(400, 'Missing task name');
        }
    }
}
//# sourceMappingURL=event-script-mock.js.map