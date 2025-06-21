import { Logger } from '../util/logger.js';
import { Utility } from '../util/utility.js';
import { Platform } from './platform.js';
import { PostOffice } from './post-office.js';
import { ObjectStreamIO, ObjectStreamWriter, ObjectStreamReader } from './object-stream.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { RoutingEntry } from '../util/routing.js';
import { AppConfig, ConfigReader } from '../util/config-reader.js';
import { ContentTypeResolver } from '../util/content-type-resolver.js';
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import busboy from 'busboy';
const log = Logger.getInstance();
const util = new Utility();
const po = new PostOffice();
const resolver = ContentTypeResolver.getInstance();
const httpContext = {};
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
let server = null;
let running = false;
let self;
function keepSomeHeaders(headerInfo, headers) {
    const result = {};
    for (const h in headers) {
        if (includesLabel(headerInfo.keepHeaders, h)) {
            result[h] = headers[h];
        }
    }
    return result;
}
function dropSomeHeaders(headerInfo, headers) {
    const result = {};
    for (const h in headers) {
        if (!includesLabel(headerInfo.dropHeaders, h)) {
            result[h] = headers[h];
        }
    }
    return result;
}
function includesLabel(headerLabels, h) {
    for (const key of headerLabels) {
        if (util.equalsIgnoreCase(key, h)) {
            return true;
        }
    }
    return false;
}
async function copyToSecondaryTarget(p) {
    for (let i = 1; i < p.route.info.services.length; i++) {
        const target = p.route.info.services[i];
        const secondary = new EventEnvelope().setTo(target).setFrom('http.request').setBody(p.httpReq.toMap());
        if (p.traceId) {
            secondary.setTraceId(p.traceId);
            secondary.setTracePath(p.tracePath);
        }
        try {
            await po.send(secondary);
        }
        catch (e) {
            log.warn(`Unable to copy event to ${target} - ${e.message}`);
        }
    }
}
function setupResponseHeaders(route, router, traceHeaderLabel, serviceResponse, md, httpHead) {
    for (const h in serviceResponse.getHeaders()) {
        const key = h.toLowerCase();
        const value = serviceResponse.getHeader(h);
        if (key == STREAM_CONTENT && value.startsWith('stream.') && value.endsWith('.in')) {
            md.streamId = value;
        }
        else if (key == 'timeout') {
            md.streamTimeout = value;
        }
        else if (key == LOWERCASE_CONTENT_TYPE) {
            if (!httpHead) {
                md.resContentType = value.toLowerCase();
                md.resHeaders[CONTENT_TYPE] = md.resContentType;
            }
        }
        else {
            md.resHeaders[key] = value;
        }
    }
    const traceId = serviceResponse.getTraceId();
    if (traceId && traceHeaderLabel) {
        md.resHeaders[traceHeaderLabel] = traceId;
    }
    if (route.info.responseTransformId) {
        md.resHeaders = self.filterHeaders(router.getResponseHeaderInfo(route.info.responseTransformId), md.resHeaders);
    }
}
function setupResponseContentType(req, md) {
    if (md.resContentType == null) {
        const accept = req.header('accept');
        if (accept) {
            if (accept.includes(TEXT_HTML)) {
                md.resContentType = TEXT_HTML;
                md.resHeaders[CONTENT_TYPE] = TEXT_HTML;
            }
            else if (accept.includes(APPLICATION_JSON) || accept.includes('*/*')) {
                md.resContentType = APPLICATION_JSON;
                md.resHeaders[CONTENT_TYPE] = APPLICATION_JSON;
            }
            else if (accept.includes(APPLICATION_XML)) {
                md.resContentType = APPLICATION_XML;
                md.resHeaders[CONTENT_TYPE] = APPLICATION_XML;
            }
            else if (accept.includes(APPLICATION_OCTET_STREAM)) {
                md.resContentType = APPLICATION_OCTET_STREAM;
                md.resHeaders[CONTENT_TYPE] = APPLICATION_OCTET_STREAM;
            }
            else {
                md.resContentType = TEXT_PLAIN;
                md.resHeaders[CONTENT_TYPE] = TEXT_PLAIN;
            }
        }
        else {
            md.resContentType = '?';
        }
    }
}
function setupResponseCookies(res, md) {
    for (const h in md.resHeaders) {
        if (h == 'set-cookie') {
            const cookieList = String(md.resHeaders[h]).split('|').filter(v => v.length > 0);
            for (const c of cookieList) {
                res.setHeader(self.getHeaderCase(h), c);
            }
        }
        else {
            res.setHeader(self.getHeaderCase(h), md.resHeaders[h]);
        }
    }
}
function writeHttpPayload(res, resBody, serviceResponse, md) {
    let b = null;
    if (resBody instanceof Buffer) {
        b = resBody;
    }
    else if (resBody instanceof Object) {
        if (TEXT_HTML == md.resContentType) {
            b = Buffer.from(HTML_START + JSON.stringify(resBody, null, 2) + HTML_END);
        }
        else {
            b = Buffer.from(JSON.stringify(resBody, null, 2));
        }
    }
    else {
        b = Buffer.from(String(resBody));
    }
    res.setHeader(CONTENT_LENGTH, b.length);
    res.statusCode = serviceResponse.getStatus();
    res.write(b);
}
async function writeHttpStream(res, route, serviceResponse, md) {
    res.statusCode = serviceResponse.getStatus();
    if (md.streamId) {
        const timeout = self.getReadTimeout(md.streamTimeout, route.info.timeoutSeconds * 1000);
        let done = false;
        const stream = new ObjectStreamReader(md.streamId, timeout);
        while (!done) {
            try {
                const block = await stream.read();
                if (block) {
                    writeHttpData(block, res);
                }
                else {
                    done = true;
                }
            }
            catch (e) {
                const status = e instanceof AppException ? e.getStatus() : 500;
                log.error(`Exception - rc=${status}, message=${e.message}`);
                done = true;
            }
        }
    }
}
function writeHttpData(block, res) {
    if (block instanceof Buffer) {
        res.write(block);
    }
    else if (typeof (block) == 'string') {
        const b = Buffer.from(block);
        res.write(b);
    }
}
function ready(port) {
    const now = new Date();
    const diff = now.getTime() - Platform.getInstance().getStartTime().getTime();
    log.info(`Modules loaded in ${diff} ms`);
    log.info(`Reactive HTTP server running on port ${port}`);
    loaded = true;
}
class RelayParameters {
    authService;
    traceId;
    tracePath;
    traceHeaderLabel;
    httpReq;
    req;
    res;
    route;
    router;
}
class ResponseMetadata {
    resContentType = null;
    resHeaders = {};
    streamId = null;
    streamTimeout = null;
}
export class RestAutomation {
    static singleton;
    /**
     * Enable REST automation
     */
    constructor() {
        self ??= new RestEngine();
    }
    static getInstance() {
        RestAutomation.singleton ??= new RestAutomation();
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
        await self.startHttpServer();
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
        const t1 = new Date().getTime();
        while (!loaded) {
            await util.sleep(1);
            // REST automation system should be ready very quickly.
            // If there is something that blocks it from starting up,
            // this would print alert every two seconds.
            const now = new Date().getTime();
            if (now - t1 >= 2000) {
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
    setupMiddleWare(handler) {
        self.setupMiddleWare(handler);
    }
}
class HouseKeeper {
    initialize() {
        return this;
    }
    async handleEvent(evt) {
        if ('close' == evt.getHeader('type')) {
            if (self) {
                await self.close();
            }
        }
        return null;
    }
}
class AsyncHttpResponse {
    initialize() {
        return this;
    }
    async handleEvent(evt) {
        // creating a clean copy of the event, thus preventing metadata to propagate as HTTP response headers
        const serviceResponse = new EventEnvelope(evt);
        const cid = serviceResponse.getCorrelationId();
        const context = cid ? httpContext[cid] : null;
        if (context) {
            const req = context['req'];
            const res = context['res'];
            const httpReq = context['http'];
            const route = context['route'];
            const router = context['router'];
            const traceHeaderLabel = context['label'];
            const watcher = context['watcher'];
            // immediate clear context after retrieval
            clearTimeout(watcher);
            delete context[cid];
            // handle response
            const httpHead = 'HEAD' == httpReq.getMethod();
            let resBody = serviceResponse.getBody();
            const md = new ResponseMetadata();
            // follow this sequence - hedaers, content-type and cookies
            setupResponseHeaders(route, router, traceHeaderLabel, serviceResponse, md, httpHead);
            setupResponseContentType(req, md);
            setupResponseCookies(res, md);
            if (resBody) {
                if (typeof resBody == 'string' && serviceResponse.getStatus() >= 400 && md.resContentType && md.resContentType.includes('json') && !resBody.startsWith('{')) {
                    resBody = { 'type': 'error', 'status': serviceResponse.getStatus(), 'message': resBody };
                }
                writeHttpPayload(res, resBody, serviceResponse, md);
            }
            else {
                await writeHttpStream(res, route, serviceResponse, md);
            }
            res.end();
        }
        else {
            log.error(`Async HTTP Context ${cid} expired`);
        }
        return null;
    }
}
class RestEngine {
    plugins = new Array;
    traceIdLabels;
    customContentTypes = new Map();
    connections = new Map();
    htmlFolder;
    loaded = false;
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
                const restYaml = util.loadYamlFile(config.resolveResourceFilePath(restYamlPath));
                try {
                    const restConfig = new ConfigReader(restYaml.getMap());
                    router.load(restConfig);
                    restEnabled = true;
                }
                catch (e) {
                    log.error(`Unable to initialize REST endpoints - ${e.message}`);
                }
            }
            this.htmlFolder = config.resolveResourceFilePath(config.getProperty('static.html.folder', 'classpath:/public'));
            log.info(`Static HTML folder: ${this.htmlFolder}`);
            this.setupCustomContentTypes(config);
            if (this.customContentTypes.size > 0) {
                log.info(`Loaded ${this.customContentTypes.size} custom content types`);
            }
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
                    }
                    else {
                        return false;
                    }
                }
            });
            // all content types except multipart upload will be rendered as a byte array
            const binaryParser = bodyParser.raw({
                type(req) {
                    const contentType = req.headers['content-type'];
                    if (contentType?.startsWith(MULTIPART_FORM_DATA)) {
                        // skip "multipart/form-data" because it will be handled by another module
                        return false;
                    }
                    else {
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
            // load static file hanlder
            app.use(express.static(this.htmlFolder));
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
            app.use(async (req, res) => {
                this.setupRestHandler(req, res, router, restEnabled);
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
                }
                else {
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
    setupCustomContentTypes(config) {
        const ctypes = config.getProperty('yaml.custom.content.types');
        if (ctypes) {
            const cFilePath = config.resolveResourceFilePath(ctypes);
            const cConfig = util.loadYamlFile(cFilePath);
            if (cConfig.exists('custom.content.types')) {
                const cSettings = cConfig.getElement('custom.content.types');
                if (cSettings instanceof Object && Array.isArray(cSettings)) {
                    for (const entry of cSettings) {
                        this.loadCustomContentTypes(entry);
                    }
                }
            }
        }
        // load custom content types in application config if any
        const ct = config.get('custom.content.types');
        if (ct instanceof Object && Array.isArray(ct)) {
            for (const entry of ct) {
                this.loadCustomContentTypes(entry);
            }
        }
    }
    loadCustomContentTypes(entry) {
        const sep = entry.indexOf('->');
        if (sep != -1) {
            const k = entry.substring(0, sep).trim();
            const v = entry.substring(sep + 2).trim();
            if (k && v) {
                this.customContentTypes.set(k, v.toLowerCase());
            }
        }
    }
    async setupRestHandler(req, res, router, restEnabled) {
        const method = req.method;
        // Avoid "path traversal" attack by filtering "../" from URI
        const uriPath = util.getDecodedUri(req.path);
        let found = false;
        if (restEnabled) {
            const assigned = router.getRouteInfo(method, uriPath);
            if (assigned) {
                if (assigned.info) {
                    this.processRestRequest(uriPath, req, res, assigned, router);
                }
                else {
                    this.rejectRequest(res, 405, 'Method not allowed');
                }
                found = true;
            }
        }
        // send HTTP-404 when page is not found
        if (!found) {
            this.rejectRequest(res, 404, 'Resource not found');
        }
    }
    async processRestRequest(uriPath, req, res, assigned, router) {
        try {
            await this.processRequest(uriPath, req, res, assigned, router);
        }
        catch (e) {
            const rc = e instanceof AppException ? e.getStatus() : 500;
            this.rejectRequest(res, rc, e.message);
        }
    }
    setupMiddleWare(handler) {
        this.plugins.push(handler);
    }
    handleHttpOptions(route, router, res) {
        if (route.info.corsId == null) {
            throw new AppException(405, "Method not allowed");
        }
        else {
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
            }
            else {
                throw new AppException(405, "Method not allowed");
            }
        }
    }
    setCorsHeaders(route, router, res) {
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
    validateAuthService(route, req) {
        let authService = null;
        const authHeaders = route.info.authHeaders;
        if (authHeaders.length > 0) {
            for (const h of authHeaders) {
                const v = req.header(h);
                if (v) {
                    let svc = route.info.getAuthService(h);
                    svc ??= route.info.getAuthService(h, v);
                    if (svc != null) {
                        authService = svc;
                        break;
                    }
                }
            }
        }
        authService ??= route.info.defaultAuthService;
        if (!po.exists(authService)) {
            throw new AppException(503, `Service ${authService} not reachable`);
        }
        return authService;
    }
    handleUpload(req, res, route, httpReq, parameters) {
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
            this.relay(parameters)
                .catch(e => {
                const rc = e instanceof AppException ? e.getStatus() : 500;
                this.rejectRequest(res, rc, e.message);
            });
        });
        bb.on('error', (e) => {
            this.rejectRequest(res, 500, 'Unexpected upload exception');
            log.error(`Unexpected upload exception ${e}`);
        });
        req.pipe(bb);
    }
    parseQuery(req, httpReq) {
        let qs = '';
        for (const k in req.query) {
            const v = req.query[k];
            if (typeof v == 'string') {
                httpReq.setQueryParameter(k, v);
                qs += ('&' + k + '=' + v);
            }
        }
        if (qs) {
            qs = qs.substring(1);
        }
        return qs;
    }
    prepareHttpRequest(uriPath, req, route, router) {
        const method = req.method;
        const httpReq = new AsyncHttpRequest();
        const qs = this.parseQuery(req, httpReq);
        httpReq.setUrl(this.normalizeUrl(uriPath, route.info.urlRewrite));
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
            if (typeof v == 'string') {
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
        return httpReq;
    }
    handleRequestPayload(req, res, route, httpReq, parameters) {
        const method = req.method;
        const contentType = resolver.getContentType(req.header(CONTENT_TYPE)) || TEXT_PLAIN;
        if (contentType.startsWith(MULTIPART_FORM_DATA) && 'POST' == method && route.info.upload) {
            this.handleUpload(req, res, route, httpReq, parameters);
            return true;
        }
        else if (contentType.startsWith(APPLICATION_URL_ENCODED)) {
            for (const k in req.body) {
                httpReq.setQueryParameter(k, req.body[k]);
            }
        }
        else if (req.body) {
            httpReq.setBody(req.body);
        }
        return false;
    }
    async processRequest(uriPath, req, res, route, router) {
        const method = req.method;
        if (OPTIONS_METHOD == method) {
            this.handleHttpOptions(route, router, res);
            return;
        }
        // set cors headers
        if (route.info.corsId) {
            this.setCorsHeaders(route, router, res);
        }
        // check if target service is available
        if (!po.exists(route.info.primary)) {
            throw new AppException(503, `Service ${route.info.primary} not reachable`);
        }
        const authService = route.info.defaultAuthService ? this.validateAuthService(route, req) : null;
        // prepareHttpRequest(uriPath: string, req: Request, route: AssignedRoute, router: RoutingEntry
        const httpReq = this.prepareHttpRequest(uriPath, req, route, router);
        // Distributed tracing required?
        let traceId = null;
        let tracePath = null;
        let traceHeaderLabel = null;
        // Set trace header if needed
        if (route.info.tracing) {
            const traceHeader = this.getTraceId(req);
            traceHeaderLabel = traceHeader[0];
            traceId = traceHeader[1];
            tracePath = method + " " + uriPath;
            if (httpReq.getQueryString()) {
                tracePath += "?" + httpReq.getQueryString();
            }
        }
        const parameters = new RelayParameters();
        parameters.authService = authService;
        parameters.traceId = traceId;
        parameters.tracePath = tracePath;
        parameters.traceHeaderLabel = traceHeaderLabel;
        parameters.route = route;
        parameters.req = req;
        parameters.res = res;
        parameters.router = router;
        parameters.httpReq = httpReq;
        if (('POST' == method || 'PUT' == method || 'PATCH' == method) && this.handleRequestPayload(req, res, route, httpReq, parameters)) {
            return;
        }
        await this.relay(parameters);
    }
    async relay(p) {
        if (p.authService) {
            const authRequest = new EventEnvelope().setTo(p.authService).setFrom('http.request').setBody(p.httpReq.toMap());
            if (p.traceId) {
                authRequest.setTraceId(p.traceId);
                authRequest.setTracePath(p.tracePath);
            }
            const authResponse = await po.request(authRequest, p.route.info.timeoutSeconds * 1000);
            const approved = typeof authResponse.getBody() == 'boolean' ? authResponse.getBody() : false;
            if (!approved) {
                throw new AppException(401, 'Unauthorized');
            }
            for (const k in authResponse.getHeaders()) {
                const v = authResponse.getHeader(k);
                p.httpReq.setSessionInfo(k, v);
            }
        }
        const serviceRequest = new EventEnvelope().setTo(p.route.info.primary).setFrom('http.request').setBody(p.httpReq.toMap());
        if (p.traceId) {
            serviceRequest.setTraceId(p.traceId);
            serviceRequest.setTracePath(p.tracePath);
        }
        // copy to secondary addresses if any
        if (p.route.info.services.length > 1) {
            copyToSecondaryTarget(p);
        }
        // send request to target service with async.http.response as callback
        const contextId = util.getUuid();
        const timeoutMs = p.route.info.timeoutSeconds * 1000;
        const timeoutEvent = new EventEnvelope().setTo(ASYNC_HTTP_RESPONSE).setCorrelationId(contextId)
            .setStatus(408).setBody(`Timeout for ${p.route.info.timeoutSeconds} seconds`);
        // install future event to catch timeout of the target service
        const watcher = po.sendLater(timeoutEvent, timeoutMs);
        httpContext[contextId] = { 'req': p.req, 'res': p.res, 'http': p.httpReq,
            'route': p.route, 'router': p.router, 'label': p.traceHeaderLabel,
            'watcher': watcher };
        serviceRequest.setCorrelationId(contextId).setReplyTo(ASYNC_HTTP_RESPONSE);
        await po.send(serviceRequest);
    }
    getReadTimeout(timeoutOverride, contextTimeout) {
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
    normalizeUrl(url, urlRewrite) {
        if (urlRewrite && urlRewrite.length == 2) {
            if (url.startsWith(urlRewrite[0])) {
                return urlRewrite[1] + url.substring(urlRewrite[0].length);
            }
        }
        return url;
    }
    getHeaderCase(header) {
        let sb = '';
        const parts = header.split("-").filter(v => v.length > 0);
        for (const p of parts) {
            sb += (p.substring(0, 1).toUpperCase());
            if (p.length > 1) {
                sb += (p.substring(1).toLowerCase());
            }
            sb += '-';
        }
        return sb.length == 0 ? null : sb.substring(0, sb.length - 1);
    }
    filterHeaders(headerInfo, headers) {
        let result = headers;
        if (headerInfo.keepHeaders != null && headerInfo.keepHeaders.length > 0) {
            // drop all headers except those to be kept
            result = keepSomeHeaders(headerInfo, headers);
        }
        else if (headerInfo.dropHeaders != null && headerInfo.dropHeaders.length > 0) {
            // drop the headers according to "drop" list
            result = dropSomeHeaders(headerInfo, headers);
        }
        if (headerInfo.additionalHeaders != null && headerInfo.additionalHeaders.size > 0) {
            for (const h of headerInfo.additionalHeaders.keys()) {
                result[h] = headerInfo.additionalHeaders.get(h);
            }
        }
        return result;
    }
    getTraceId(req) {
        const result = new Array();
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
    rejectRequest(res, rc, message) {
        const result = { 'type': 'error', 'status': rc, 'message': message };
        const b = Buffer.from(JSON.stringify(result, null, 2));
        res.writeHead(rc, {
            'Content-Type': APPLICATION_JSON,
            'Content-Length': String(b.length)
        });
        res.write(b);
        res.end();
    }
    close() {
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
                    const s = n == 1 ? '' : 's';
                    log.info(`Total ${n} active HTTP session${s} closed`);
                }
                server.close(() => {
                    log.info('REST automation service stopped');
                    running = false;
                    resolve(true);
                });
            }
            else {
                resolve(false);
            }
        });
    }
}
//# sourceMappingURL=rest-automation.js.map