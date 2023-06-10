export declare class Logger {
    constructor();
    setJsonFormat(jsonFormat: boolean): void;
    getLevel(): string;
    setLevel(level: string): void;
    info(message: string | object, e?: Error): void;
    warn(message: string | object, e?: Error): void;
    debug(message: string | object, e?: Error): void;
    error(message: string | object, e?: Error): void;
}
