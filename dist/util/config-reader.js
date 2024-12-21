import fs from 'fs';
import { MultiLevelMap } from './multi-level-map.js';
import { Logger } from './logger.js';
import { Utility } from '../util/utility.js';
const log = Logger.getInstance();
const util = new Utility();
function resolveResource(configFile) {
    if (configFile.startsWith("classpath:/")) {
        const resourcePath = AppConfig.getInstance().getReader().get('resource.path');
        return resourcePath + configFile.substring("classpath:".length);
    }
    else if (configFile.startsWith("file:/")) {
        return configFile.substring("file:".length);
    }
    else {
        return configFile;
    }
}
export class AppConfig {
    static singleton;
    reader;
    id = util.getUuid();
    constructor(resourcePath) {
        if (!this.reader) {
            if (typeof resourcePath == 'string') {
                const filePath = resolveResource(resourcePath);
                if (!fs.existsSync(filePath)) {
                    throw new Error(`Missing resources folder - ${resourcePath}`);
                }
                const stats = fs.statSync(filePath);
                if (!stats.isDirectory()) {
                    throw new Error(`Not a resources folder - ${resourcePath}`);
                }
                this.reader = new ConfigReader(filePath + '/application.yml', true);
                this.reader.resolveEnvVars();
                // save file path
                this.reader.set('resource.path', filePath);
            }
            else {
                if (resourcePath) {
                    throw new Error('Not a resources folder path');
                }
                else {
                    throw new Error('Missing resources folder path');
                }
            }
        }
    }
    static getInstance(resourcePath) {
        if (!AppConfig.singleton) {
            AppConfig.singleton = new AppConfig(resourcePath);
        }
        return AppConfig.singleton;
    }
    getId() {
        return this.id;
    }
    getReader() {
        return this.reader;
    }
}
export class ConfigReader {
    static self;
    config;
    loopDetection = new Map();
    resolved = false;
    id;
    constructor(configFileOrMap, isBaseConfig = false) {
        if (isBaseConfig) {
            if (ConfigReader.self == null) {
                ConfigReader.self = this;
                this.id = "base";
            }
            else {
                throw new Error('Base configuration is already loaded');
            }
        }
        else {
            if (!ConfigReader.self) {
                throw new Error('Cannot user configuration because base configuration is not defined');
            }
            this.id = util.getUuid();
        }
        if (configFileOrMap) {
            if (configFileOrMap && configFileOrMap.constructor == Object) {
                if (isBaseConfig) {
                    throw new Error('Base configuration must be a resource file');
                }
                else {
                    this.config = new MultiLevelMap(configFileOrMap).normalizeMap();
                }
            }
            else if (typeof configFileOrMap == 'string') {
                if (isBaseConfig) {
                    const configFile = util.normalizeFilePath(configFileOrMap);
                    const fileExists = configFile && fs.existsSync(configFile);
                    if (fileExists) {
                        log.info(`Loading base configuration from ${configFile}`);
                        this.config = util.loadYamlFile(configFile);
                    }
                    else {
                        throw new Error(`Base configuration file not found - ${configFile}`);
                    }
                }
                else {
                    this.config = util.loadYamlFile(resolveResource(configFileOrMap));
                }
            }
            else {
                log.error(`Configuration not loaded because input '${typeof (configFileOrMap)}' is not a file path or a JSON object`);
                this.config = new MultiLevelMap();
            }
        }
        else {
            throw new Error(`Input must be a file path or a JSON object`);
        }
    }
    getId() {
        return this.id;
    }
    resolveFilePath(configFile) {
        return resolveResource(configFile);
    }
    resolveEnvVars() {
        if (this.id == "base") {
            if (!this.resolved) {
                this.resolved = true;
                // Resolve environment variables and references to system properties
                const flatMap = this.config.getFlatMap();
                let n = 0;
                for (const k in flatMap) {
                    const v = this.config.getElement(k);
                    if (typeof v == 'string') {
                        const start = v.indexOf("${");
                        const end = v.indexOf('}');
                        if (start != -1 && end != -1 && end > start) {
                            n++;
                        }
                    }
                }
                // if found, reload configuration
                if (n > 0) {
                    const mm = new MultiLevelMap();
                    for (const k in flatMap) {
                        mm.setElement(k, ConfigReader.self.get(k));
                    }
                    const s = n == 1 ? "" : "s";
                    log.info(`Resolved ${n} key-value${s} from system properties and environment variables`);
                    this.config = mm;
                }
            }
        }
        else {
            throw new Error('This is not a base configuration');
        }
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
        if (!key) {
            return null;
        }
        if (process && key in process.env) {
            return process.env[key];
        }
        const result = this.config.getElement(key, defaultValue);
        if (typeof result == 'string' && ConfigReader.self) {
            if (result.lastIndexOf('${') != -1) {
                const segments = this.extractSegments(result);
                segments.reverse();
                let start = 0;
                let sb = '';
                for (const i in segments) {
                    const s = segments[i];
                    const middle = result.substring(s.start + 2, s.end - 1).trim();
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
                return sb ? sb : null;
            }
        }
        return result;
    }
    extractSegments(original) {
        const result = [];
        let text = original;
        while (true) {
            const bracketStart = text.lastIndexOf('${');
            const bracketEnd = text.lastIndexOf('}');
            if (bracketStart != -1 && bracketEnd != -1 && bracketEnd > bracketStart) {
                result.push(new EnvVarSegment(bracketStart, bracketEnd + 1));
                text = original.substring(0, bracketStart);
            }
            else if (bracketStart != -1) {
                text = original.substring(0, bracketStart);
            }
            else {
                break;
            }
        }
        return result;
    }
    performEnvVarSubstitution(key, text, defaultValue = null, loop) {
        if (text) {
            let middleDefault = null;
            const loopId = String(loop ? loop : util.getUuid());
            const colon = text.lastIndexOf(':');
            if (colon > 0) {
                middleDefault = text.substring(colon + 1);
                text = text.substring(0, colon);
            }
            if (process && text in process.env) {
                text = process.env[text];
            }
            else {
                const refs = this.loopDetection.has(loopId) ? this.loopDetection.get(loopId) : [];
                if (refs.includes(text)) {
                    log.warn(`Config loop for '${key}' detected`);
                    text = '';
                }
                else {
                    refs.push(text);
                    this.loopDetection.set(loopId, refs);
                    // "self" points to the base configuration
                    const mid = ConfigReader.self.get(text, defaultValue, loopId);
                    text = mid ? String(mid) : null;
                }
            }
            this.loopDetection.delete(loopId);
            return text ? text : middleDefault;
        }
        else {
            return defaultValue ? String(defaultValue) : null;
        }
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
class EnvVarSegment {
    start = 0;
    end = 0;
    constructor(start, end) {
        this.start = start;
        this.end = end;
    }
}
//# sourceMappingURL=config-reader.js.map