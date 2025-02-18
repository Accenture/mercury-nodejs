import { Logger, Platform, CryptoApi, Utility } from 'mercury-composable';
import { ComposableLoader } from './preload/preload.js'; 
import fs from 'fs';

const TEMP_KEY_STORE = "/tmp/keystore";
const DEMO_MASTER_KEY = `${TEMP_KEY_STORE}/demo.txt`;

const log = Logger.getInstance();
const util = new Utility();

async function createEncryptionKey() {
    if (!fs.existsSync(TEMP_KEY_STORE)) {
        fs.mkdirSync(TEMP_KEY_STORE);
    }
    if (!fs.existsSync(DEMO_MASTER_KEY)) {
        const crypto = new CryptoApi();
        const b64Key = util.bytesToBase64(crypto.generateAesKey());
        await util.str2file(DEMO_MASTER_KEY, b64Key);
        log.info(`Demo encryption key ${DEMO_MASTER_KEY} created`);
    }
}

async function main() {
    // create a master encryption key if not exists
    createEncryptionKey();
    // Load composable functions into memory and initialize configuration management
    ComposableLoader.initialize();
    // keep the server running
    const platform = Platform.getInstance();
    platform.runForever();
    await platform.getReady();
    log.info('Composable application started');
}
// run the application
main();
