import { Logger } from '../util/logger.js';
const log = Logger.getInstance();
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class FunctionRegistry {
    static singleton;
    registry;
    constructor() {
        this.registry = SimpleRegistry.getInstance();
    }
    static getInstance() {
        if (FunctionRegistry.singleton === undefined) {
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
     * @param isPrivate is false if function is visible thru event-over-http
     * @param interceptor is true if function is an event interceptor
     */
    save(route, that, instances, isPrivate, interceptor) {
        // save only when it does not exist to guarantee idempotent property
        if (!this.exists(route)) {
            if ('initialize' in that && 'handleEvent' in that &&
                that.initialize instanceof Function && that.handleEvent instanceof Function) {
                log.debug(`Loading ${that.constructor.name} as ${route}`);
                this.registry.save(route, that, instances, isPrivate, interceptor);
            }
            else {
                log.error(`Unable to load ${this.constructor.name} because it does not implement Composable`);
            }
        }
    }
    /**
     * Declare that this route is loaded with a composable function
     *
     * @param route name of the composable function
     */
    load(route) {
        this.registry.load(route);
    }
    /**
     * Check if this route is loaded into the event system
     *
     * @param route name of the composable function
     * @returns true if loaded
     */
    isLoaded(route) {
        return this.registry.isLoaded(route);
    }
    /**
     * Remove a composable function from the registry by route name.
     *
     * @param route of the function
     */
    remove(route) {
        this.registry.remove(route);
    }
    /**
     * Retrieve metadata for the composable function
     *
     * @param route name of the function
     * @returns map of key-values
     */
    getMetadata(route) {
        return this.registry.getMetadata(route);
    }
    /**
     * Retrieve a function by name so that you can register it programmatically.
     * The "PreLoader" will also use this to find functions to register them
     * declaratively.
     *
     * @param route name of the function
     * @returns the function that was previously saved by a library
     */
    get(route) {
        return this.registry.get(route);
    }
    /**
     * Retrieve the class instance of a function
     * (this would be used to invoke other methods in the same class)
     *
     * @param route name of the function
     * @returns the Composable class holding the function
     */
    getClass(route) {
        return this.registry.getClass(route);
    }
    /**
     * Check if a function exists in registry
     *
     * @param route name of the function
     * @returns true if the function exists
     */
    exists(route) {
        return route ? this.registry.exists(route) : false;
    }
    /**
     * Retrieve all function names in registry
     *
     * @returns list of function names
     */
    getFunctionList() {
        return this.registry.getFunctionList();
    }
}
class SimpleRegistry {
    static instance;
    registry = new Map();
    metadata = new Map();
    loaded = new Map();
    constructor() { }
    static getInstance() {
        if (SimpleRegistry.instance === undefined) {
            SimpleRegistry.instance = new SimpleRegistry();
        }
        return SimpleRegistry.instance;
    }
    save(route, that, instances, isPrivate, interceptor) {
        if (route && 'initialize' in that && 'handleEvent' in that
            && that['initialize'] instanceof Function && that['handleEvent'] instanceof Function) {
            this.registry.set(route, that);
            this.metadata.set(route, { 'instances': instances, 'private': isPrivate, 'interceptor': interceptor });
        }
        else {
            throw new Error('Invalid Composable class');
        }
    }
    remove(route) {
        if (this.exists(route)) {
            this.registry.delete(route);
            this.metadata.delete(route);
            this.loaded.delete(route);
        }
    }
    getMetadata(route) {
        return this.metadata.get(route);
    }
    get(route) {
        const cls = this.registry.get(route);
        if (cls && 'handleEvent' in cls) {
            return cls['handleEvent'];
        }
        else {
            return null;
        }
    }
    getClass(route) {
        return this.registry.has(route) ? this.registry.get(route) : null;
    }
    exists(route) {
        return this.registry.has(route);
    }
    load(route) {
        if (this.exists(route)) {
            this.loaded.set(route, true);
        }
    }
    isLoaded(route) {
        return this.loaded.has(route);
    }
    getFunctionList() {
        return Array.from(this.registry.keys());
    }
}
//# sourceMappingURL=function-registry.js.map