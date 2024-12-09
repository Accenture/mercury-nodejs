import fs from 'fs';
import { MultiLevelMap } from './multi-level-map.js';
import { Logger } from './logger.js';
import { Utility } from '../util/utility.js';
import { fileURLToPath } from "url";
const log = new Logger();
const util = new Utility();
let self = null;
let sequence = 1;
export class AppConfig {
    constructor(configFileOrMap) {
        if (self == null) {
            self = new ConfigReader(configFileOrMap, true);
        }
    }
    getReader() {
        return self;
    }
}
export class ConfigReader {
    config;
    loopDetection = new Map();
    instance;
    constructor(configFileOrMap, isBaseConfig = false) {
        if (isBaseConfig) {
            if (self == null) {
                this.instance = 0;
            }
            else {
                throw new Error('Base configuration is already loaded');
            }
        }
        else {
            this.instance = sequence++;
        }
        let useDefaultAppConfig = false;
        if (configFileOrMap) {
            if (configFileOrMap && configFileOrMap.constructor == Object) {
                // Input should be a JSON object when using this library in a browser
                if (isBaseConfig) {
                    log.info('Loading base configuration from a JSON object');
                }
                this.config = new MultiLevelMap(configFileOrMap).normalizeMap();
            }
            else if (typeof configFileOrMap == 'string') {
                // File path is only supported when running as a Node.js application
                const configFile = util.normalizeFilePath(String(configFileOrMap));
                const fileExists = configFile && fs.existsSync(configFile);
                if (fileExists) {
                    if (isBaseConfig) {
                        log.info(`Loading base configuration from ${configFile}`);
                    }
                    this.config = util.loadYamlFile(configFile);
                }
                else {
                    if (isBaseConfig) {
                        log.error(`Config file ${configFile} does not exist. Fall back to resources/application.yml`);
                        useDefaultAppConfig = true;
                    }
                    else {
                        throw new Error(`Config file ${configFile} does not exist`);
                    }
                }
            }
            else {
                log.error(`Configuration not loaded because input '${typeof (configFileOrMap)}' is not a file path or a JSON object`);
                this.config = new MultiLevelMap();
            }
        }
        else {
            if (isBaseConfig) {
                useDefaultAppConfig = true;
            }
            else {
                throw new Error(`Input must be a file path or a JSON object`);
            }
        }
        if (useDefaultAppConfig) {
            const filePath = util.normalizeFilePath(fileURLToPath(new URL("../resources/application.yml", import.meta.url)));
            this.config = util.loadYamlFile(filePath);
        }
    }
    getId() {
        return String(this.instance);
    }
    getMap() {
        return this.config.getMap();
    }
    exists(key) {
        return this.config.exists(key);
    }
    isEmpty() {
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
    get(key, defaultValue = null, loop) {
        const result = this.config.getElement(key, defaultValue);
        if (typeof result == 'string') {
            const bracketStart = result.indexOf('${');
            const bracketEnd = bracketStart != -1 ? result.indexOf('}', bracketStart) : -1;
            if (bracketStart != -1 && bracketEnd != -1 && bracketEnd > bracketStart) {
                let middle = result.substring(bracketStart + 2, bracketEnd).trim();
                let middleDefault = null;
                if (middle) {
                    const loopId = String(loop ? loop : util.getUuid());
                    const colon = middle.lastIndexOf(':');
                    if (colon > 0) {
                        middleDefault = middle.substring(colon + 1);
                        middle = middle.substring(0, colon);
                    }
                    if (process && middle in process.env) {
                        middle = middle in process.env ? process.env[middle] : null;
                    }
                    else {
                        const refs = this.loopDetection.has(loopId) ? this.loopDetection.get(loopId) : [];
                        if (refs.includes(middle)) {
                            log.warn(`Config loop for '${middle}' detected`);
                            middle = "* config loop *";
                        }
                        else {
                            refs.push(middle);
                            this.loopDetection.set(loopId, refs);
                            // "self" points to the base configuration
                            middle = self.get(middle, defaultValue, loopId);
                        }
                    }
                    this.loopDetection.delete(loopId);
                    const first = result.substring(0, bracketStart);
                    const last = result.substring(bracketEnd + 1);
                    if (first || last) {
                        if (middleDefault == null) {
                            middleDefault = '';
                        }
                        return first + (middle == null ? middleDefault : middle) + last;
                    }
                    else {
                        return middle == null ? middleDefault : middle;
                    }
                }
            }
        }
        return result;
    }
    /**
     * Retrieve a key-value where value is enforced as a string
     *
     * @param key of the item
     * @param defaultValue if item does not exist
     * @returns value of the item
     */
    getProperty(key, defaultValue) {
        const result = this.get(key, defaultValue);
        // make sure empty space is returned as is
        return result == null || result == undefined ? null : String(result);
    }
    /**
     * Set a key-value
     *
     * @param key of the item
     * @param value of the item
     * @returns this ConfigReader
     */
    set(key, value) {
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
    reload(map) {
        this.config = map;
        return this;
    }
}
//# sourceMappingURL=config-reader.js.map