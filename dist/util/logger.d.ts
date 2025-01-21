export declare class Logger {
    private static singleton;
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
