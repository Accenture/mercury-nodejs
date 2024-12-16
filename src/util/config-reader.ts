import fs from 'fs';
import { MultiLevelMap } from './multi-level-map.js';
import { Logger } from './logger.js';
import { Utility } from '../util/utility.js';

const log = new Logger();
const util = new Utility();
let self: ConfigReader = null; 
let sequence = 1;

export class AppConfig {

    constructor(configFileOrMap?: string | object) {
        if (self == null) {
            self = new ConfigReader(configFileOrMap, true);
        }
    }

    getReader(): ConfigReader {
        return self;
    }

}

export class ConfigReader {
    private config: MultiLevelMap;
    private loopDetection = new Map();
    private instance: number;

    constructor(configFileOrMap?: string | object, isBaseConfig = false) {
        if (isBaseConfig) {
            if (self == null) {
                this.instance = 0;
            } else {
                throw new Error('Base configuration is already loaded');
            }
        } else {
            this.instance = sequence++;
        }
        let useDefaultAppConfig = false;
        if (configFileOrMap) {
            if (configFileOrMap && configFileOrMap.constructor == Object) {
                // Input should be a JSON object when using this library in a browser
                if (isBaseConfig) {
                    log.info('Loading base configuration from a JSON object');
                }
                this.config = new MultiLevelMap(configFileOrMap as object).normalizeMap();
            } else if (typeof configFileOrMap == 'string') {
                // File path is only supported when running as a Node.js application
                const configFile = util.normalizeFilePath(String(configFileOrMap));
                const fileExists = configFile && fs.existsSync(configFile);
                if (fileExists) {
                    if (isBaseConfig) {
                        log.info(`Loading base configuration from ${configFile}`);
                    }
                    this.config = util.loadYamlFile(configFile);
                } else {
                    if (isBaseConfig) {
                        log.error(`Config file ${configFile} does not exist. Fall back to resources/application.yml`);                            
                        useDefaultAppConfig = true;                        
                    } else {
                        throw new Error(`Config file ${configFile} does not exist`);
                    }
                }
            } else {
                log.error(`Configuration not loaded because input '${typeof(configFileOrMap)}' is not a file path or a JSON object`);
                this.config = new MultiLevelMap();
            }
        } else {
            if (isBaseConfig) {                         
                useDefaultAppConfig = true;                        
            } else {
                throw new Error(`Input must be a file path or a JSON object`);
            }
        }
        if (useDefaultAppConfig) {         
            const filePath = util.getFolder("../resources/application.yml");
            this.config = util.loadYamlFile(filePath);
        }
    }

    getId(): string {
        return String(this.instance);
    }

    getMap(): object {
        return this.config.getMap();
    }

    exists(key: string): boolean {
        return this.config.exists(key);
    }

    isEmpty(): boolean {
        return this.config.isEmpty();
    }

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
    get(key: string, defaultValue = null, loop?: string) {
        if (!key) {
            return null;
        }
        if (process && key in process.env) {
            return process.env[key];
        }
        const result = this.config.getElement(key, defaultValue);
        if (typeof result == 'string' && self) {
            if (result.lastIndexOf('${') != -1) {
                const segments = this.extractSegments(result);
                segments.reverse();
                let start = 0;
                let sb = '';
                for (const i in segments) {
                    const s = segments[i];
                    const middle = result.substring(s.start+2, s.end-1).trim();
                    const evaluated = this.performEnvVarSubstitution(key, middle, defaultValue, loop);
                    const heading = result.substring(start, s.start);
                    if (heading) {
                        sb += heading;
                    }
                    if (evaluated) {
                        sb += evaluated;
                    }
                    start = s.end;
                }
                const lastSegment = result.substring(start);
                if (lastSegment) {
                    sb += lastSegment;
                }
                return sb? sb : null;
            }
        }
        return result;
    }

    extractSegments(original: string): EnvVarSegment[] {
        const result = [];
        let text = original;
        while (true) {
            const bracketStart = text.lastIndexOf('${');
            const bracketEnd = text.lastIndexOf('}');
            if (bracketStart != -1 && bracketEnd != -1 && bracketEnd > bracketStart) {
                result.push(new EnvVarSegment(bracketStart, bracketEnd+1));
                text = original.substring(0, bracketStart);
            } else if (bracketStart != -1) {
                text = original.substring(0, bracketStart);
            } else {
                break;
            }
        }
        return result;
    }

    performEnvVarSubstitution(key: string, text: string, defaultValue = null, loop?: string): string {
        if (text) {
            let middleDefault = null;
            const loopId = String(loop? loop : util.getUuid());
            const colon = text.lastIndexOf(':');
            if (colon > 0) {
                middleDefault = text.substring(colon+1);
                text = text.substring(0, colon);
            }
            if (process && text in process.env) {
                text = process.env[text];
            } else {
                const refs: Array<string> = this.loopDetection.has(loopId)? this.loopDetection.get(loopId) as Array<string> : [];
                if (refs.includes(text)) {
                    log.warn(`Config loop for '${key}' detected`);
                    text = '';
                } else {
                    refs.push(text);
                    this.loopDetection.set(loopId, refs);
                    // "self" points to the base configuration
                    const mid = self.get(text, defaultValue, loopId);
                    text = mid? String(mid) : null;
                }
            }
            this.loopDetection.delete(loopId);
            return text? text : middleDefault;
        } else {
            return defaultValue? String(defaultValue) : null;
        }
    }

    /**
     * Retrieve a key-value where value is enforced as a string
     * 
     * @param key of the item
     * @param defaultValue if item does not exist
     * @returns value of the item
     */
    getProperty(key: string, defaultValue?: string): string {
        const result = this.get(key, defaultValue);
        // make sure empty space is returned as is
        return result == null || result == undefined? null : String(result);
    }

    /**
     * Set a key-value
     * 
     * @param key of the item
     * @param value of the item
     * @returns this ConfigReader
     */
    set(key: string, value): ConfigReader {
        this.config.setElement(key, value);
        return this;
    }

    /**
     * Reserved for internal use
     * -------------------------
     * 
     * Reload configuration parameters with a given map
     * 
     * @returns this ConfigReader
     */
    reload(map: MultiLevelMap): ConfigReader {
        this.config = map;
        return this;
    }



}

class EnvVarSegment {
    public start: number = 0;
    public end: number = 0;

    constructor(start: number, end: number) {
        this.start = start;
        this.end = end;
    }
}

