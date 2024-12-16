import { MultiLevelMap } from './multi-level-map.js';
export declare class AppConfig {
    constructor(configFileOrMap?: string | object);
    getReader(): ConfigReader;
}
export declare class ConfigReader {
    private config;
    private loopDetection;
    private instance;
    constructor(configFileOrMap?: string | object, isBaseConfig?: boolean);
    getId(): string;
    getMap(): object;
    exists(key: string): boolean;
    isEmpty(): boolean;
    /**
     * Retrieve a key-value
     *
     * Support the dollar-bracket syntax to retrieve environment variable or another key-value
     * in the base configuration file ('application.yml')
     *
     * @param key of the item
     * @param defaultValue if item does not exist
     * @param loop reserved for internal use to detect a configuation loop
     * @returns value of the item
     */
    get(key: string, defaultValue?: any, loop?: string): any;
    extractSegments(original: string): EnvVarSegment[];
    performEnvVarSubstitution(key: string, text: string, defaultValue?: any, loop?: string): string;
    /**
     * Retrieve a key-value where value is enforced as a string
     *
     * @param key of the item
     * @param defaultValue if item does not exist
     * @returns value of the item
     */
    getProperty(key: string, defaultValue?: string): string;
    /**
     * Set a key-value
     *
     * @param key of the item
     * @param value of the item
     * @returns this ConfigReader
     */
    set(key: string, value: any): ConfigReader;
    /**
     * Reserved for internal use
     * -------------------------
     *
     * Reload configuration parameters with a given map
     *
     * @returns this ConfigReader
     */
    reload(map: MultiLevelMap): ConfigReader;
}
declare class EnvVarSegment {
    start: number;
    end: number;
    constructor(start: number, end: number);
}
export {};
