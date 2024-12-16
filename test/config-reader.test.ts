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

describe('config reader tests', () => {

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

    it('can detect single level of config loop', () => {
        const config = new AppConfig().getReader();
        expect(config.get('recursive.key')).toBeNull();
    });

    it('can detect multiple levels of config loop', () => {
        const config = new AppConfig().getReader();
        expect(config.get('looping.test.1')).toBe("1000");
        expect(config.get('looping.test.3')).toBe("hello hello ");
    });

    it('can get one environment variable', () => {
        const config = new AppConfig().getReader();
        if (process && 'PATH' in process.env) {
            const p = process.env['PATH'];
            expect(config.get('env.var.1')).toBe(p);
        }
    });

    it('can get multiple environment variables', () => {
        const config = new AppConfig().getReader();
        if (process && 'PATH' in process.env) {
            const p = process.env['PATH'];
            const v = 'first 8300 second ' + p + ' third'
            expect(config.get('env.var.2')).toBe(v);
        }
    });

});