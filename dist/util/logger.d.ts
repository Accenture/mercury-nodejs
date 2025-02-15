export declare class Logger {
    private static instance;
    private logger;
    private constructor();
    static getInstance(): Logger;
    /**
     * This method is reserved by the platform.
     * Do not use this directly.
     *
     * @param format is 0 (text), 1 (compact), 2 (json)
     */
    setLogFormat(format: number): void;
    /**
     * Retreive the log level (info, warn, error, debug)
     * @returns log level
     */
    getLevel(): string;
    /**
     * Set the log level (info, warn, error, debug)
     *
     * @param level to set
     */
    setLevel(level: string): void;
    /**
     * Log a message in info level with the "always" attribute.
     * This means it will always log no matter what log level is.
     * (This method is reserved for distributed trace.
     *  Please do not use this at application level)
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    always(message: string | object, e?: Error): void;
    /**
     * Log a message in info level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    info(message: string | object, e?: Error): void;
    /**
     * Log a message in warning level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    warn(message: string | object, e?: Error): void;
    /**
     * Log a message in debug level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    debug(message: string | object, e?: Error): void;
    /**
     * Log a message in error level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    error(message: string | object, e?: Error): void;
}
