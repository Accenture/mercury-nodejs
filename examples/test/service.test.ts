import { Logger, Utility, Platform, PostOffice, EventEnvelope, AppException, AsyncHttpRequest, ObjectStreamReader, ObjectStreamIO, ObjectStreamWriter } from 'mercury';
import { ComposableLoader } from '../src/preload/preload.js';
import { fileURLToPath } from "url";

const log = new Logger();
const util = new Utility();
let platform: Platform;
let resourceFolder: string;

const HELLO_WORLD = 'hello.world'
const TEST_MESSAGE = 'test message';

/**
 * These are unit tests for each user functions
 */
describe('Service tests', () => {

    beforeAll(async () => {
        log.info('Begin service tests');
        // locate the src/resources folder
        resourceFolder = fileURLToPath(new URL('../src/resources', import.meta.url));
        const appConfigPath = util.normalizeFilePath(resourceFolder + '/application.yml');
        platform = new Platform(appConfigPath);
        ComposableLoader.initialize();
        platform.runForever();
    });

    afterAll(async () => {
        await platform.stop();
        // Give console.log a moment to finish
        await util.sleep(1000);
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
        expect(result.getBody()).toBe('demo.service is running fine');
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
        const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '100', 'my_trace_path': '/test/rpc'});
        const req = new EventEnvelope().setTo(HELLO_WORLD).setHeader('n', '1').setBody(TEST_MESSAGE);
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBe(TEST_MESSAGE);
        expect(result.getHeader('n')).toBe('1');
    });

    it('can download file from hello.world', async () => {
        const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '200', 'my_trace_path': '/test/download'});
        const httpRequest = new AsyncHttpRequest().setMethod('GET').setUrl('/api/hello/world');
        httpRequest.setQueryParameter('download', 'true');
        const req = new EventEnvelope().setTo(HELLO_WORLD).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getHeader('content-type')).toBe('application/octet-stream');
        expect(result.getHeader('Content-Disposition')).toBe('attachment; filename=hello.txt');
        expect(result.getHeader('stream')).toBeTruthy();
        const streamId = result.getHeader('stream');
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
        const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '300', 'my_trace_path': '/test/upload'});
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
        expect(body['stream']).toBe(stream.getInputStreamId());
        expect(body['filename']).toBe(filename);
        // See e2e test to see the difference between emulation and actual upload using AsyncHttpClient.
        expect(body['type']).toBe('multipart/form-data');
        log.info(body);
    });

    it('will fail file upload to hello.world when multipart protocol is not used', async () => {
        const filename = 'hello-world.txt';
        const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '300', 'my_trace_path': '/test/upload'});
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
