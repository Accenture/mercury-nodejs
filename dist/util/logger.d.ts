export declare class Logger {
    private static singleton;
    private logger;
    private constructor();
    static getInstance(): Logger;
    setJsonFormat(jsonFormat: boolean): void;
    getLevel(): string;
    setLevel(level: string): void;
    info(message: string | object, e?: Error): void;
    warn(message: string | object, e?: Error): void;
    debug(message: string | object, e?: Error): void;
    error(message: string | object, e?: Error): void;
}
