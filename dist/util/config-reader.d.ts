import { MultiLevelMap } from './multi-level-map.js';
export declare class AppConfig {
    private static singleton;
    private static reader;
    private constructor();
    static getInstance(resourcePath?: string): ConfigReader;
}
export declare class ConfigReader {
    private static self;
    private config;
    private loopDetection;
    private resolved;
    private id;
    /**
     * Create an instance of a ConfigReader
     *
     * @param configResource is a config file path or a key-value JSON object
     * @param isBaseConfig is true when this ConfigReader is the base AppReader
     */
    constructor(configResource?: string | object, isBaseConfig?: boolean);
    getId(): string;
    resolveFilePath(configFile: string): string;
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
     * Reload configuration parameters with a given map
     *
     * @returns this ConfigReader
     */
    reload(map: MultiLevelMap): ConfigReader;
    private resolveEnvVars;
    private extractSegments;
    private performEnvVarSubstitution;
}
