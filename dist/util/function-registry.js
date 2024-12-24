import { Logger } from '../util/logger.js';
const log = Logger.getInstance();
export class FunctionRegistry {
    static singleton;
    registry;
    constructor() {
        this.registry = new SimpleRegistry();
    }
    static getInstance() {
        if (!FunctionRegistry.singleton) {
            FunctionRegistry.singleton = new FunctionRegistry();
        }
        return FunctionRegistry.singleton;
    }
    /**
     * Save a Composable function to the registry by name.
     *
     * @param route of the composable function
     * @param that is the class instance of the Composable function
     * @param instances for concurrency
     * @param isPublic is true if function is visible thru event-over-http
     * @param isInterceptor is true if function is an event interceptor
     */
    saveFunction(route, that, instances, isPublic, isInterceptor) {
        log.info(`Loading ${that.constructor.name} as ${route}`);
        this.registry.saveFunction(route, that, instances, isPublic, isInterceptor);
    }
    /**
     * Remove a composable function from the registry by name.
     *
     * @param name of the function
     */
    removeFunction(name) {
        this.registry.removeFunction(name);
    }
    /**
     * Retrieve metadata for the composable function
     *
     * @param name of the function
     * @returns map of key-values
     */
    getMetadata(name) {
        return this.registry.getMetadata(name);
    }
    /**
     * Retrieve a function by name so that you can register it programmatically.
     * The "PreLoader" will also use this to find functions to register them
     * declaratively.
     *
     * @param name of the function
     * @returns the function that was previously saved by a library
     */
    getFunction(name) {
        return this.registry.getFunction(name);
    }
    /**
     * Retrieve the class instance of a function
     * (this would be used to invoke other methods in the same class)
     *
     * @param name of the function
     * @returns the Composable class holding the function
     */
    getClass(name) {
        return this.registry.getClass(name);
    }
    /**
     * Check if a function exists in registry
     *
     * @param name of the function
     * @returns true if the function exists
     */
    exists(name) {
        return name ? this.registry.exists(name) : false;
    }
    /**
     * Retrieve all function names in registry
     *
     * @returns list of function names
     */
    getFunctions() {
        return this.registry.getFunctions();
    }
}
class SimpleRegistry {
    registry = new Map();
    metadata = new Map();
    saveFunction(route, that, instances, isPublic, isInterceptor) {
        if (route && 'initialize' in that && 'handleEvent' in that
            && that['initialize'] instanceof Function && that['handleEvent'] instanceof Function) {
            this.registry.set(route, that);
            this.metadata.set(route, { 'instances': instances, 'public': isPublic, 'interceptor': isInterceptor });
        }
        else {
            throw new Error('Invalid Composable class');
        }
    }
    removeFunction(name) {
        if (this.exists(name)) {
            this.registry.delete(name);
            this.metadata.delete(name);
        }
    }
    getMetadata(name) {
        return this.metadata.get(name);
    }
    getFunction(name) {
        const cls = this.registry.get(name);
        if (cls && 'handleEvent' in cls) {
            return cls['handleEvent'];
        }
        else {
            return null;
        }
    }
    getClass(name) {
        const cls = this.registry.get(name);
        return cls ? cls : null;
    }
    exists(name) {
        return this.getFunction(name) != null;
    }
    getFunctions() {
        return Array.from(this.registry.keys());
    }
}
//# sourceMappingURL=function-registry.js.map