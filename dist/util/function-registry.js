let self = null;
export class FunctionRegistry {
    constructor() {
        if (self == null) {
            self = new SimpleRegistry();
        }
    }
    /**
     * Save a Composable class to the registry by name.
     *
     * @param that is the class instance of the Composable function
     */
    saveFunction(that) {
        self.saveFunction(that);
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
        return self.getFunction(name);
    }
    /**
     * Retrieve the class instance of a function
     * (this would be used to invoke other methods in the same class)
     *
     * @param name of the function
     * @returns the Composable class holding the function
     */
    getClass(name) {
        return self.getClass(name);
    }
    /**
     * Check if a function exists in registry
     *
     * @param name of the function
     * @returns true if the function exists
     */
    exists(name) {
        return name ? self.exists(name) : false;
    }
    /**
     * Retrieve all function names in registry
     *
     * @returns list of function names
     */
    getFunctions() {
        return self.getFunctions();
    }
}
class SimpleRegistry {
    functionRegistry = new Map();
    saveFunction(that) {
        let valid = false;
        if ('name' in that && 'initialize' in that && 'getName' in that && 'handleEvent' in that) {
            const name = that['name'];
            const f1 = that['initialize'];
            const f2 = that['getName'];
            const f3 = that['handleEvent'];
            if (typeof name == 'string' && f1 instanceof Function && f2 instanceof Function && f3 instanceof Function) {
                valid = true;
                this.functionRegistry.set(name, that);
            }
        }
        if (!valid) {
            throw new Error('Invalid Composable class');
        }
    }
    getFunction(name) {
        const cls = this.functionRegistry.get(name);
        if (cls && 'handleEvent' in cls) {
            return cls['handleEvent'];
        }
        else {
            return null;
        }
    }
    getClass(name) {
        const cls = this.functionRegistry.get(name);
        return cls ? cls : null;
    }
    exists(name) {
        return this.getFunction(name) != null;
    }
    getFunctions() {
        return Array.from(this.functionRegistry.keys());
    }
}
//# sourceMappingURL=function-registry.js.map