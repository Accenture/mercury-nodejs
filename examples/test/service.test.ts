import { Logger, Utility, Platform, PostOffice, Sender, EventEnvelope, AppException, 
    AsyncHttpRequest, ObjectStreamReader, ObjectStreamIO, ObjectStreamWriter, 
    AppConfig} from 'mercury-composable';
import { fileURLToPath } from "url";
import { ComposableLoader } from '../src/preload/preload';

const log = Logger.getInstance();
const util = new Utility();
let platform: Platform;

const HELLO_WORLD = 'hello.world'
const TEST_MESSAGE = 'test message';
const STREAM_CONTENT = 'x-stream-id';

function getRootFolder() {
    const folder = fileURLToPath(new URL("..", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
}

/**
 * These are unit tests for each user functions
 */
describe('Service tests', () => {

    beforeAll(async () => {
        const resourcePath = getRootFolder() + 'src/resources';
        // AppConfig should be initialized with base configuration parameter before everything else
        const appConfig = AppConfig.getInstance(resourcePath);
        // You can programmatically change a configuration parameter.
        // This emulates Java's System.setProperty behavior.
        appConfig.set('server.port', 8303);
        const port = appConfig.getProperty("server.port");
        // print out the port number to confirm that it is using a different one.
        const baseUrl = `http://127.0.0.1:${port}`;
        log.info(`Service tests will use ${baseUrl}`);         
        ComposableLoader.initialize();
        platform = Platform.getInstance();
        platform.runForever();
        await platform.getReady();
    });

    afterAll(async () => {
        await platform.stop();
        // give console.log a moment to finish
        await util.sleep(2000);
        log.info("Service tests completed");
    });

    it('can obtain health check service info', async () => {
        const po = new PostOffice();
        const req = new EventEnvelope().setTo('demo.health').setHeader('type', 'info');
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBeInstanceOf(Object);
        const body = result.getBody() as object;
        expect(body['service']).toBe('demo.service');
        expect(body['href']).toBe('http://127.0.0.1');
    });

    it('can do health check', async () => {
        const po = new PostOffice();
        const req = new EventEnvelope().setTo('demo.health').setHeader('type', 'health');
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toEqual({"status": "demo.service is running fine"});
    });

    it('can read exception from health check', async () => {
        const po = new PostOffice();
        const req = new EventEnvelope().setTo('demo.health').setHeader('type', 'dummy');
        let error = false;
        try {
            await po.request(req, 2000);
        } catch(e) {
            expect(e.message).toBe('Request type must be info or health');
            expect(e).toBeInstanceOf(AppException);
            expect(e.getStatus()).toBe(400);
            error = true;
        }
        expect(error).toBe(true);
    });

    it('can make RPC call to hello.world', async () => {
        const po = new PostOffice(new Sender('rpc.demo', '100', '/test/rpc'));
        const req = new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', '1').setBody(TEST_MESSAGE);
        const result = await po.request(req, 2000);
        expect(result.getBody() instanceof Object).toBe(true);
        const data = result.getBody() as object;
        expect(data['event']).toBe(TEST_MESSAGE);
    });

    it('can download file from hello.world', async () => {
        const po = new PostOffice(new Sender('rpc.demo', '200', '/test/download'));
        const httpRequest = new AsyncHttpRequest().setMethod('GET').setUrl('/api/hello/world');
        httpRequest.setQueryParameter('download', 'true');
        const req = new EventEnvelope().setTo(HELLO_WORLD).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getHeader('content-type')).toBe('application/octet-stream');
        expect(result.getHeader('Content-Disposition')).toBe('attachment; filename=hello.txt');
        expect(result.getHeader(STREAM_CONTENT)).toBeTruthy();
        const streamId = result.getHeader(STREAM_CONTENT);
        const inStream = new ObjectStreamReader(streamId, 3000);
        let n = 0;
        for (let i=0; i < 10; i++) {
            const block = await inStream.read();
            if (block) {
                log.info({'block': block});
                n++;
            } else {
                break;
            }
        }
        // the demo file has 3 lines
        expect(n).toBe(3);
    });

    it('can upload file to hello.world', async () => {
        const filename = 'hello-world.txt';
        const po = new PostOffice(new Sender('rpc.demo', '300', '/test/upload'));
        // emulate file upload
        const httpRequest = new AsyncHttpRequest().setMethod('POST').setUrl('/api/hello/upload');
        httpRequest.setHeader('content-type', 'multipart/form-data');
        const stream = new ObjectStreamIO(60);
        const out = new ObjectStreamWriter(stream.getOutputStreamId());
        // for file upload, the data block must be binary
        out.write(Buffer.from('hello world\n'));
        out.write(Buffer.from('second line'));
        out.close();
        httpRequest.setStreamRoute(stream.getInputStreamId());
        httpRequest.setFileName(filename);
        const req = new EventEnvelope().setTo(HELLO_WORLD).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBeInstanceOf(Object);
        const body = result.getBody() as object;
        expect(body[STREAM_CONTENT]).toBe(stream.getInputStreamId());
        expect(body['filename']).toBe(filename);
        // See e2e test to see the difference between emulation and actual upload using AsyncHttpClient.
        expect(body['type']).toBe('multipart/form-data');
        log.info(body);
    });

    it('will fail file upload to hello.world when multipart protocol is not used', async () => {
        const filename = 'hello-world.txt';
        const po = new PostOffice(new Sender('rpc.demo', '300', '/test/upload'));
        // Emulation of file upload without multipart/form-data header will fail
        const httpRequest = new AsyncHttpRequest().setMethod('POST').setUrl('/api/hello/upload');
        const stream = new ObjectStreamIO(60);
        const out = new ObjectStreamWriter(stream.getOutputStreamId());
        // for file upload, the data block must be binary
        out.write(Buffer.from('hello world\n'));
        out.write(Buffer.from('second line'));
        out.close();
        httpRequest.setStreamRoute(stream.getInputStreamId());
        httpRequest.setFileName(filename);
        const req = new EventEnvelope().setTo(HELLO_WORLD).setBody(httpRequest.toMap());
        let error = false;
        try {
            await po.request(req, 2000);
        } catch(e) {
            expect(e.message).toBe('Not a multipart file upload');
            expect(e).toBeInstanceOf(AppException);
            expect(e.getStatus()).toBe(400);
            error = true;
        }
        expect(error).toBe(true);
    });

    it('can do a dummy API authentication', async () => {
        const po = new PostOffice();
        const httpRequest = new AsyncHttpRequest().setMethod('GET').setUrl('/api/hello/world');
        const req = new EventEnvelope().setTo('v1.api.auth').setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBe(true);
    });

});
