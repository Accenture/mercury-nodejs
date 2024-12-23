import { EventEnvelope } from '../models/event-envelope.js';
import { Logger } from '../util/logger.js';

const log = Logger.getInstance();
let self: SimpleRegistry = null;

export class FunctionRegistry {

    constructor() {
        if (self == null) {
            self = new SimpleRegistry();
        }
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
    saveFunction(route: string, 
                 that: object, instances: number, isPublic: boolean, isInterceptor: boolean): void {
        log.info(`Loading ${that.constructor.name} as ${route}`);
        self.saveFunction(that, instances, isPublic, isInterceptor);
    }

    /**
     * Remove a composable function from the registry by name.
     * 
     * @param name of the function
     */
    removeFunction(name: string): void {
        self.removeFunction(name);
    }

    /**
     * Retrieve metadata for the composable function
     * 
     * @param name of the function
     * @returns map of key-values
     */
    getMetadata(name: string): object {
        return self.getMetadata(name);
    }

    /**
     * Retrieve a function by name so that you can register it programmatically.
     * The "PreLoader" will also use this to find functions to register them
     * declaratively.
     * 
     * @param name of the function
     * @returns the function that was previously saved by a library
     */
    getFunction(name: string): (evt: EventEnvelope) => void  {
        return self.getFunction(name);
    }

    /**
     * Retrieve the class instance of a function
     * (this would be used to invoke other methods in the same class)
     * 
     * @param name of the function
     * @returns the Composable class holding the function
     */
    getClass(name: string): object {
        return self.getClass(name);
    }

    /**
     * Check if a function exists in registry
     * 
     * @param name of the function
     * @returns true if the function exists
     */
    exists(name?: string): boolean {        
        return name? self.exists(name) : false;
    }
    
    /**
     * Retrieve all function names in registry
     * 
     * @returns list of function names
     */
    getFunctions(): Array<string> {
        return self.getFunctions();
    }

}

class SimpleRegistry {
    
    private registry = new Map<string, object>();
    private metadata = new Map<string, object>();

    saveFunction(that: object, instances: number, isPublic: boolean, isInterceptor: boolean): void {
        let valid = false;
        if ('name' in that && 'initialize' in that && 'getName' in that && 'handleEvent' in that) {
            const name = that['name'];
            const f1 = that['initialize'];
            const f2 = that['getName'];
            const f3 = that['handleEvent'];
            if (typeof name == 'string' && f1 instanceof Function && f2 instanceof Function && f3 instanceof Function) {
                valid = true;                
                this.registry.set(name, that);
                this.metadata.set(name, {'instances': instances, 'public': isPublic, 'interceptor': isInterceptor});
            }
        }
        if (!valid) {
            throw new Error('Invalid Composable class');
        }
    }

    removeFunction(name: string): void {
        if (this.exists(name)) {
            this.registry.delete(name);
            this.metadata.delete(name);
        }
    }

    getMetadata(name: string): object {
        return this.metadata.get(name);
    }

    getFunction(name: string): (evt: EventEnvelope) => void {
        const cls = this.registry.get(name);
        if (cls && 'handleEvent' in cls) {
            return cls['handleEvent'] as (evt: EventEnvelope) => void;
        } else {
            return null;
        }
    }

    getClass(name: string): object {
        const cls = this.registry.get(name);
        return cls? cls : null;
    }

    exists(name: string): boolean {
        return this.getFunction(name) != null;
    }

    getFunctions(): Array<string> {
        return Array.from(this.registry.keys());
    }

}