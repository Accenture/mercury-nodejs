import { FunctionRegistry } from "../util/function-registry.js";
import { Logger } from "../util/logger.js";
const log = Logger.getInstance();
const registry = new FunctionRegistry();
/**
 * Annotation for a composable class
 *
 * @param instances to define concurrency
 * @param isPublic is true if this function is reachable thru event-over-http
 * @param isInterceptor is true if this function is an event interceptor
 * @returns annotated function
 */
export function preload(instances = 1, isPublic = false, isInterceptor = false) {
    return function (_target, propertyKey, descriptor) {
        if ('initialize' == propertyKey) {
            const method = descriptor.value;
            descriptor.value = function (...args) {
                if (this.name && this.handleEvent instanceof Function) {
                    registry.saveFunction(this.name, this, Math.min(500, Math.max(1, instances)), isPublic, isInterceptor);
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