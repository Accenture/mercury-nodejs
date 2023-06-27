import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { Platform } from './platform.js';
import { PostOffice } from './post-office.js';
import { ObjectStreamIO, ObjectStreamWriter, ObjectStreamReader } from './object-stream.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { RoutingEntry, AssignedRoute, HeaderInfo } from '../util/routing.js';
import { ConfigReader } from '../util/config-reader.js';
import { EventApiService } from '../services/event-api.js';
import { ActuatorServices } from '../services/actuator.js';
import { fileURLToPath } from "url";
import { Server } from 'http';
import express, { Express, Request, Response } from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import busboy from 'busboy';
import crypto from 'crypto';
import fs from 'fs';
import { Socket } from 'net';

const log = new Logger();
const util = new Utility();
const po = new PostOffice();
const TYPE = 'type';
const INFO = 'info';
const HEALTH = 'health';
const LIVENESS_PROBE = 'livenessprobe';
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
const REST_AUTOMATION_MANAGER = "rest.automation.manager";
const DEFAULT_SERVER_PORT = 8086;

let platform: Platform = null;
let server: Server = null;
let running = false;

let self: RestEngine = null;

export class RestAutomation {

    /**
     * Enable REST automation
     * 
     * @param configFile location of application.yml or a JSON object configuration base configuration
     * 
     * 
     */
    constructor(configFile?: string | object) {
        if (self == null) {
            self = new RestEngine(configFile);
        }
    }

    /**
     * Start the REST automation engine
     * 
     * If "rest.automation.yaml" is defined in application.yml, REST automation will render the
     * rest.yaml file to accept the configured REST endpoints.
     * Otherwise, it will skip REST automation and provide basic actuator endpoints such as /info and /health
     */
    start(): void {
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
}

async function housekeeper(evt: EventEnvelope) {
    if ('close' == evt.getHeader('type')) {
        if (self) {
            await self.close();
        }
    }
}

class RestEngine {
    private loaded = false;
    private traceIdLabels: Array<string>;
    private actuatorRouteName: string;
    private htmlFolder: string;
    private mimeTypes = new Map<string, string>();
    private connections = new Map<number, Socket>();

    constructor(configFile?: string | object) {
        platform = new Platform(configFile);
        const appConfig = platform.getConfig();
        this.traceIdLabels = appConfig.getProperty('trace.http.header', 'x-trace-id')
                            .split(',').filter(v => v.length > 0).map(v => v.toLowerCase());
        if (!this.traceIdLabels.includes('x-trace-id')) {
            this.traceIdLabels.push('x-trace-id');
        } 
        const actuator = new ActuatorServices();
        this.actuatorRouteName = actuator.getName();
        platform.register(actuator.getName(), actuator.handleEvent, true, 10);  
    }

    startHttpServer(): void {
        if (!this.loaded) {
            this.loaded = true;
            let restEnabled = false;
            const eventApiService = new EventApiService();
            platform.register(eventApiService.getName(), eventApiService.handleEvent, true, 200);
            platform.register(REST_AUTOMATION_MANAGER, housekeeper);
            const config = platform.getConfig();
            const router = new RoutingEntry();
            // initialize router and load configuration
            const restYamlPath = config.getProperty('rest.automation.yaml');
            if (restYamlPath) {
                const restYaml = util.loadYamlFile(restYamlPath);
                try {
                    const restConfig = new ConfigReader(restYaml.getMap());
                    router.load(restConfig);
                    restEnabled = true;
                } catch (e) {
                    log.error(`Unable to initialize REST endpoints - ${e.message}`);
                }
            }
            this.htmlFolder = config.getProperty('static.html.folder', '');
            if (this.htmlFolder.length == 0) {
                this.htmlFolder = util.normalizeFilePath(fileURLToPath(new URL("../resources/public", import.meta.url)));  
            }
            log.info(`Static HTML folder: ${this.htmlFolder}`);
            let mimeCount = 0;
            const mime = config.get('mime.types');
            if (mime instanceof Object && !Array.isArray(mime)) {
                for (const k in mime) {
                    const v = mime[k];
                    this.mimeTypes.set(k.toLowerCase(), String(v).toLowerCase());
                    mimeCount++;
                }
            }
            if (mimeCount > 0) {
                const s = mimeCount == 1? '' : 's';
                log.info(`Loaded ${mimeCount} mimeType${s}`);
            }
            let port = util.str2int(config.getProperty('server.port', String(DEFAULT_SERVER_PORT)));
            if (port < 80) {
                log.error(`Port ${port} is invalid. Reset to default port ${DEFAULT_SERVER_PORT}`);
                port = DEFAULT_SERVER_PORT;
            }
            const app: Express = express();
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
            app.use(cookieParser());
            app.use(urlEncodedParser);
            app.use(jsonParser);
            app.use(textParser);
            // binaryParser must be the last parser to catch all other content types
            app.use(binaryParser);

            app.get('/info', async (_req: Request, res: Response) => {
                const request = new EventEnvelope().setTo(this.actuatorRouteName).setHeader(TYPE, INFO);
                await this.sendActuatorResponse(await po.request(request), res);
            });

            app.get('/health', async (_req: Request, res: Response) => {
                const request = new EventEnvelope().setTo(this.actuatorRouteName).setHeader(TYPE, HEALTH);
                await this.sendActuatorResponse(await po.request(request), res);
            });

            app.get('/livenessprobe', async (_req: Request, res: Response) => {
                const request = new EventEnvelope().setTo(this.actuatorRouteName).setHeader(TYPE, LIVENESS_PROBE);
                await this.sendActuatorResponse(await po.request(request), res);
            });                
            
            app.use(async (req: Request, res: Response) => {
                const method = req.method;
                const path = decodeURI(req.path);
                let found = false;
                if (restEnabled) {                
                    const assigned = router.getRouteInfo(method, path);
                    if (assigned) {
                        if (assigned.info) {
                            try {
                                await this.processRequest(path, req, res, assigned, router);
                            } catch (e) {
                                const rc = e instanceof AppException? e.getStatus() : 500;
                                this.rejectRequest(res, rc, e.message);
                            }
                            
                        } else {
                            this.rejectRequest(res, 405, 'Method not allowed');
                            log.info(`HTTP-405 ${method} ${path}`);
                        }
                        found = true;
                    }  
                }
                // send HTTP-404 when page is not found
                if (!found) {
                    if ('GET' == method) {
                        // handle static file download request
                        const file = await this.getStaticFile(path);
                        if (file) {
                            res.setHeader(CONTENT_TYPE, this.getFileContentType(path));
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
                    log.info(`HTTP-404 ${method} ${path}`);
                }               
            });                
            // for security reason, hide server identification
            app.disable('x-powered-by');
            // start HTTP server
            server = app.listen(port, '0.0.0.0', () => {
                running = true;                
                log.info(`REST automation service started on port ${port}`)
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

    async sendActuatorResponse(result: EventEnvelope, res: Response) {
        try {
            res.statusCode = result.getStatus();
            const ct = result.getHeader(CONTENT_TYPE);
            if (ct) {
                res.setHeader(CONTENT_TYPE, ct);
            }
            if (typeof(result.getBody()) == 'string') {
                const b = Buffer.from(result.getBody() as string);
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
            throw new AppException(503, `"Service ${route.info.primary} not reachable`);
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
                    this.relayRequest(authService, traceId, tracePath, traceHeaderLabel, httpReq, req, res, route, router)
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
        await this.relayRequest(authService, traceId, tracePath, traceHeaderLabel, httpReq, req, res, route, router);
    }

    async relayRequest(authService: string, traceId: string, tracePath: string, traceHeaderLabel: string, 
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
                    po.send(secondary);
                } catch (e) {
                    log.warn(`Unable to copy event to ${target} - ${e.message}`);
                }
            }
        }
        const serviceResponse = await po.request(serviceRequest, route.info.timeoutSeconds * 1000);
        const resBody = serviceResponse.getBody();
        const httpHead = 'HEAD' == httpReq.getMethod();
        let resContentType: string = httpHead? '?' : null;
        let streamId: string = null;
        let streamTimeout: string = null;
        let resHeaders = {};
        for (const h in serviceResponse.getHeaders()) {
            const key = h.toLowerCase();
            const value = serviceResponse.getHeader(h);
            if (key == 'stream' && value.startsWith('stream.') && value.endsWith('.in')) {
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
            resHeaders = this.filterHeaders(router.getResponseHeaderInfo(route.info.responseTransformId), resHeaders);
        }
        for (const h in resHeaders) {
            if (h == 'set-cookie') {
                const cookieList = String(resHeaders[h]).split('|').filter(v => v.length > 0);
                for (const c of cookieList) {
                    res.setHeader(this.getHeaderCase(h), c);
                }
            } else {
                res.setHeader(this.getHeaderCase(h), resHeaders[h]);
            }                  
        }        
        if (resBody) {
            let b: Buffer = null;
            if (typeof resBody == 'string') {
                b = Buffer.from(resBody);
            } else if (resBody instanceof Buffer) {
                b = resBody;
            } else {
                if (TEXT_HTML == resContentType) {
                    b = Buffer.from(HTML_START + JSON.stringify(resBody, null, 2) + HTML_END);
                } else {
                    b = Buffer.from(JSON.stringify(resBody, null, 2));
                }                
            }
            res.setHeader(CONTENT_LENGTH, b.length);
            res.statusCode = serviceResponse.getStatus();
            res.write(b);
        } else {
            res.statusCode = serviceResponse.getStatus();
            if (streamId) {
                const timeout = this.getReadTimeout(streamTimeout, route.info.timeoutSeconds * 1000);
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
        const qs = httpReq.getQueryString()? '?' + httpReq.getQueryString() : '';
        log.info(`HTTP-${serviceResponse.getStatus()} ${httpReq.getMethod()} ${httpReq.getUrl()}${qs}`);
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
        const result = {'status': rc, 'type': 'error', 'message': message};
        const b = Buffer.from(JSON.stringify(result));
        res.writeHead(rc, {
            'Content-Type': APPLICATION_JSON,
            'Content-Length': String(b.length)
        });
        res.write(b);
        res.end();
    }

    async getStaticFile(path: string) {
        let filePath = util.normalizeFilePath(path);
        const parts = filePath.split('/').filter(v => v.trim().length > 0).map(v => v.trim());
        // For security, reject path that tries to read parent folder or hidden file.
        for (const p of parts) {
            if (p.startsWith(".")) {
                return null;
            }
        }
        if (filePath.endsWith('/')) {
            filePath += 'index.html';
        }
        filePath = this.htmlFolder + filePath;
        if (fs.existsSync(filePath)) {
            const content = await fs.promises.readFile(filePath);
            if (content) {
                const sha1 = crypto.createHash('sha1');
                sha1.update(content);
                const hash = sha1.digest('hex');
                return new EtagFile(hash, content);
            }
        }
        return null;
    }

    /**
     * This is a very primitive way to resolve content-type for proper loading of
     * HTML, CSS and Javascript contents by a browser.
     * 
     * It is not intended to be a comprehensive MIME type resolver.
     */
    getFileContentType(path: string) {
        if (path.endsWith("/") || path.endsWith(".html") || path.endsWith(".htm")) {
            return TEXT_HTML;
        } else if (path.endsWith(".txt")) {
            return TEXT_PLAIN;
        } else if (path.endsWith(".css")) {
            return TEXT_CSS;
        } else if (path.endsWith(".js")) {
            return TEXT_JAVASCRIPT;
        } else {
            if (path.includes('.') && !path.endsWith('.')) {
                const ext = path.substring(path.lastIndexOf('.')+1).toLowerCase();
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

    eTag: string;
    content: Buffer;

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
