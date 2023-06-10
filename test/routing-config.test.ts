import { Logger } from '../src/util/logger.js';
import { Utility } from '../src/util/utility.js';
import { fileURLToPath } from "url";
import { AppConfig, ConfigReader } from '../src/util/config-reader.js';
import { RoutingEntry } from '../src/util/routing.js';

const log = new Logger();
const util = new Utility();

describe('rest automation parser tests', () => {

    beforeAll(async () => {
         const config = new AppConfig().getReader();
         log.info(`Base configuration id=${config.getId()} loaded`);
    });
      
    it('can parse rest.yaml', () => {
        const resourceFolder = fileURLToPath(new URL("./resources", import.meta.url));
        const filePath = util.normalizeFilePath(resourceFolder + "/rest.yaml");
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