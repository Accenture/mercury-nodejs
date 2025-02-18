export declare class Platform {
    private static singleton;
    private constructor();
    /**
     * Obtain the singleton instance of Platform
     *
     * @returns instance
     */
    static getInstance(): Platform;
    /**
     * Retrieve unique application instance ID (i.e. "originId")
     *
     * @returns originId
     */
    getOriginId(): string;
    /**
     * Retrieve application name
     *
     * @returns application name
     */
    getName(): string;
    /**
     * Retrieve the system's start time
     *
     * @returns start time
     */
    getStartTime(): Date;
    /**
     * Wait for the platform system to load essential services
     *
     * @returns true
     */
    getReady(): Promise<boolean>;
    /**
     * Register a composable class with a route name.
     *
     * Your composable function will be registered as PRIVATE unless you set isPrivate=false.
     * PUBLIC function is reachable by a peer from the Event API Endpoint "/api/event".
     * PRIVATE function is invisible outside the current application instance.
     * INTERCEPTOR function's return value is ignored because it is designed to forward events.
     *
     * Note that the class must implement the Composable interface
     * and the handleEvent function should be an asynchronous function or a function that returns a promise.
     *
     * The handleEvent function can throw an Error or an AppException.
     * With AppException, you can set status code and message.
     *
     * @param route name
     * @param composable class implementing the initialize and handleEvent methods
     * @param instances number of workers for this function
     * @param isPrivate true or false
     * @param interceptor true or false
     */
    register(route: string, composable: object, instances?: number, isPrivate?: boolean, interceptor?: boolean): void;
    /**
     * Release a previously registered function
     *
     * @param route name
     */
    release(route: string): void;
    /**
     * Check if a route is private
     *
     * @param route name of a function
     * @returns true if private and false if public
     * @throws Error(Route 'name' not found)
     */
    isPrivate(route: string): any;
    /**
     * Stop the platform.
     * (REST automation and outstanding streams, if any, will be automatically stopped.)
     */
    stop(): Promise<void>;
    /**
     * Check if the platform is shutting down
     *
     * @returns true or false
     */
    isStopping(): boolean;
    /**
     * You can use this method to keep the event system running in the background
     */
    runForever(): Promise<void>;
}
