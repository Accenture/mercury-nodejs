/*
 * DO NOT modify this file, it will be updated automatically.
 *
 * The generate-preloader.js build script will update this file 
 * using the "resources/preload.yaml" configuration file.
 */
import fs from 'fs';
import { fileURLToPath } from "url";
import { Logger, AppConfig, FunctionRegistry, Platform } from 'mercury';
// import composable functions

const log = Logger.getInstance();

function getRootFolder() {
    const folder = fileURLToPath(new URL("..", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
}

export class ComposableLoader {
    private static loaded = false;

    static initialize(): void {
        // execute only once
        if (!ComposableLoader.loaded) {
            ComposableLoader.loaded = true;
            try {
                const resourcePath = getRootFolder() + "resources";
                if (!fs.existsSync(resourcePath)) {
                    throw new Error('Missing resources folder');
                }
                const stats = fs.statSync(resourcePath);
                if (!stats.isDirectory()) {
                    throw new Error('resources is not a folder');
                }
                // initialize base configuration
                const config = AppConfig.getInstance(resourcePath);
                log.info(`Base configuration ${config.getId()}`);  
                // initialize composable functions
                // register the functions into the event system
                const platform = Platform.getInstance();
                const registry = FunctionRegistry.getInstance();
                const registered = registry.getFunctions();
                for (const name of registered) {
                    const md = registry.getMetadata(name) as object;
                    const instances = md['instances'] as number;
                    const isPublic = md['public'] as boolean;
                    const isInterceptor = md['interceptor'] as boolean;
                    platform.register(name, registry.getClass(name), instances, !isPublic, isInterceptor);
                }
            } catch (e) {
                log.error(`Unable to preload - ${e.message}`);
            }
        }
    }
}

