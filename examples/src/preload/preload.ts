/*
 * DO NOT modify this file, it will be updated automatically.
 */
import fs from 'fs';
import { fileURLToPath } from "url";
import { Logger, AppConfig, FunctionRegistry, Platform, RestAutomation, EventScriptEngine } from 'mercury-composable';
// import composable functions
import { NoOp } from '../../node_modules/mercury-composable/dist/services/no-op.js';
import { DemoAuth } from '../services/demo-auth.js';
import { DemoHealthCheck } from '../services/health-check.js';
import { HelloConcurrent } from '../services/hello-concurrent.js';
import { HelloWorld } from '../services/hello-world.js';
import { CreateProfile } from '../tasks/create-profile.js';
import { DecryptFields } from '../tasks/decrypt-fields.js';
import { DeleteProfile } from '../tasks/delete-profile.js';
import { EncryptFields } from '../tasks/encrypt-fields.js';
import { GetProfile } from '../tasks/get-profile.js';
import { HelloException } from '../tasks/hello-exception.js';
import { SaveProfile } from '../tasks/save-profile.js';

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
                // initialize composable functions
                new NoOp().initialize();
                new DemoAuth().initialize();
                new DemoHealthCheck().initialize();
                new HelloConcurrent().initialize();
                new HelloWorld().initialize();
                new CreateProfile().initialize();
                new DecryptFields().initialize();
                new DeleteProfile().initialize();
                new EncryptFields().initialize();
                new GetProfile().initialize();
                new HelloException().initialize();
                new SaveProfile().initialize();
                // register the functions into the event system
                const platform = Platform.getInstance();
                const registry = FunctionRegistry.getInstance();
                const registered = registry.getFunctionList();
                for (const name of registered) {
                    const md = registry.getMetadata(name) as object;
                    const instances = md['instances'] as number;
                    const isPrivate = md['private'] as boolean;
                    const isInterceptor = md['interceptor'] as boolean;
                    platform.register(name, registry.getClass(name), instances, isPrivate, isInterceptor);
                }
                const eventManager = new EventScriptEngine();
                eventManager.start();
                // start REST automation engine
                const restEnabled = 'true' == config.getProperty('rest.automation');
                if (restEnabled) {
                    const server = new RestAutomation();
                    server.start();
                }
            } catch (e) {
                log.error(`Unable to preload - ${e.message}`);
            }
        }
    }
}

