import { FunctionRegistry } from "../system/function-registry.js";
import { Logger } from "../util/logger.js";
const log = Logger.getInstance();
/**
 * Annotation for a composable class
 *
 * @param route name (aka functional topic)
 * @param instances to define concurrency
 * @param isPrivate is false if this function is reachable thru event-over-http
 * @param interceptor is true if this function is an event interceptor
 * @returns annotated function
 */
export function preload(route, instances = 1, isPrivate = true, interceptor = false) {
    return function (_target, propertyKey, descriptor) {
        if ('initialize' == propertyKey) {
            const method = descriptor.value;
            descriptor.value = function (...args) {
                const registry = FunctionRegistry.getInstance();
                registry.save(route, this, Math.min(500, Math.max(1, instances)), isPrivate, interceptor);
                return method.apply(this, args);
            };
        }
        else {
            log.error(`Please annotate the 'initialize' method in a Composable - @preload does not apply to ${propertyKey}`);
        }
    };
}
//# sourceMappingURL=composable.js.map