import { Logger } from '../src/util/logger';
import { Utility } from '../src/util/utility';
import { AppConfig, ConfigReader } from '../src/util/config-reader';
import { RoutingEntry } from '../src/util/routing';
import { fileURLToPath } from "url";
import fs from 'fs';

const log = Logger.getInstance();
const util = new Utility();

function getRootFolder() {
    const folder = fileURLToPath(new URL("..", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
  }

describe('config reader tests', () => {

    beforeAll(() => {
        const resourcePath = getRootFolder() + 'tests/resources';
        const config = AppConfig.getInstance(resourcePath);
        log.info(`Base configuration id=${config.getId()} loaded`);
    });
      
    it('can parse rest.yaml', () => {
        // config reader will resolve alternative extension automatically
        const filePath = 'classpath:/rest.yml';
        const config = new ConfigReader(filePath);
        const router = new RoutingEntry();
        router.load(config);
        const assigned = router.getRouteInfo('GET', '/api/hello/world');
        expect(assigned).toBeTruthy();
        expect(assigned.info.methods).toStrictEqual([ 'GET', 'PUT', 'POST', 'HEAD', 'PATCH', 'DELETE' ]);
        expect(assigned.info.url).toBe('/api/hello/world');
    }); 

    it("should throw an error when reading a folder as a configuration file", () => {
        const filePath = 'classpath:/invalid.yml';        
        expect(() => new ConfigReader(filePath)).toThrow("Config file must not be a directory"); 
        // this tests the Logger's warning log feature since we don't have a separate logger test
        log.warn('Successfully throw exception when reading a folder as a config file');
        const level = log.getLevel();
        expect(level).toBe('info');
    });

    it("should throw an error with invalid YAML extensions", () => {
        const filePath = 'classpath:/invalid.json';        
        expect(() => new ConfigReader(filePath)).toThrow("Config file must use .yml or .yaml extension"); 
        // this tests some Logger features since we don't have a separate logger test
        log.error('Successfully throw exception when reading YAML file with invalid extension', new Error('Hello World'));
    });

    it("should throw an error when config file does not exist", () => {
        const filePath = 'classpath:/no-such-file.yaml';
        expect(() => new ConfigReader(filePath)).toThrow(`${filePath} not found`); 
    });

    it("should throw an error when config file is missing", () => {
        expect(() => new ConfigReader()).toThrow('Missing config resource'); 
    });

    it('can detect single level of config loop', () => {
        const config = AppConfig.getInstance();
        expect(config.get('recursive.key')).toBeNull();
    });

    it('can detect multiple levels of config loop', () => {
        const config = AppConfig.getInstance();
        expect(config.get('looping.test.1')).toBe("1000");
        expect(config.get('looping.test.3')).toBe("hello hello ");
    });

    it('can get one environment variable', () => {
        const config = AppConfig.getInstance();
        if (process && 'PATH' in process.env) {
            const p = process.env['PATH'];
            expect(config.get('env.var.1')).toBe(p);
        }
    });

    it('can get multiple environment variables', () => {
        const config = AppConfig.getInstance();
        if (process && 'PATH' in process.env) {
            const p = process.env['PATH'];
            // the last environment variable is broken
            const v = 'first 8300 second ' + p + ' third ${invalid.format'
            expect(config.get('env.var.2')).toBe(v);
        }
    });

    it('can split a text string with multiple separators', () => {
        const text = 'hello, , world';
        const chars = ', ';
        const parts = util.split(text, chars);
        expect(parts).toEqual(['hello', 'world']);
        const parts2 = util.split(text, chars, true);
        expect(parts2.length).toBe(5);
        expect(parts2).toEqual(['hello', '', '', '', 'world']);
    });

    it('can resolve a file path from a resource path hierarchy', async () => {
        const config = AppConfig.getInstance();
        // In case developer puts in windows bashslash as separator,
        // the system will convert it to Unix separator
        const filePath = config.resolveResourceFilePath('classpath:\\templates\\preload.template');
        expect(filePath).toBeTruthy();
        // verify that "/tests/resources/" is replaced by "/src/resources/"
        expect(filePath.includes('/src/resources/')).toBe(true);
        const template = fs.readFileSync(filePath);
        expect(template).toBeTruthy();
        expect(template.includes('${import-statements}')).toBe(true);
        expect(template.includes('${service-list}')).toBe(true);
    });     

});