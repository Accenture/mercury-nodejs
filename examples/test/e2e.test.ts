import { Logger, Utility, AppConfig, Platform, PostOffice, EventEnvelope, AsyncHttpRequest, MultiLevelMap, ObjectStreamReader, ObjectStreamWriter, ObjectStreamIO } from 'mercury';
// hello-world.ts is a main application and it will automatically start when imported
import '../src/hello-world.js';

const log = Logger.getInstance();
const util = new Utility();

const ASYNC_HTTP_CLIENT = "async.http.request";
const STREAM_CONTENT = 'x-stream-id';
let targetHost: string;

/**
 * These are end-to-end tests by making HTTP requests with the AsyncHttpClient
 * to the REST endpoints of the hello.world service.
 *
 * Since the "hello-world" application is running in the same memory space,
 * the platform object will point to the same singleton.
 */
describe('End-to-end tests', () => {

    beforeAll(async () => {
        const config = AppConfig.getInstance().getReader();
        const port = config.get('server.port');
        targetHost = `http://127.0.0.1:${port}`;
        log.info(`Begin end-to-end tests with port ${port}`);
    });

    afterAll(async () => {
        const platform = Platform.getInstance();
        await platform.stop();
        // give console.log a moment to finish
        await util.sleep(1000);
        log.info("End-to-end tests completed");
    });

    it('can do health check', async () => {
        const platform = Platform.getInstance();
        const po = new PostOffice();
        const httpRequest = new AsyncHttpRequest().setMethod('GET').setTargetHost(targetHost).setUrl('/health');
        const req = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBeInstanceOf(Object);
        const map = new MultiLevelMap(result.getBody() as object);
        expect(map.getElement('name')).toBe('example-app');
        expect(map.getElement('origin')).toBe(platform.getOriginId());
        expect(map.getElement('up')).toBe(true);
        expect(map.getElement('dependency[0].href')).toBe('http://127.0.0.1');
        expect(map.getElement('dependency[0].route')).toBe('demo.health');
        expect(map.getElement('dependency[0].status_code')).toBe(200);
        expect(map.getElement('dependency[0].message')).toEqual({"status": "demo.service is running fine"});
    });

    it('can do HTTP-GET to /api/hello/world', async () => {
        const po = new PostOffice();
        const httpRequest = new AsyncHttpRequest().setMethod('GET');
        httpRequest.setTargetHost(targetHost).setUrl('/api/hello/world');
        httpRequest.setQueryParameter('x', 'y');
        const req = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBeInstanceOf(Object);
        const map = new MultiLevelMap(result.getBody() as object);
        expect(map.getElement('headers.user-agent')).toBe('async-http-client');
        expect(map.getElement('method')).toBe('GET');
        expect(map.getElement('ip')).toBe('127.0.0.1');
        expect(map.getElement('url')).toBe('/api/hello/world');
        expect(map.getElement('parameters.query.x')).toBe('y');
    });

    it('can catch HTTP-GET exception from /api/hello/world', async () => {
        const po = new PostOffice();
        const httpRequest = new AsyncHttpRequest().setMethod('GET');
        httpRequest.setTargetHost(targetHost).setUrl('/api/hello/world');
        httpRequest.setQueryParameter('exception', 'true').setHeader('accept', 'application/json');
        const req = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBeInstanceOf(Object);
        const body = result.getBody() as object;
        expect(result.getStatus()).toBe(400);
        expect(body['status']).toBe(400);
        expect(body['type']).toBe('error');
        expect(body['message']).toBe('Just a demo exception');
    });

    it('can download file from hello.world', async () => {
        const po = new PostOffice();
        const line1 = 'Congratulations! If you see this file, this means you have successfully download it from this app.\n\n';
        const line2 = 'hello world\n';
        const line3 = 'end of file';
        const httpRequest = new AsyncHttpRequest().setMethod('GET');
        httpRequest.setTargetHost(targetHost).setUrl('/api/hello/world');
        httpRequest.setQueryParameter('download', 'true');
        const req = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getHeader('content-type')).toBe('application/octet-stream');
        expect(result.getHeader('Content-Disposition')).toBe('attachment; filename=hello.txt');
        expect(result.getHeader(STREAM_CONTENT)).toBeTruthy();
        const streamId = result.getHeader(STREAM_CONTENT);
        const inStream = new ObjectStreamReader(streamId, 3000);
        const blocks = new Array<Buffer>();
        for (let i=0; i < 10; i++) {
            const block = await inStream.read();
            if (block instanceof Buffer) {
                blocks.push(block);
            } else {
                break;
            }
        }
        // the demo file has 3 lines
        expect(blocks.length).toBe(3);
        expect(blocks[0]).toStrictEqual(Buffer.from(line1));
        expect(blocks[1]).toStrictEqual(Buffer.from(line2));
        expect(blocks[2]).toStrictEqual(Buffer.from(line3));
    });

    it('can upload file to hello.world', async () => {
        const line1 = 'hello world\n';
        const line2 = 'second line';
        const po = new PostOffice();
        const filename = 'hello-world.txt';
        const httpRequest = new AsyncHttpRequest().setMethod('POST');
        httpRequest.setTargetHost(targetHost).setUrl('/api/hello/upload');
        httpRequest.setHeader('content-type', 'multipart/form-data');
        const stream = new ObjectStreamIO(60);
        const out = new ObjectStreamWriter(stream.getOutputStreamId());
        // For file upload, the data block must be binary
        out.write(Buffer.from(line1));
        out.write(Buffer.from(line2));
        out.close();
        httpRequest.setStreamRoute(stream.getInputStreamId());
        httpRequest.setFileName(filename);
        const req = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(httpRequest.toMap());
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toBeInstanceOf(Object);
        const body = result.getBody() as object;
        expect(body[STREAM_CONTENT]).toBeTruthy();
        // the echoed streamId will be different
        // because AsyncHttpClient will send the file upload as another stream
        expect(body[STREAM_CONTENT] != stream.getInputStreamId()).toBe(true);
        expect(body['filename']).toBe(filename);
        expect(typeof body['type']).toBe('string');
        expect(body['service']).toBe('hello.world');
        const originalContentType = body['type'] as string;
        // The AsyncHttpClient will perform the actual multipart file upload.
        // Therefore, the content type will have the boundary ID.
        expect(originalContentType.startsWith('multipart/form-data;')).toBe(true);
        expect(originalContentType.includes('boundary')).toBe(true);
        expect(body['size']).toBe(line1.length + line2.length);
    });

});
