import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { Composable } from '../models/composable.js';
import { Platform } from './platform.js';
import { PostOffice } from './post-office.js';
import { ObjectStreamIO, ObjectStreamWriter, ObjectStreamReader } from './object-stream.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { RoutingEntry, AssignedRoute, HeaderInfo } from '../util/routing.js';
import { AppConfig, ConfigReader } from '../util/config-reader.js';
import { Server } from 'http';
import express, { RequestHandler, Request, Response } from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import busboy from 'busboy';
import crypto from 'crypto';
import fs from 'fs';
import { Socket } from 'net';

const log = Logger.getInstance();
const util = new Utility();
const po = new PostOffice();
const httpContext = {};
const ETAG = "ETag";
const IF_NONE_MATCH = "If-None-Match";
const CONTENT_TYPE = "Content-Type";
const CONTENT_LENGTH = "Content-Length";
const LOWERCASE_CONTENT_TYPE = "content-type";
const APPLICATION_URL_ENCODED = "application/x-www-form-urlencoded";
const APPLICATION_OCTET_STREAM = "application/octet-stream";
const MULTIPART_FORM_DATA = "multipart/form-data";
const APPLICATION_JSON = "application/json";
const APPLICATION_XML = "application/xml";
const TEXT_PREFIX = 'text/';
const TEXT_PLAIN = "text/plain";
const TEXT_HTML = "text/html";
const TEXT_CSS = "text/css";
const TEXT_JAVASCRIPT = "text/javascript";
const HTTPS = "https";
const PROTOCOL = "x-forwarded-proto";
const OPTIONS_METHOD = 'OPTIONS';
const HTML_START = '<html><body><pre>\n';
const HTML_END = '\n</pre></body></html>';
const REST_AUTOMATION_HOUSEKEEPER = "rest.automation.housekeeper";
const ASYNC_HTTP_RESPONSE = "async.http.response";
const STREAM_CONTENT = 'x-stream-id';
const DEFAULT_SERVER_PORT = 8086;

let loaded = false;
let server: Server = null;
let running = false;
let self: RestEngine;

function ready(port: number) {
    const now = new Date();
    const diff = now.getTime() - Platform.getInstance().getStartTime().getTime();
    log.info(`Modules loaded in ${diff} ms`);
    log.info(`Reactive HTTP server running on port ${port}`);
    loaded = true;
}

export class RestAutomation {
    private static singleton: RestAutomation;

    /**
     * Enable REST automation
     */
    private constructor() {
        if (self === undefined) {
            self = new RestEngine();
        }
    }

    static getInstance(): RestAutomation {
        if (RestAutomation.singleton === undefined) {
            RestAutomation.singleton = new RestAutomation();
        }
        return RestAutomation.singleton;
    }

    /**
     * Start the REST automation engine
     * 
     * If "rest.automation.yaml" is defined in application.yml, REST automation will render the
     * rest.yaml file to accept the configured REST endpoints.
     * Otherwise, it will skip REST automation and provide basic actuator endpoints such as /info and /health
     */
    async start() {
        const platform = Platform.getInstance();
        await platform.getReady();
        self.startHttpServer();
    }

    /**
     * Stop the REST automation engine
     * 
     * @returns true when the stop command is executed.
     */
    async stop() {
        return await self.close();
    }

    /**
     * Wait for the REST automation system to be ready
     * 
     * @returns true
     */
    async getReady() {
        // check if essential services are loaded
        let t1 = new Date().getTime();
        while(!loaded) {
            await util.sleep(1);
            // REST automation system should be ready very quickly.
            // If there is something that blocks it from starting up,
            // this would print alert every two seconds.
            const now = new Date().getTime();
            if (now - t1 >= 2000) {
                t1 = now;
                log.warn('Waiting for REST automation system to get ready');
                return false;
            }
        }
        return true;
    }    

    /**
     * Optional: Setup additional Express middleware
     * 
     * IMPORTANT: This API is provided for backward compatibility with existing code
     * that uses Express plugins. In a composable application, you can achieve the same
     * functionality by declaring your user function as an "interceptor".
     * 
     * User defined middleware has input arguments (req: Request, res: Response, next: NextFunction).
     * It must call the "next()" method at the end of processing to pass the request and response
     * objects to the rest-automation engine for further processing.
     * 
     * It should not touch the request body for multipart file upload because the rest-automation
     * engine will take care of it.
     * 
     * If you must add middleware, call this method before you execute the "start" method in
     * rest-automation. Please refer to the BeforeAll section in po.test.ts file as a worked
     * example.
     * 
     * @param handler implements RequestHandler
     */
    setupMiddleWare(handler: RequestHandler) {
        self.setupMiddleWare(handler);
    }
}

class HouseKeeper implements Composable {
    initialize(): Composable { 
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        if ('close' == evt.getHeader('type')) {
            if (self) {
                await self.close();
            }
        }
        return null;
    }
}

class AsyncHttpResponse implements Composable {
    initialize(): Composable { 
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        // creating a clean copy of the event, thus preventing metadata to propagate as HTTP response headers
        const serviceResponse = new EventEnvelope(evt);
        const cid = serviceResponse.getCorrelationId();
        const context = cid? httpContext[cid] : null;
        if (context) {
            const req = context['req'] as Request;
            const res = context['res'] as Response;
            const httpReq = context['http'] as AsyncHttpRequest;
            const route = context['route'] as AssignedRoute;
            const router = context['router'] as RoutingEntry;
            const traceHeaderLabel = context['label'] as string;
            const watcher = context['watcher'] as NodeJS.Timeout;
            // immediate clear context after retrieval
            clearTimeout(watcher);
            delete context[cid];
            // handle response
            const traceId = serviceResponse.getTraceId();
            let resBody = serviceResponse.getBody();
            const httpHead = 'HEAD' == httpReq.getMethod();
            let resContentType: string = httpHead? '?' : null;
            let streamId: string = null;
            let streamTimeout: string = null;
            let resHeaders = {};
            for (const h in serviceResponse.getHeaders()) {
                const key = h.toLowerCase();
                const value = serviceResponse.getHeader(h);
                if (key == STREAM_CONTENT && value.startsWith('stream.') && value.endsWith('.in')) {
                    streamId = value;
                } else if (key == 'timeout') {
                    streamTimeout = value;
                } else if (key == LOWERCASE_CONTENT_TYPE) {
                    if (!httpHead) {
                        resContentType = value.toLowerCase();
                        resHeaders[CONTENT_TYPE] = resContentType;
                    }
                } else {
                    resHeaders[key] = value;
                }
            }
            if (resContentType == null) {
                const accept = req.header('accept');
                if (accept) {
                    if (accept.includes(TEXT_HTML)) {
                        resContentType = TEXT_HTML;
                        resHeaders[CONTENT_TYPE] = TEXT_HTML;
                    } else if (accept.includes(APPLICATION_JSON) || accept.includes('*/*')) {
                        resContentType = APPLICATION_JSON;
                        resHeaders[CONTENT_TYPE] = APPLICATION_JSON;
                    } else if (accept.includes(APPLICATION_XML)) {
                        resContentType = APPLICATION_XML;
                        resHeaders[CONTENT_TYPE] = APPLICATION_XML;
                    } else if (accept.includes(APPLICATION_OCTET_STREAM)) {
                        resContentType = APPLICATION_OCTET_STREAM;
                        resHeaders[CONTENT_TYPE] = APPLICATION_OCTET_STREAM;
                    } else {
                        resContentType = TEXT_PLAIN;
                        resHeaders[CONTENT_TYPE] = TEXT_PLAIN;
                    } 
                } else {
                    resContentType = '?';
                }
            }
            if (traceId && traceHeaderLabel) {
                resHeaders[traceHeaderLabel] = traceId;
            }
            if (route.info.responseTransformId != null) {
                resHeaders = self.filterHeaders(router.getResponseHeaderInfo(route.info.responseTransformId), resHeaders);
            }
            for (const h in resHeaders) {
                if (h == 'set-cookie') {
                    const cookieList = String(resHeaders[h]).split('|').filter(v => v.length > 0);
                    for (const c of cookieList) {
                        res.setHeader(self.getHeaderCase(h), c);
                    }
                } else {
                    res.setHeader(self.getHeaderCase(h), resHeaders[h]);
                }                  
            }
            if (resBody) {
                if (typeof resBody == 'string' && serviceResponse.getStatus() >= 400 && resContentType && resContentType.includes('json') && !resBody.startsWith('{')) {
                    resBody = {'type': 'error', 'status': serviceResponse.getStatus(), 'message': resBody};
                }
                let b: Buffer = null;
                if (resBody instanceof Buffer) {
                    b = resBody;
                } else if (resBody instanceof Object) {
                    if (TEXT_HTML == resContentType) {
                        b = Buffer.from(HTML_START + JSON.stringify(resBody, null, 2) + HTML_END);
                    } else {
                        b = Buffer.from(JSON.stringify(resBody, null, 2));
                    }
                } else {
                    b = Buffer.from(String(resBody));
                }
                res.setHeader(CONTENT_LENGTH, b.length);
                res.statusCode = serviceResponse.getStatus();
                res.write(b);
            } else {
                res.statusCode = serviceResponse.getStatus();
                if (streamId) {
                    const timeout = self.getReadTimeout(streamTimeout, route.info.timeoutSeconds * 1000);
                    let done = false;
                    const stream = new ObjectStreamReader(streamId, timeout);        
                    while (!done) {
                        try {
                            const block = await stream.read();
                            if (block) {
                                if (block instanceof Buffer) {
                                    res.write(block);
                                } else if (typeof(block) == 'string') {
                                    const b = Buffer.from(block);
                                    res.write(b);
                                }
                            } else {
                                done = true;
                            }
                        } catch (e) {
                            const status = e instanceof AppException? e.getStatus() : 500;
                            log.error(`Exception - rc=${status}, message=${e.message}`);
                            done = true;
                        }        
                    }
                }
            }          
            res.end();
        } else {
            log.error(`Async HTTP Context ${cid} expired`);
        }
        return null;
    }
}

class RestEngine {
    private loaded = false;
    private plugins = new Array<RequestHandler>;
    private traceIdLabels: Array<string>;
    private htmlFolder: string;
    private mimeTypes = new Map<string, string>();
    private connections = new Map<number, Socket>();

    constructor() {
        if (this.traceIdLabels === undefined) {        
            const config = AppConfig.getInstance();
            this.traceIdLabels = config.getProperty('trace.http.header', 'x-trace-id')
                                .split(',').filter(v => v.length > 0).map(v => v.toLowerCase());
            if (!this.traceIdLabels.includes('x-trace-id')) {
                this.traceIdLabels.push('x-trace-id');
            }
        }
    }

    async startHttpServer() {
        if (!this.loaded) {
            this.loaded = true;            
            let restEnabled = false;
            const platform = Platform.getInstance();
            await platform.getReady();
            // register async.http.response and rest.automation.manager
            platform.register(ASYNC_HTTP_RESPONSE, new AsyncHttpResponse(), 200);
            platform.register(REST_AUTOMATION_HOUSEKEEPER, new HouseKeeper());
            const config = AppConfig.getInstance();
            const router = new RoutingEntry();
            // initialize router and load configuration
            const restYamlPath = config.getProperty('yaml.rest.automation', 'classpath:/rest.yaml');
            if (restYamlPath) {
                const restYaml = util.loadYamlFile(config.resolveFilePath(restYamlPath));
                try {
                    const restConfig = new ConfigReader(restYaml.getMap());
                    router.load(restConfig);
                    restEnabled = true;
                } catch (e) {
                    log.error(`Unable to initialize REST endpoints - ${e.message}`);
                }
            }
            this.htmlFolder = config.resolveFilePath(config.getProperty('static.html.folder', 'classpath:/public'));
            log.info(`Static HTML folder: ${this.htmlFolder}`); 
            const mtypes = config.getProperty('yaml.mime.types');
            // if not configured, use the library's built-in mime-types.yml
            const mimeFilePath = mtypes? config.resolveFilePath(mtypes) : util.getFolder("../resources/mime-types.yml");
            const mimeConfig = util.loadYamlFile(mimeFilePath);
            const mimeDefault = mimeConfig.getElement('mime.types') as object;
            for (const k in mimeDefault) {
                const v = mimeDefault[k];
                this.mimeTypes.set(k, v);
            }
            // check for additional MIME in application config
            const mime = config.get('mime.types');
            if (mime instanceof Object && !Array.isArray(mime)) {
                for (const k in mime) {
                    const v = mime[k];
                    this.mimeTypes.set(k.toLowerCase(), String(v).toLowerCase());
                }
            }
            log.info(`Loaded ${this.mimeTypes.size} mime types`);
            let port = util.str2int(config.getProperty('server.port', String(DEFAULT_SERVER_PORT)));
            if (port < 80) {
                log.error(`Port ${port} is invalid. Reset to default port ${DEFAULT_SERVER_PORT}`);
                port = DEFAULT_SERVER_PORT;
            }
            const urlEncodedParser = bodyParser.urlencoded({ extended: false });
            const jsonParser = bodyParser.json();
            const textParser = bodyParser.text({
                type(req) {
                    const contentType = req.headers['content-type'];                    
                    if (contentType) {
                        // accept XML or "text/*" as text content
                        return contentType.startsWith(APPLICATION_XML) || contentType.startsWith(TEXT_PREFIX);
                    } else {
                        return false;
                    }      
                }
            });
            // all content types except multipart upload will be rendered as a byte array
            const binaryParser = bodyParser.raw({
                type(req) {
                    const contentType = req.headers['content-type'];
                    if (contentType && contentType.startsWith(MULTIPART_FORM_DATA)) {
                        // skip "multipart/form-data" because it will be handled by another module
                        return false;
                    } else {
                        return true;
                    }
                },
                limit: '2mb'
            });
            const app = express();
            app.use(cookieParser());
            app.use(urlEncodedParser);
            app.use(jsonParser);
            app.use(textParser);
            // binaryParser must be the last parser to catch all other content types
            app.use(binaryParser);
            // User provided middleware must call the "next()" as the last statement
            // to release control to the rest-automation engine
            let pluginCount = 0;
            for (const handler of this.plugins) {
                app.use(handler);
                pluginCount++;
            }
            if (pluginCount > 0) {
                log.info(`Loaded ${pluginCount} additional middleware`);
            }
            // the last middleware is the rest-automation request handler            
            app.use(async (req: Request, res: Response) => {
                const method = req.method;                
                const uriPath = decodeURI(req.path);
                let found = false;
                if (restEnabled) {                
                    const assigned = router.getRouteInfo(method, uriPath);
                    if (assigned) {
                        if (assigned.info) {
                            try {
                                await this.processRequest(uriPath, req, res, assigned, router);
                            } catch (e) {
                                const rc = e instanceof AppException? e.getStatus() : 500;
                                this.rejectRequest(res, rc, e.message);
                            }                            
                        } else {
                            this.rejectRequest(res, 405, 'Method not allowed');
                        }
                        found = true;
                    }  
                }
                // send HTTP-404 when page is not found
                if (!found) {
                    // detect path traversal
                    if ('GET' == method) {
                        // handle static file download request
                        const file = await this.getStaticFile(uriPath);
                        if (file) {
                            res.setHeader(CONTENT_TYPE, this.getFileContentType(file.name));
                            const ifNoneMatch = req.header(IF_NONE_MATCH);
                            if (file.sameTag(ifNoneMatch)) {
                                res.statusCode = 304;
                                res.setHeader(CONTENT_LENGTH, 0);
                            } else {
                                res.setHeader(ETAG, file.eTag);
                                res.setHeader(CONTENT_LENGTH, file.content.length);
                                res.write(file.content);
                            }
                            res.end();
                            return;
                        }
                    }
                    this.rejectRequest(res, 404, 'Resource not found');
                }               
            });                
            // for security reason, hide server identification
            app.disable('x-powered-by');
            // start HTTP server
            server = app.listen(port, '0.0.0.0', () => {
                running = true;
                // yield so that this is printed after all other processes are done
                setImmediate(() => {
                    ready(port);
                }); 
            });
            // set server side socket timeout
            server.setTimeout(60000);
            server.on('error', (e) => {
                if ('code' in e && e['code'] == 'EADDRINUSE') {
                    log.error(`Cannot start server because port ${port} is already used`);
                    platform.stop();
                } else {
                    log.error(`Network exception - ${e.message}`);
                }
            });
            let seq = 0;
            server.on('connection', socket => {
                const session = ++seq;
                log.debug(`Session ${session} connected`);
                this.connections.set(session, socket);
                socket.on('close', () => {
                    this.connections.delete(session);
                    log.debug(`Session ${session} closed`);
                });
            });
        }
    }

    setupMiddleWare(handler: RequestHandler) {
        this.plugins.push(handler);
    }

    async sendActuatorResponse(result: EventEnvelope, res: Response) {
        try {
            res.statusCode = result.getStatus();
            const ct = result.getHeader(CONTENT_TYPE);
            if (ct) {
                res.setHeader(CONTENT_TYPE, ct);
            }
            if (TEXT_PLAIN == ct && 'OK' == result.getBody()) {
                // LIVENESS_PROBE endpoint
                const b = Buffer.from('OK');
                res.setHeader(CONTENT_LENGTH, b.length);
                res.write(b);
            } 
            if (APPLICATION_JSON == ct && result.getBody() instanceof Object) {
                // INFO or HEALTH endpoint
                const text = JSON.stringify(result.getBody(), null, 2);
                const b = Buffer.from(text);
                res.setHeader(CONTENT_LENGTH, b.length);
                res.write(b);                
            }
            res.end();
        } catch (e) {
            const rc = e instanceof AppException? e.getStatus() : 500;
            this.rejectRequest(res, rc, e.message);
        }        
    }

    async processRequest(path: string, req: Request, res: Response, route: AssignedRoute, router: RoutingEntry) {
        const method = req.method;
        if (OPTIONS_METHOD == method) {
            if (route.info.corsId == null) {
                throw new AppException(405, "Method not allowed");
            } else {
                const corsInfo = router.getCorsInfo(route.info.corsId);
                if (corsInfo != null && corsInfo.options.size > 0) {
                    for (const h of corsInfo.options.keys()) {
                        const prettyHeader = this.getHeaderCase(h);
                        if (prettyHeader != null) {
                            res.setHeader(prettyHeader, corsInfo.options.get(h));
                        }
                    }
                    // set status to "HTTP-204: No content"
                    res.statusCode = 204;
                    res.end();
                } else {
                    throw new AppException(405, "Method not allowed");
                }
            }
            return;
        }
        // set cors headers
        if (route.info.corsId) {
            const corsInfo = router.getCorsInfo(route.info.corsId);
            if (corsInfo != null && corsInfo.headers.size > 0) {
                for (const h of corsInfo.headers.keys()) {
                    const prettyHeader = this.getHeaderCase(h);
                    if (prettyHeader != null) {
                        res.setHeader(prettyHeader, corsInfo.headers.get(h));
                    }
                }
            }
        }
        // check if target service is available
        let authService: string = null;
        if (!po.exists(route.info.primary)) {
            throw new AppException(503, `Service ${route.info.primary} not reachable`);
        }
        if (route.info.defaultAuthService) {
            const authHeaders = route.info.authHeaders;
            if (authHeaders.length > 0) {
                for (const h of authHeaders) {
                    const v = req.header(h);
                    if (v) {
                        let svc = route.info.getAuthService(h);
                        if (svc == null) {
                            svc = route.info.getAuthService(h, v);
                        }
                        if (svc != null) {
                            authService = svc;
                            break;
                        }
                    }
                }
            }
            if (authService == null) {
                authService = route.info.defaultAuthService;
            }
            if (!po.exists(authService)) {
                throw new AppException(503, `Service ${authService} not reachable`);
            }
        }
        let qs = '';
        const httpReq = new AsyncHttpRequest();
        for (const k in req.query) {            
            const v = String(req.query[k]);
            httpReq.setQueryParameter(k, v);
            qs += ('&'+k+'='+v);
        }
        if (qs) {
            qs = qs.substring(1);
        }
        httpReq.setUrl(this.normalizeUrl(path, route.info.urlRewrite));
        httpReq.setQueryString(qs);
        if (route.info.host) {
            httpReq.setTargetHost(route.info.host);
            httpReq.setTrustAllCert(route.info.trustAllCert);
        }
        httpReq.setMethod(method);
        httpReq.setSecure(HTTPS == req.header(PROTOCOL));
        httpReq.setTimeoutSeconds(route.info.timeoutSeconds);
        if (route.arguments.size > 0) {
            for (const p of route.arguments.keys()) {
                httpReq.setPathParameter(p, route.arguments.get(p));
            }
        }
        let reqHeaders = {};
        for (const h in req.headers) {
            const lh = h.toLowerCase();
            if (lh != 'cookie') {
                reqHeaders[lh] = req.header(h);
            }
        }
        for (const k in req.cookies) {
            const v = req.cookies[k];
            if (typeof(v) == 'string') {
                httpReq.setCookie(k, v);
            }
        }
        if (route.info.requestTransformId != null) {
            reqHeaders = this.filterHeaders(router.getRequestHeaderInfo(route.info.requestTransformId), reqHeaders);
        }
        for (const h in reqHeaders) {
            httpReq.setHeader(h, reqHeaders[h]);
        }
        if (route.info.flowId != null) {
            httpReq.setHeader("x-flow-id", route.info.flowId);
        }
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress);
        httpReq.setRemoteIp(ip);
        // Distributed tracing required?
        let traceId: string = null;
        let tracePath: string = null;
        let traceHeaderLabel: string = null;
        // Set trace header if needed
        if (route.info.tracing) {
            const traceHeader = this.getTraceId(req);
            traceHeaderLabel = traceHeader[0];
            traceId = traceHeader[1];
            tracePath = method + " " + path;
            if (qs) {
                tracePath += "?" + qs;
            }
        }
        if ('POST' == method || 'PUT' == method || 'PATCH' == method) {
            let contentType = req.header(CONTENT_TYPE);
            if (!contentType) {
                contentType = TEXT_PLAIN;
            }
            if (contentType.startsWith(MULTIPART_FORM_DATA) && 'POST' == method && route.info.upload) {
                const bb = busboy({ headers: req.headers });
                let len = 0;
                bb.on('file', (name, file, info) => {
                    const stream = new ObjectStreamIO(route.info.timeoutSeconds);
                    const outputStream = new ObjectStreamWriter(stream.getOutputStreamId());
                    file.on('data', (data) => {                    
                        len += data.length;
                        outputStream.write(data);
                    }).on('close', () => {
                        httpReq.setStreamRoute(stream.getInputStreamId())
                                .setFileName(info.filename)
                                .setContentLength(len)
                                .setUploadTag(name);
                        outputStream.close();                                                    
                    });
                  });
                  bb.on('field', (name, value) => {
                    httpReq.setQueryParameter(name, value);
                  });
                  bb.on('close', () => {
                    this.relay(authService, traceId, tracePath, traceHeaderLabel, httpReq, req, res, route, router)
                        .catch(e => {
                            const rc = e instanceof AppException? e.getStatus() : 500;
                            this.rejectRequest(res, rc, e.message);
                        });
                  });
                  bb.on('error', (e) => {
                    this.rejectRequest(res, 500, 'Unexpected upload exception');
                    log.error(`Unexpected upload exception ${e}`);
                  });
                req.pipe(bb);
                return;
            } else {
                if (contentType.startsWith(APPLICATION_URL_ENCODED)) {
                    for (const k in req.body) {
                        httpReq.setQueryParameter(k, req.body[k]);
                    }
                } else if (req.body) {
                    httpReq.setBody(req.body);
                } 
            }            
        }
        await this.relay(authService, traceId, tracePath, traceHeaderLabel, httpReq, req, res, route, router);
    }

    async relay(authService: string, traceId: string, tracePath: string, traceHeaderLabel: string, 
                    httpReq: AsyncHttpRequest,
                    req: Request, res: Response, route: AssignedRoute, router: RoutingEntry) {
        if (authService) {
            const authRequest = new EventEnvelope().setTo(authService).setFrom('http.request').setBody(httpReq.toMap());
            if (traceId) {
                authRequest.setTraceId(traceId);
                authRequest.setTracePath(tracePath);
            }
            const authResponse = await po.request(authRequest, route.info.timeoutSeconds * 1000);
            if (true != authResponse.getBody()) {
                throw new AppException(401, 'Unauthorized');
            }
            for (const k in authResponse.getHeaders()) {
                const v = authResponse.getHeader(k);
                httpReq.setSessionInfo(k, v);
            }
        }
        const serviceRequest = new EventEnvelope().setTo(route.info.primary).setFrom('http.request').setBody(httpReq.toMap());
        if (traceId) {
            serviceRequest.setTraceId(traceId);
            serviceRequest.setTracePath(tracePath);
        }
        // copy to secondary addresses if any
        if (route.info.services.length > 1) {
            for (let i=1; i < route.info.services.length; i++) {
                const target = route.info.services[i];
                const secondary = new EventEnvelope().setTo(target).setFrom('http.request').setBody(httpReq.toMap());
                if (traceId) {
                    secondary.setTraceId(traceId);
                    secondary.setTracePath(tracePath);
                }
                try {
                    await po.send(secondary);
                } catch (e) {
                    log.warn(`Unable to copy event to ${target} - ${e.message}`);
                }
            }
        }
        // send request to target service with async.http.response as callback
        const contextId = util.getUuid();
        const timeoutMs = route.info.timeoutSeconds * 1000;
        const timeoutEvent = new EventEnvelope().setTo(ASYNC_HTTP_RESPONSE).setCorrelationId(contextId)
                                                .setStatus(408).setBody(`Timeout for ${route.info.timeoutSeconds} seconds`);
        // install future event to catch timeout of the target service
        const watcher = po.sendLater(timeoutEvent, timeoutMs);
        httpContext[contextId] = {'req': req, 'res': res, 'http': httpReq, 
                                'route': route, 'router': router, 'label': traceHeaderLabel,
                                'watcher': watcher};
        serviceRequest.setCorrelationId(contextId).setReplyTo(ASYNC_HTTP_RESPONSE);
        await po.send(serviceRequest);
    }
    
    getReadTimeout(timeoutOverride: string, contextTimeout: number) {
        if (timeoutOverride == null) {
            return contextTimeout;
        }
        // convert to milliseconds
        const timeout = util.str2int(timeoutOverride) * 1000;
        if (timeout < 1) {
            return contextTimeout;
        }
        return Math.min(timeout, contextTimeout);
    }

    normalizeUrl(url: string, urlRewrite: Array<string>): string {
        if (urlRewrite && urlRewrite.length == 2) {
            if (url.startsWith(urlRewrite[0])) {
                return urlRewrite[1] + url.substring(urlRewrite[0].length);
            }
        }
        return url;
    }

    getHeaderCase(header: string): string {
        let sb = '';
        const parts = header.split("-").filter(v => v.length > 0);
        for (const p of parts) {
            sb += (p.substring(0, 1).toUpperCase());
            if (p.length > 1) {
                sb += (p.substring(1).toLowerCase());
            }
            sb += '-';
        }
        return sb.length == 0? null : sb.substring(0, sb.length-1);
    }

    filterHeaders(headerInfo: HeaderInfo, headers: object): object {
        let result = headers;
        if (headerInfo.keepHeaders != null && headerInfo.keepHeaders.length > 0) {
            // drop all headers except those to be kept
            const toBeKept = {};
            for (const h in headers) {
                if (headerInfo.keepHeaders.includes(h)) {
                    toBeKept[h] = headers[h];
                }
            }
            result = toBeKept;
        } else if (headerInfo.dropHeaders != null && headerInfo.dropHeaders.length > 0) {
            // drop the headers according to "drop" list
            const toBeKept = {};
            for (const h in headers) {
                if (!headerInfo.dropHeaders.includes(h)) {
                    toBeKept[h] = headers[h];
                }
            }
            result = toBeKept;
        }
        if (headerInfo.additionalHeaders != null && headerInfo.additionalHeaders.size > 0) {
            for (const h of headerInfo.additionalHeaders.keys()) {
                result[h] = headerInfo.additionalHeaders.get(h);
            }
        }
        return result;
    }

    getTraceId(req: Request): Array<string> {
        const result = new Array<string>();
        for (const label of this.traceIdLabels) {
            const id = req.header(label);
            if (id) {
                result.push(label);
                result.push(id);
            }
        }
        if (result.length == 0) {
            result.push(this.traceIdLabels[0]);
            result.push(util.getUuid());
        }
        return result;
    }

    rejectRequest(res: Response, rc: number, message: string): void {
        const result = {'type': 'error', 'status': rc, 'message': message};
        const b = Buffer.from(JSON.stringify(result, null, 2));
        res.writeHead(rc, {
            'Content-Type': APPLICATION_JSON,
            'Content-Length': String(b.length)
        });
        res.write(b);
        res.end();
    }

    async getStaticFile(uriPath: string) {
        try {        
            let filePath = util.getSafeFilePath(this.htmlFolder, uriPath);
            let fileName = filePath.substring(filePath.lastIndexOf('/')+1);
            // assume HTML if file name does not have extension
            if (!uriPath.endsWith('/') && !fileName.includes('.')) {
                filePath += ".html";
                fileName += '.html';
            }            
            if (fs.existsSync(filePath)) {
                if (util.isDirectory(filePath)) {
                    filePath += '/index.html';
                    fileName = 'index.html';
                }         
                const content = await fs.promises.readFile(filePath);
                if (content) {
                    const sha1 = crypto.createHash('sha256');
                    sha1.update(content);
                    const hash = sha1.digest('hex');
                    const result = new EtagFile(hash, content);
                    result.name = fileName;
                    return result;
                }
            }
        } catch (e) {
            log.error(`Unable to read static file ${uriPath} - ${e.message}`);
        }
        return null;
    }

    /**
     * This is a very primitive way to resolve content-type for proper loading of
     * HTML, CSS and Javascript contents by a browser.
     * 
     * It is not intended to be a comprehensive MIME type resolver.
     */
    getFileContentType(filename: string) {
        if (filename.endsWith("/") || filename.endsWith(".html") || filename.endsWith(".htm")) {
            return TEXT_HTML;
        } else if (filename.endsWith(".txt")) {
            return TEXT_PLAIN;
        } else if (filename.endsWith(".css")) {
            return TEXT_CSS;
        } else if (filename.endsWith(".js")) {
            return TEXT_JAVASCRIPT;
        } else {
            if (filename.includes('.') && !filename.endsWith('.')) {
                const ext = filename.substring(filename.lastIndexOf('.')+1).toLowerCase();
                const contentType = this.mimeTypes.get(ext);
                if (contentType) {
                    return contentType;
                }
            }
            return APPLICATION_OCTET_STREAM;                  
        }
    }
    
    close(): Promise<boolean> {
        return new Promise((resolve) => {
            if (running && server) {
                let n = 0;
                const sessions = Array.from(this.connections.keys());
                for (const c of sessions) {
                    const socket = this.connections.get(c);
                    socket.destroy();
                    n++;
                }
                if (n > 0) {
                    const s = n == 1? '' : 's';
                    log.info(`Total ${n} active HTTP session${s} closed`);
                }
                server.close( () => {
                    log.info('REST automation service stopped');
                    running = false;
                    resolve(true);
                }); 
            } else {
                resolve(false);
            }
        });
    }

}

class EtagFile {

    public eTag: string;
    public name: string;
    public content: Buffer;

    constructor(eTag: string, content: Buffer) {
        this.eTag = `"${eTag}"`;
        this.content = content;
    }

    sameTag(eTag?: string): boolean {
        if (eTag) {
            if (eTag.includes(",")) {
                const parts = eTag.split(',').filter(v => v.trim().length > 0).map(v => v.trim());
                for (const p of parts) {
                    if (p == eTag) {
                        return true;
                    }
                }                
            } else {
                return this.eTag == eTag;
            }
        }
        return false;
    }
}
