/*
 * DO NOT modify this file, it will be updated automatically.
 *
 * The generate-preloader.js build script will update this file 
 * using the "resources/preload.yaml" configuration file.
 */
import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from "url";
import { Logger, Platform, ConfigReader, FunctionRegistry } from 'mercury';
// import the user services
// Generated: 2024-12-15 08:37:00.867
import { DemoAuth } from '../services/demo-auth.js';
import { DemoHealthCheck } from '../services/health-check.js';
import { HelloWorldService } from '../services/hello-world-service.js';

const log = new Logger();
const PRELOAD_SECTION = 'preload';

function getRootFolder() {
    const folder = fileURLToPath(new URL("..", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
}

function getPreloadConfig(): object {
    const preloadYaml = getRootFolder() + "resources/preload.yaml";
    if (fs.existsSync(preloadYaml)) {
        const fileContent = fs.readFileSync(preloadYaml, {encoding:'utf-8', flag:'r'});
        const config = new ConfigReader(parseYaml(fileContent));
        if (config.exists(PRELOAD_SECTION)) {
            const serviceList = config.get(PRELOAD_SECTION);
            if (!Array.isArray(serviceList)) {
                throw new Error('Service section should be a list of maps');
            }
            if (serviceList.length == 0) {
                throw new Error('Service section is empty');
            }
            const result = {};
            for (let i=0; i < serviceList.length; i++) {
                const name = config.getProperty(`${PRELOAD_SECTION}[${i}].name`);
                const isPrivate = config.get(`${PRELOAD_SECTION}[${i}].private`);
                const instances = config.get(`${PRELOAD_SECTION}[${i}].instances`);
                const interceptor = config.get(`${PRELOAD_SECTION}[${i}].interceptor`);
                if (name && typeof(isPrivate) == 'boolean' &&
                    typeof(instances) == 'number' && typeof(interceptor) == 'boolean') {
                    result[name] = {'name': name, 'private': isPrivate, 'instances': instances, 'interceptor': interceptor};
                } else {
                    throw new Error(`Invalid preload entry - ${JSON.stringify(config.get(`${PRELOAD_SECTION}[${i}]`))}`);
                }
            }
            return result;
        } else {
            throw new Error(`Please check ${preloadYaml} for preload section configuration`);
        }
    } else {
        throw new Error(`Preload configuration file (${preloadYaml}) not found`);
    }
}

export class ComposableLoader {

    static initialize(config?: object): void {
        try {
            const platform = new Platform();
            const registry = new FunctionRegistry();    
            // list of services
            new DemoAuth().initialize();
            new DemoHealthCheck().initialize();
            new HelloWorldService().initialize();
            // register the services
            const serviceMap = config && config.constructor == Object? config : getPreloadConfig();
            for (const name in serviceMap) {
                const entry = serviceMap[name];
                const isPrivate = entry['private'] as boolean;
                const instances = entry['instances'] as number;
                const interceptor = entry['interceptor'] as boolean;
                if (registry.exists(name)) {
                    const f = registry.getFunction(name);
                    platform.register(name, f, isPrivate, instances, interceptor);        
                } else {
                    throw new Error(`${name} not found`);
                }
            }
        } catch (e) {
            log.error(`Unable to preload - ${e.message}`);
        }
    }
}

