export declare class Utility {
    constructor();
    getInstance(): Util;
}
declare class Util {
    private cache;
    getUuid(): string;
    sleep(milliseconds?: number): Promise<unknown>;
    getFloat(n: number, decimalPoint?: number): number;
    saveCache(key: string, value: any, expirySeconds: number): boolean;
    getCached(key: string): unknown;
    removeCache(key: string): void;
    cacheExists(key: string): boolean;
    cacheStats(): object;
    cacheCount(): number;
    cacheHits(): number;
    cacheMisses(): number;
    cacheKeySize(): number;
    cacheValueSize(): number;
}
export {};
