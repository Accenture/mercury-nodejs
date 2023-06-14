import { FunctionRegistry } from "../util/function-registry.js";
import { Logger } from "../util/logger.js";
const registry = new FunctionRegistry();
const log = new Logger();
export function preload() {
    return function (_target, propertyKey, descriptor) {
        if ('initialize' == propertyKey) {
            const method = descriptor.value;
            descriptor.value = function (...args) {
                if (this.name && this.handleEvent instanceof Function) {
                    log.info(`Loading ${this.constructor.name} as ${this.name}`);
                    registry.saveFunction(this);
                }
                else {
                    log.error(`Unable to load ${this.constructor.name} because it does not implement Composable`);
                }
                return method.apply(this, args);
            };
        }
        else {
            log.error(`Please annotate the 'initialize' method in a Composable - @preload does not apply to ${propertyKey}`);
        }
    };
}
//# sourceMappingURL=composable.js.map