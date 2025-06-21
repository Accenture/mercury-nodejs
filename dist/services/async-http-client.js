import { Logger } from '../util/logger.js';
import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { AppException } from '../models/app-exception.js';
import { ObjectStreamIO, ObjectStreamWriter, ObjectStreamReader } from '../system/object-stream.js';
import { ContentTypeResolver } from '../util/content-type-resolver.js';
import axios from 'axios';
import stream from 'stream';
import FormData from 'form-data';
const log = Logger.getInstance();
const po = new PostOffice();
const resolver = ContentTypeResolver.getInstance();
const HTTP_CLIENT_SERVICE = 'async.http.request';
const GET = 'GET';
const HEAD = 'HEAD';
const PUT = 'PUT';
const POST = 'POST';
const PATCH = 'PATCH';
const DELETE = 'DELETE';
const OPTIONS = 'OPTIONS';
const METHODS = [GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS];
const MUST_DROP_HEADERS = ["content-encoding", "transfer-encoding", "host", "connection",
    "upgrade-insecure-requests", "accept-encoding", "user-agent",
    "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user"];
const MULTIPART_FORM_DATA = "multipart/form-data";
const STREAM_CONTENT = 'x-stream-id';
const CONTENT_TYPE = 'content-type';
const CONTENT_LENGTH = 'content-length';
const X_CONTENT_LENGTH = 'x-content-length';
const X_NO_STREAM = "x-small-payload-as-bytes";
const X_TTL = 'x-ttl';
const APPLICATION_JSON = 'application/json';
const APPLICATION_XML = 'application/xml';
const APPLICATION_JAVASCRIPT = "application/javascript";
const TEXT_PREFIX = 'text/';
const UTF_8 = 'utf-8';
const MY_TRACE_ID = "my_trace_id";
const X_TRACE_ID = "x-trace-id";
const USER_AGENT = "user-agent";
const ECONNREFUSED = 'ECONNREFUSED';
function loadBuffer(reqBody) {
    let b;
    if (reqBody instanceof Buffer) {
        b = reqBody;
    }
    else if (typeof reqBody == 'string') {
        b = Buffer.from(reqBody);
    }
    else if (reqBody instanceof Object) {
        b = Buffer.from(JSON.stringify(reqBody));
    }
    else {
        b = Buffer.from('');
    }
    return b;
}
function uploadBlock(size, b, handler) {
    if (size) {
        if (b.length > size) {
            let start = 0;
            let end = size;
            while (start <= b.length) {
                if (end - start < size) {
                    handler.push(b.subarray(start));
                    break;
                }
                else {
                    handler.push(b.subarray(start, end));
                    start = end;
                    end += size;
                }
            }
        }
        else {
            handler.push(b);
        }
    }
    else {
        handler.push(b);
    }
}
function handleInputStream(requestConfig, streamId, timeout, reqContentType, method, filename) {
    // handle input stream
    const upload = new ObjectStreamReader(streamId, timeout);
    const uploadStream = new stream.Readable({
        read: function (size) {
            upload.read().then(v => {
                if (v) {
                    let b = null;
                    if (v instanceof Buffer) {
                        b = v;
                    }
                    else if (typeof v == 'string') {
                        b = Buffer.from(v);
                    }
                    else {
                        log.error(`Stream dropped because data in ${streamId} is not Buffer or string`);
                        this.push(null);
                    }
                    uploadBlock(size, b, this);
                }
                else {
                    this.push(null);
                    upload.close();
                }
            });
        }
    });
    uploadStream.on('close', () => {
        log.debug(`Upload from ${streamId} completed`);
    });
    uploadStream.on('end', () => {
        log.debug(`Closing ${streamId}`);
    });
    if (reqContentType.startsWith(MULTIPART_FORM_DATA) && POST == method && filename) {
        const form = new FormData();
        form.append('file', uploadStream, filename);
        requestConfig.data = form;
    }
    else {
        requestConfig.data = uploadStream;
    }
}
function renderFixedLenContent(httpResponse, textContent, blocks, resContentType, result) {
    const b = Buffer.concat(blocks);
    if (resContentType.startsWith(APPLICATION_JSON)) {
        const text = normalizeTextResponse(httpResponse.status, b.toString(UTF_8)).trim();
        if ((text.startsWith('{') && text.endsWith('}')) ||
            (text.startsWith('[') && text.endsWith(']'))) {
            try {
                result.setBody(JSON.parse(text));
            }
            catch (e) {
                if (e) {
                    result.setBody(text);
                }
            }
        }
        else {
            result.setBody(text);
        }
    }
    else if (textContent) {
        result.setBody(normalizeTextResponse(httpResponse.status, b.toString(UTF_8)));
    }
    else {
        // binary content
        result.setBody(b);
    }
}
function setupHttpRequest(request) {
    const md = new ReqMetadata();
    md.method = request.getMethod();
    if (!(md.method && METHODS.includes(md.method))) {
        throw new AppException(405, "Method not allowed");
    }
    const targetHost = request.getTargetHost();
    if (targetHost == null) {
        throw new AppException(400, "Missing target host. e.g. https://hostname");
    }
    try {
        md.targetUrl = new URL(targetHost);
    }
    catch (e) {
        throw new AppException(400, e.message);
    }
    const protocol = md.targetUrl.protocol;
    if ("http:" == protocol) {
        md.secure = false;
    }
    else if ("https:" == protocol) {
        md.secure = true;
    }
    else {
        throw new AppException(400, "Protocol must be http or https");
    }
    const validHost = !!md.targetUrl.hostname;
    if (!validHost) {
        throw new AppException(400, "Unable to resolve target host as domain or IP address");
    }
    if (md.targetUrl.pathname && md.targetUrl.pathname != '/') {
        throw new AppException(400, "Target host must not contain URI path");
    }
    return md;
}
function getUriWithQuery(request) {
    let uri = request.getUrl();
    if (uri.includes('?')) {
        // when there are more than one query separator, drop the middle portion.
        const sep1 = request.getUrl().indexOf('?');
        const sep2 = request.getUrl().lastIndexOf('?');
        uri = cleanEncodeURI(decodeURI(request.getUrl().substring(0, sep1)));
        const q = request.getUrl().substring(sep2 + 1).trim();
        if (q) {
            request.setQueryString(q);
        }
    }
    else {
        uri = cleanEncodeURI(decodeURI(uri));
    }
    // construct target URL
    let qs = request.getQueryString();
    const queryParams = queryParametersToString(request);
    if (queryParams) {
        qs = qs == null ? queryParams : qs + "&" + queryParams;
    }
    return uri + (qs == null ? "" : "?" + qs);
}
function setupHeaders(request) {
    const result = {};
    result[USER_AGENT] = 'async-http-client';
    const reqHeaders = request.getHeaders();
    for (const h in request.getSession()) {
        reqHeaders[h] = request.getSessionInfo(h);
    }
    for (const h in reqHeaders) {
        if (allowedHeader(h)) {
            result[h] = reqHeaders[h];
        }
    }
    let cookies = '';
    for (const c in request.getCookies()) {
        cookies += c;
        cookies += '=';
        cookies += encodeURI(request.getCookie(c));
        cookies += '; ';
    }
    if (cookies.length > 0) {
        // remove the ending separator
        cookies = cookies.substring(0, cookies.length - 2);
        result['cookie'] = cookies;
    }
    return result;
}
class ReqMetadata {
    method;
    secure;
    targetUrl;
}
export class AsyncHttpClient {
    static routeName = HTTP_CLIENT_SERVICE;
    initialize() {
        return this;
    }
    async handleEvent(evt) {
        if (!(evt.getReplyTo() && evt.getBody() instanceof Object)) {
            throw new AppException(400, "Input is not a HTTP request");
        }
        const traceId = evt.getHeader(MY_TRACE_ID);
        const request = new AsyncHttpRequest(evt.getBody());
        const md = setupHttpRequest(request);
        const uriWithQuery = getUriWithQuery(request);
        const reqHeaders = setupHeaders(request);
        const fqUrl = (md.secure ? 'https://' : 'http://') + md.targetUrl.host + uriWithQuery;
        // minimum timeout value is 5 seconds
        const timeout = Math.max(5000, request.getTimeoutSeconds() * 1000);
        if (traceId) {
            reqHeaders[X_TRACE_ID] = traceId;
        }
        // When validateStatus returns true, HTTP-4xx and 5xx responses are processed as regular response.
        // We can then handle different HTTP responses in a consistent fashion.
        // Since we don't know the payload size of the HTTP response, 'stream' is a better option.
        const requestConfig = {
            method: md.method,
            url: fqUrl,
            headers: reqHeaders,
            timeout: timeout,
            responseType: 'stream',
            validateStatus: (status) => status != null
        };
        if (PUT == md.method || POST == md.method || PATCH == md.method) {
            const reqContentType = String(reqHeaders[CONTENT_TYPE]);
            const reqBody = request.getBody();
            const streamId = request.getStreamRoute();
            const filename = request.getFileName();
            if (streamId && streamId.startsWith('stream.') && streamId.endsWith('.in')) {
                handleInputStream(requestConfig, streamId, timeout, reqContentType, md.method, filename);
            }
            else if (reqBody) {
                const b = loadBuffer(reqBody);
                requestConfig.data = b;
                reqHeaders[CONTENT_LENGTH] = b.length;
            }
            else {
                reqHeaders[CONTENT_LENGTH] = 0;
            }
        }
        try {
            const httpResponse = await axios(requestConfig);
            const resHeaders = new Map();
            for (const h in httpResponse.headers) {
                resHeaders.set(h.toLowerCase(), String(httpResponse.headers[h]));
            }
            const resContentType = resolver.getContentType(resHeaders.get(CONTENT_TYPE));
            const resContentLen = resHeaders.get(CONTENT_LENGTH);
            const textContent = isTextResponse(resContentType);
            const renderAsBytes = "true" == request.getHeader(X_NO_STREAM);
            const fixedLenContent = renderAsBytes || resContentLen || textContent;
            let len = 0;
            const blocks = Array();
            let objectStream = null;
            let responseStream = null;
            const outputStream = new stream.Writable({
                write: function (chunk, _encoding, next) {
                    if (chunk instanceof Buffer) {
                        len += chunk.length;
                        if (fixedLenContent) {
                            blocks.push(chunk);
                        }
                        else {
                            if (objectStream == null) {
                                objectStream = new ObjectStreamIO(timeout / 1000);
                                responseStream = new ObjectStreamWriter(objectStream.getOutputStreamId());
                            }
                            responseStream.write(chunk);
                        }
                    }
                    if (typeof next == 'function') {
                        next();
                    }
                }
            });
            outputStream.on('close', () => {
                const result = new EventEnvelope().setTo(evt.getReplyTo()).setCorrelationId(evt.getCorrelationId());
                result.setStatus(httpResponse.status);
                const headerNames = Array.from(resHeaders.keys());
                for (const h of headerNames) {
                    result.setHeader(h, resHeaders.get(h));
                }
                if (OPTIONS == md.method || HEAD == md.method || !resContentType) {
                    result.setHeader(CONTENT_LENGTH, "0");
                    result.setBody('');
                }
                else if (fixedLenContent) {
                    renderFixedLenContent(httpResponse, textContent, blocks, resContentType, result);
                }
                else if (responseStream != null) {
                    result.setHeader(STREAM_CONTENT, objectStream.getInputStreamId());
                    result.setHeader(X_TTL, String(timeout));
                    result.setHeader(X_CONTENT_LENGTH, String(len));
                    responseStream.close();
                }
                po.send(result);
            });
            outputStream.on('error', e => {
                const error = new EventEnvelope().setTo(evt.getReplyTo())
                    .setCorrelationId(evt.getCorrelationId())
                    .setBody(e.message).setStatus(400);
                po.send(error);
            });
            httpResponse.data.pipe(outputStream);
        }
        catch (ex) {
            // this happens only when HTTP connection fails
            const error = new EventEnvelope().setTo(evt.getReplyTo()).setCorrelationId(evt.getCorrelationId());
            error.setStatus(500).setBody(normalizeTextResponse(500, ex.message));
            await po.send(error);
        }
        return null;
    }
}
function normalizeTextResponse(status, message) {
    if (status < 400) {
        return message;
    }
    else {
        // convert error code for connection failure into a readable message
        const ex = message.indexOf(ECONNREFUSED);
        return ex == -1 ? message : 'Connection refused - ' + message.substring(ex + ECONNREFUSED.length).trim();
    }
}
function isTextResponse(contentType) {
    return contentType != null && (contentType.startsWith(APPLICATION_JSON) || contentType.startsWith(APPLICATION_XML) ||
        contentType.startsWith(TEXT_PREFIX) || contentType.startsWith(APPLICATION_JAVASCRIPT));
}
function allowedHeader(header) {
    const lowerCaseHeader = header.toLowerCase();
    for (const h of MUST_DROP_HEADERS) {
        if (lowerCaseHeader == h) {
            return false;
        }
    }
    return true;
}
function queryParametersToString(request) {
    let sb = '';
    const params = request.getQueryParameters();
    for (const k in params) {
        const v = params[k];
        if (typeof (v) == 'string') {
            sb += k;
            sb += '=';
            sb += v;
            sb += '&';
        }
        if (Array.isArray(v)) {
            for (const item of v) {
                sb += k;
                sb += '=';
                sb += item;
                sb += '&';
            }
        }
    }
    return sb.length > 0 ? sb.substring(0, sb.length - 1) : sb;
}
function cleanEncodeURI(uri) {
    const result = encodeURI(uri).replaceAll("+", "%20");
    return result.startsWith('/') ? result : '/' + result;
}
//# sourceMappingURL=async-http-client.js.map