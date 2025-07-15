import fs from 'fs';
import { MultiLevelMap } from './multi-level-map.js';
import { Logger } from './logger.js';
import { Utility } from './utility.js';
const log = Logger.getInstance();
const util = new Utility();
const MAIN_RESOURCES = "/src/resources";
const TEST_RESOURCES = "/tests/resources";
function overrideRunTime(config, argv) {
    const params = argv || process.argv;
    // scan for "-D" run-time parameter overrides
    const parameters = params.filter(k => k.startsWith('-D') && k.includes('='));
    for (const param of parameters) {
        const p = param.substring(2);
        const sep = p.indexOf('=');
        const k = p.substring(0, sep);
        const v = p.substring(sep + 1);
        if (k && v) {
            config.set(k, v);
        }
    }
    config.set('runtime.parameters', parameters);
}
function resolveResource(configFile) {
    if (configFile.startsWith("classpath:")) {
        const appConfig = AppConfig.getInstance();
        const resourcePath = appConfig.getProperty('resource.path');
        const cp = util.normalizeFilePath(configFile.substring("classpath:".length));
        const classPath = cp.startsWith('/') ? cp : `/${cp}`;
        const filePath = resourcePath + classPath;
        const result = getResourceFilePath(filePath);
        return result || getOtherResource(classPath);
    }
    else if (configFile.startsWith("file:")) {
        return getResourceFilePath(configFile.substring("file:".length));
    }
    else {
        return getResourceFilePath(configFile);
    }
}
function getOtherResource(classPath) {
    const appConfig = AppConfig.getInstance();
    const resourcePath = appConfig.getProperty('resource.path');
    // try other resources
    const otherResources = new Array();
    if (resourcePath.endsWith(TEST_RESOURCES)) {
        otherResources.push(resourcePath.substring(0, resourcePath.length - TEST_RESOURCES.length) + MAIN_RESOURCES);
    }
    const segments = util.split(resourcePath, "/");
    if (segments.length > 2) {
        let sb = '';
        for (let i = 0; i < segments.length - 2; i++) {
            sb += '/' + segments[i];
        }
        const packages = appConfig.getProperty('web.component.scan');
        if (packages) {
            const packageList = util.split(packages, ', ');
            for (const p of packageList) {
                otherResources.push(sb + '/node_modules/' + p + '/dist/resources');
            }
        }
    }
    if (otherResources) {
        for (const f of otherResources) {
            const alternative = getResourceFilePath(f + classPath);
            if (alternative) {
                log.info(`Found resource ${alternative}`);
                return alternative;
            }
        }
    }
    return null;
}
function getResourceFilePath(filePath) {
    if (fs.existsSync(filePath)) {
        return filePath;
    }
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
        // try alternative extension
        const name = filePath.substring(0, filePath.lastIndexOf('.'));
        if (name) {
            const alternative = filePath.endsWith('.yaml') ? `${name}.yml` : `${name}.yaml`;
            if (fs.existsSync(alternative)) {
                return alternative;
            }
        }
    }
    // file not found
    return null;
}
function loadConfigResource(configResource, isBaseConfig) {
    if (configResource.constructor == Object) {
        if (isBaseConfig) {
            throw new Error('Base configuration must be a resource file');
        }
        else {
            return new MultiLevelMap(configResource).normalizeMap();
        }
    }
    else if (typeof configResource == 'string') {
        return loadConfigFromFile(configResource, isBaseConfig);
    }
    else {
        log.error(`Configuration not loaded because config resource is not a file path or a JSON object`);
        return new MultiLevelMap();
    }
}
function loadConfigFromFile(configResource, isBaseConfig) {
    if (configResource.endsWith('.yaml') || configResource.endsWith('.yml')) {
        const filePath = isBaseConfig ? getResourceFilePath(configResource) : resolveResource(configResource);
        if (!filePath) {
            throw new Error(`${configResource} not found`);
        }
        if (util.isDirectory(filePath)) {
            throw new Error('Config file must not be a directory');
        }
        return util.loadYamlFile(filePath);
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
                this.setResourcePath(resourcePath);
            }
            else {
                throw new Error('Unable to start configuration management. Did you forget to provide a resource folder path?');
            }
        }
    }
    setResourcePath(resourcePath) {
        AppConfig.reader = new ConfigReader(resourcePath + '/application.yml', true);
        // save file path
        AppConfig.reader.set('resource.path', resourcePath);
        // save version from version.txt in the "resources" folder
        const versionFile = `${resourcePath}/version.txt`;
        if (fs.existsSync(versionFile)) {
            const version = fs.readFileSync(versionFile, { encoding: 'utf-8', flag: 'r' });
            if (version) {
                AppConfig.reader.set('info.app.version', version.trim());
            }
        }
    }
    static getInstance(resourcePath, argv) {
        if (AppConfig.singleton === undefined) {
            AppConfig.singleton = new AppConfig(resourcePath);
            overrideRunTime(AppConfig.reader, argv);
            log.setLevel(AppConfig.reader.getProperty('log.level', 'info'));
            // set log format: text, json, compact
            const logFormat = AppConfig.reader.getProperty('log.format', 'text');
            if (logFormat) {
                const format = logFormat.toLowerCase();
                if ('json' == format || 'compact' == format || 'text' == format) {
                    log.setLogFormat(format);
                }
            }
            const version = AppConfig.reader.get('info.app.version');
            if (version) {
                log.info(`Application version ${version}`);
            }
            log.info(`Configuration loaded from ${resourcePath}`);
        }
        return AppConfig.reader;
    }
}
export class ConfigReader {
    static self;
    config;
    loopDetection = new Map();
    id;
    resolved = false;
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
            this.config = loadConfigResource(configResource, isBaseConfig);
            this.resolveEnvVars();
        }
        else {
            throw new Error('Missing config resource');
        }
    }
    getId() {
        return this.id;
    }
    resolveResourceFilePath(configFile) {
        if (configFile.startsWith('classpath:')) {
            return resolveResource(configFile);
        }
        else {
            throw new Error('Resource filename must be prefixed with classpath:');
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
        const hasKey = !!key;
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
                return this.checkEnvVariables(key, segments, result, defaultValue, loop);
            }
        }
        return result;
    }
    checkEnvVariables(key, segments, result, defaultValue, loop) {
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
        return sb || null;
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
        return result == null || result === undefined ? null : String(result);
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
            const keys = Object.keys(flat).sort((a, b) => a.localeCompare(b));
            const dataset = new MultiLevelMap();
            keys.forEach(k => {
                dataset.setElement(k, flat[k]);
            });
            this.config.reload(dataset.getMap());
            // reload configuration if there are environment variables
            if (this.hasEnvVars(keys, flat)) {
                const mm = new MultiLevelMap();
                for (const k of keys) {
                    mm.setElement(k, this.get(k));
                }
                this.reload(mm);
            }
        }
    }
    hasEnvVars(keys, flat) {
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
        return found;
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
            const loopId = String(loop || util.getUuid());
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
                text = this.avoidConfigLoop(key, refs, text, defaultValue, loopId);
            }
            this.loopDetection.delete(loopId);
            return text || middleDefault;
        }
        else {
            return defaultValue ? String(defaultValue) : null;
        }
    }
    avoidConfigLoop(key, refs, text, defaultValue, loopId) {
        if (refs.includes(text)) {
            log.warn(`Config loop for '${key}' detected`);
            return '';
        }
        else {
            refs.push(text);
            this.loopDetection.set(loopId, refs);
            // "self" points to the base configuration
            const mid = ConfigReader.self.get(text, defaultValue, loopId);
            return mid ? String(mid) : null;
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