import { Logger, Platform, RestAutomation } from 'mercury';
import { ComposableLoader } from './preload/preload.js'; 
import { fileURLToPath } from "url";

const log = new Logger();
const REST_AUTOMATION_YAML = "rest.automation.yaml";
const STATIC_HTML_FOLDER = "static.html.folder";

function getResourceFoler() {
    const folder = fileURLToPath(new URL("./resources/", import.meta.url));
    return folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
}

async function main() {
    const resources = getResourceFoler();
    // Start platform with user provided config file
    // IMPORTANT - this must be the first instantiation of the Platform object in your application
    const configFile = resources + 'application.yml';
    const platform = new Platform(configFile);
    // Locate the REST automation config file
    const restYaml = resources + 'rest.yaml';
    const appConfig = platform.getConfig();
    // Set configuration parameter before starting REST automation
    if (!appConfig.exists(REST_AUTOMATION_YAML)) {
        appConfig.set(REST_AUTOMATION_YAML, restYaml);
    }
    if (!appConfig.exists(STATIC_HTML_FOLDER)) {
        appConfig.set(STATIC_HTML_FOLDER, resources + 'public');
    }
    // Load composable functions into memory
    ComposableLoader.initialize();
    // start REST automation engine
    const server = new RestAutomation();
    server.start();
    platform.runForever();
    log.info('Hello world application started');
}

// run this application
main();
