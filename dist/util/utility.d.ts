import { MultiLevelMap } from './multi-level-map.js';
export declare class Utility {
    getUuid(): string;
    sleep(milliseconds?: number): Promise<unknown>;
    getFloat(n: number, decimalPoint?: number): number;
    str2int(s: string): number;
    str2float(s: string): number;
    isDigits(text: string): boolean;
    validRouteName(route: string): boolean;
    getElapsedTime(milliseconds: number): string;
    getLocalTimestamp(milliseconds?: number): string;
    getDurationInSeconds(duration: string): number;
    loadYamlFile(filePath: string): MultiLevelMap;
    normalizeFilePath(filePath: string): string;
    mkdirsIfNotExist(path: string): void;
}
