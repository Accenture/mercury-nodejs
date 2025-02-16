import fs from 'fs';
import { MultiLevelMap } from './multi-level-map.js';
import { Logger } from './logger.js';
import { Utility } from '../util/utility.js';
const log = Logger.getInstance();
const util = new Utility();
const LOG_FORMAT = {
    TEXT: 0,
    COMPACT: 1,
    JSON: 2
};
function resolveResource(configFile) {
    let path;
    if (configFile.startsWith("classpath:")) {
        const resourcePath = AppConfig.getInstance().get('resource.path');
        path = resourcePath + configFile.substring("classpath:".length);
    }
    else if (configFile.startsWith("file:")) {
        path = configFile.substring("file:".length);
    }
    else {
        path = configFile;
    }
    return util.normalizeFilePath(path);
}
function getConfigFilePath(filePath) {
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        if (fs.existsSync(filePath)) {
            return filePath;
        }
        // try alternative extension
        const name = filePath.substring(0, filePath.lastIndexOf('.'));
        if (name) {
            const alternative = filePath.endsWith('.yaml') ? `${name}.yml` : `${name}.yaml`;
            if (fs.existsSync(alternative)) {
                return alternative;
            }
        }
        // config file not found
        return null;
    }
    else {
        throw new Error('Config file must use .yml or .yaml extension');
    }
}
export class AppConfig {
    static singleton;
    static reader;
    constructor(resourcePath) {
        if (!AppConfig.reader) {
            if (typeof resourcePath == 'string') {
                if (!fs.existsSync(resourcePath)) {
                    throw new Error(`Missing resources folder - ${resourcePath}`);
                }
                if (!util.isDirectory(resourcePath)) {
                    throw new Error(`Not a resources folder - ${resourcePath}`);
                }
                AppConfig.reader = new ConfigReader(resourcePath + '/application.yml', true);
                // save file path
                AppConfig.reader.set('resource.path', resourcePath);
                // save version from version.txt in the "resources" folder
                const versionFile = `${resourcePath}/version.txt`;
                if (fs.existsSync(versionFile)) {
                    const version = fs.readFileSync(versionFile, { encoding: 'utf-8', flag: 'r' });
                    if (version) {
                        AppConfig.reader.set('info.app.version', version.trim());
                        log.info(`Application version ${version}`);
                    }
                }
            }
            else {
                throw new Error('Unable to start configuration management. Did you forget to provide a resource folder path?');
            }
        }
    }
    static getInstance(resourcePath) {
        if (AppConfig.singleton === undefined) {
            AppConfig.singleton = new AppConfig(resourcePath);
            // check command line arguments for overrides
            let reloaded = false;
            let reloadFile = null;
            let errorInReload = null;
            if (process) {
                // reload configuration from a file given in command line argument "-C{filename}"
                const replaceConfig = process.argv.filter(k => k.startsWith('-C'));
                if (replaceConfig.length > 0) {
                    reloadFile = replaceConfig[0].substring(2);
                    try {
                        const map = util.loadYamlFile(reloadFile);
                        if (map.isEmpty()) {
                            errorInReload = `Configuration file ${reloadFile} is empty`;
                        }
                        else {
                            AppConfig.reader.reload(map);
                            reloaded = true;
                        }
                    }
                    catch (e) {
                        errorInReload = e.message;
                    }
                }
                // override application parameters from command line arguments
                const parameters = process.argv.filter(k => k.startsWith('-D') && k.substring(2).includes('='));
                for (let i = 0; i < parameters.length; i++) {
                    const p = parameters[i].substring(2);
                    const sep = p.indexOf('=');
                    const k = p.substring(0, sep);
                    const v = p.substring(sep + 1);
                    if (k && v) {
                        AppConfig.reader.set(k, v);
                    }
                }
            }
            log.setLevel(AppConfig.reader.getProperty('log.level', 'info'));
            // set log format: text, json, compact
            const logFormat = AppConfig.reader.getProperty('log.format', 'text');
            if (logFormat) {
                const format = logFormat.toLowerCase();
                if ('json' == format) {
                    log.setLogFormat(LOG_FORMAT.JSON);
                }
                else if ('compact' == format) {
                    log.setLogFormat(LOG_FORMAT.COMPACT);
                }
            }
            if (reloaded) {
                log.info(`Configuration reloaded from ${reloadFile}`);
            }
            else if (errorInReload) {
                log.warn(`Unable to load configuration from ${reloadFile} - ${errorInReload}`);
            }
            else {
                log.info(`Configuration loaded from ${resourcePath}`);
            }
        }
        return AppConfig.reader;
    }
}
export class ConfigReader {
    static self;
    config;
    loopDetection = new Map();
    resolved = false;
    id;
    /**
     * Create an instance of a ConfigReader
     *
     * @param configResource is a config file path or a key-value JSON object
     * @param isBaseConfig is true when this ConfigReader is the base AppReader
     */
    constructor(configResource, isBaseConfig = false) {
        if (isBaseConfig) {
            if (ConfigReader.self === undefined) {
                ConfigReader.self = this;
                this.id = "base";
            }
            else {
                throw new Error('Base configuration is already loaded');
            }
        }
        else {
            if (ConfigReader.self === undefined) {
                throw new Error('Cannot do user configuration because base configuration is not defined');
            }
            this.id = util.getUuid();
        }
        if (configResource) {
            if (configResource && configResource.constructor == Object) {
                if (isBaseConfig) {
                    throw new Error('Base configuration must be a resource file');
                }
                else {
                    this.config = new MultiLevelMap(configResource).normalizeMap();
                }
            }
            else if (typeof configResource == 'string') {
                let filePath;
                if (isBaseConfig) {
                    filePath = getConfigFilePath(configResource);
                }
                else {
                    filePath = getConfigFilePath(resolveResource(configResource));
                }
                if (!filePath) {
                    throw new Error(`${configResource} not found`);
                }
                if (util.isDirectory(filePath)) {
                    throw new Error('Config file must not be a directory');
                }
                this.config = util.loadYamlFile(filePath);
            }
            else {
                log.error(`Configuration not loaded because config resource is not a file path or a JSON object`);
                this.config = new MultiLevelMap();
            }
            this.resolveEnvVars();
        }
        else {
            throw new Error('Missing config resource');
        }
    }
    getId() {
        return this.id;
    }
    resolveFilePath(configFile) {
        return resolveResource(configFile);
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
        const hasKey = key ? true : false;
        if (!hasKey) {
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
     * Reload configuration parameters with a given map
     *
     * @returns this ConfigReader
     */
    reload(map) {
        this.config.reload(map);
        return this;
    }
    resolveEnvVars() {
        if (!this.resolved) {
            this.resolved = true;
            // normalize the dataset first            
            const flat = this.config.getFlatMap();
            const keys = Object.keys(flat).sort();
            const dataset = new MultiLevelMap();
            keys.forEach(k => {
                dataset.setElement(k, flat[k]);
            });
            this.config.reload(dataset.getMap());
            // Resolve environment variables and references to system properties
            let found = false;
            for (const k of keys) {
                const v = flat[k];
                if (typeof v == 'string') {
                    const start = v.indexOf("${");
                    const end = v.indexOf('}');
                    if (start != -1 && end != -1 && end > start) {
                        found = true;
                        break;
                    }
                }
            }
            // if found, reload configuration
            if (found) {
                const mm = new MultiLevelMap();
                for (const k of keys) {
                    mm.setElement(k, this.get(k));
                }
                this.reload(mm);
            }
        }
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