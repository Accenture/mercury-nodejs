/*
 * DO NOT modify this file, it will be updated automatically.
 */
import fs from 'fs';
import { fileURLToPath } from "url";
import { Logger, AppConfig, Platform, RestAutomation, EventScriptEngine } from 'mercury-composable';
// import composable functions
import { NoOp } from '../../node_modules/mercury-composable/dist/services/no-op.js';
import { ResilienceHandler } from '../../node_modules/mercury-composable/dist/services/resilience-handler.js';
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
                // register the functions into the event system
                const platform = Platform.getInstance();
                platform.register('no.op', new NoOp(), 50);
                platform.register('resilience.handler', new ResilienceHandler(), 100, true, true);
                platform.register('v1.api.auth', new DemoAuth());
                platform.register('demo.health', new DemoHealthCheck());
                platform.register(HelloConcurrent.routeName, new HelloConcurrent(), 10);
                platform.register(HelloWorld.routeName, new HelloWorld(), 10, false);
                platform.register('v1.create.profile', new CreateProfile(), 10);
                platform.register('v1.decrypt.fields', new DecryptFields(), 10);
                platform.register('v1.delete.profile', new DeleteProfile(), 10);
                platform.register('v1.encrypt.fields', new EncryptFields(), 10);
                platform.register('v1.get.profile', new GetProfile(), 10);
                platform.register('v1.hello.exception', new HelloException(), 10);
                platform.register('v1.save.profile', new SaveProfile(), 10);
                // start Event Script system
                const eventManager = new EventScriptEngine();
                eventManager.start();
                // start REST automation system
                if ('true' == config.getProperty('rest.automation')) {
                    const server = RestAutomation.getInstance();
                    server.start();
                }
            } catch (e) {
                log.error(`Unable to preload - ${e.message}`);
            }
        }
    }
}

