export declare class Utility {
    constructor();
    getInstance(): Util;
}
declare class Util {
    getUuid(): string;
    sleep(milliseconds?: number): Promise<unknown>;
    getFloat(n: number, decimalPoint?: number): number;
}
export {};
