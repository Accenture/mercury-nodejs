export declare class Logger {
    constructor();
    getInstance(): LogSystem;
}
declare class LogSystem {
    private logLevel;
    constructor();
    validLevel(level: string): boolean;
    getLevel(): string;
    setLevel(level: string): void;
    info(message: string | object, e?: Error): void;
    warn(message: string | object, e?: Error): void;
    debug(message: string | object, e?: Error): void;
    error(message: string | object, e?: Error): void;
}
export {};
