import { EventEnvelope } from '../models/event-envelope.js';

let self: SimpleRegistry = null;

export class FunctionRegistry {

    constructor() {
        if (self == null) {
            self = new SimpleRegistry();
        }
    }

    /**
     * Save a function to the registry by name.
     * 
     * This is used when you publish a library with reusable functions and
     * you want to expose the functions by names for subsequent registration
     * by the user application.
     * 
     * @param name of the function
     * @param listener is the function reference
     */
    saveFunction(name: string, listener: (evt: EventEnvelope) => void) {
        self.saveFunction(name, listener);
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
    
    private functionRegistry = new Map<string, (evt: EventEnvelope) => void>();

    saveFunction(name: string, listener: (evt: EventEnvelope) => void) {
        if (listener instanceof Function) {
            this.functionRegistry.set(name, listener);
        } else {
            throw new Error('Invalid listener function');
        }
    }

    getFunction(name: string): (evt: EventEnvelope) => void {
        const result = this.functionRegistry.get(name);
        return result? result : null;
    }

    exists(name: string): boolean {
        return this.getFunction(name) != null;
    }

    getFunctions(): Array<string> {
        return Array.from(this.functionRegistry.keys());
    }

}