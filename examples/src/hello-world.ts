import { Logger, Platform, RestAutomation } from 'mercury';
import { ComposableLoader } from './preload/preload.js'; 

const log = Logger.getInstance();

async function main() {
    // Load composable functions into memory and initialize configuration management
    ComposableLoader.initialize();
    // start REST automation engine
    const server = new RestAutomation();
    server.start();
    // keep the server running
    const platform = Platform.getInstance();
    platform.runForever();
    log.info('Hello world application started');
}
// run the application
main();
