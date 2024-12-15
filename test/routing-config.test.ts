import { Logger } from '../src/util/logger.js';
import { AppConfig, ConfigReader } from '../src/util/config-reader.js';
import { RoutingEntry } from '../src/util/routing.js';
import { fileURLToPath } from "url";

const log = new Logger();

function getRootFolder() {
    const folder = fileURLToPath(new URL("..", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
  }

describe('rest automation parser tests', () => {

    beforeAll(async () => {
         const config = new AppConfig().getReader();
         log.info(`Base configuration id=${config.getId()} loaded`);
    });
      
    it('can parse rest.yaml', () => {
        const filePath = getRootFolder() + 'test/resources/rest.yaml';
        log.info(`Loading configuration from ${filePath}`);
        const config = new ConfigReader(filePath);
        const router = new RoutingEntry();
        router.load(config);
        const assigned = router.getRouteInfo('GET', '/api/hello/world');
        expect(assigned).toBeTruthy();
        expect(assigned.info.methods).toStrictEqual([ 'GET', 'PUT', 'POST', 'HEAD', 'PATCH', 'DELETE' ]);
        expect(assigned.info.url).toBe('/api/hello/world');
    }); 

});