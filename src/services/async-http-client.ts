import { Logger } from '../util/logger.js';
import { Composable } from '../models/composable.js';
import { PostOffice } from '../system/post-office.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { AppException } from '../models/app-exception.js';
import { ObjectStreamIO, ObjectStreamWriter, ObjectStreamReader } from '../system/object-stream.js';
import axios, { AxiosRequestConfig } from 'axios';
import stream from 'stream';
import FormData from 'form-data';

const log = Logger.getInstance();
const po = new PostOffice();
const HTTP_CLIENT_SERVICE = 'async.http.request';
const GET = 'GET';
const HEAD = 'HEAD';
const PUT = 'PUT';
const POST = 'POST'; 
const PATCH = 'PATCH';
const DELETE = 'DELETE';
const OPTIONS = 'OPTIONS';
const METHODS = [GET, HEAD, PUT, POST, PATCH, DELETE, OPTIONS];
const MUST_DROP_HEADERS = [ "content-encoding", "transfer-encoding", "host", "connection",
                            "upgrade-insecure-requests", "accept-encoding", "user-agent",
                            "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user" ];

const MULTIPART_FORM_DATA = "multipart/form-data";
const STREAM_CONTENT = 'x-stream-id';
const CONTENT_TYPE = 'content-type';
const CONTENT_LENGTH = 'content-length';
const X_CONTENT_LENGTH = 'x-content-length';
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

export class AsyncHttpClient implements Composable {
    
    name = HTTP_CLIENT_SERVICE;

    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
    }

    async handleEvent(evt: EventEnvelope) {
        if (!(evt.getReplyTo() && evt.getBody() instanceof Object)) {
            throw new AppException(400, "Input is not a HTTP request");
        }
        const traceId = evt.getHeader(MY_TRACE_ID);
        const request = new AsyncHttpRequest(evt.getBody() as object);
        const method = request.getMethod();
        if (!(method && METHODS.includes(method))) {
            throw new AppException(405, "Method not allowed");
        }
        const targetHost = request.getTargetHost();
        if (targetHost == null) {
            throw new AppException(400, "Missing target host. e.g. https://hostname");
        }
        let secure: boolean;
        let targetUrl: URL;
        try {
            targetUrl = new URL(targetHost);
        } catch (e) {
            throw new AppException(400, e.message);
        }
        const protocol = targetUrl.protocol;        
        if ("http:" == protocol) {
            secure = false;
        } else if ("https:" == protocol) {
            secure = true;
        } else {
            throw new AppException(400, "Protocol must be http or https");
        }
        if (!targetUrl.hostname) {
            throw new AppException(400, "Unable to resolve target host as domain or IP address");
        }
        if (targetUrl.pathname && targetUrl.pathname != '/') {
            throw new AppException(400, "Target host must not contain URI path");
        }
        let uri = request.getUrl();
        if (uri.includes('?')) {
            // when there are more than one query separator, drop the middle portion.
            const sep1 = request.getUrl().indexOf('?');
            const sep2 = request.getUrl().lastIndexOf('?');
            uri = cleanEncodeURI(getSafeDisplayUri(request.getUrl().substring(0, sep1)));
            const q = request.getUrl().substring(sep2+1).trim();
            if (q) {
                request.setQueryString(q);
            }
        } else {
            uri = cleanEncodeURI(getSafeDisplayUri(uri));
        }
        // construct target URL
        let qs = request.getQueryString();
        const queryParams = queryParametersToString(request);
        if (queryParams) {
            qs = qs == null? queryParams : qs + "&" + queryParams;
        }
        const uriWithQuery = uri + (qs == null? "" : "?" + qs);
        const consolidatedHeaders = {};
        consolidatedHeaders[USER_AGENT] = 'async-http-client';
        const reqHeaders = request.getHeaders();
        for (const h in request.getSession()) {
            reqHeaders[h] = request.getSessionInfo(h);
        }
        for (const h in reqHeaders) {
            if (allowedHeader(h)) {
                consolidatedHeaders[h] = reqHeaders[h];
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
            cookies = cookies.substring(0, cookies.length-2);
        }
        const fqUrl = (secure? 'https://' : 'http://') + targetUrl.host + uriWithQuery;
        // minimum timeout value is 5 seconds
        const timeout = Math.max(5000, request.getTimeoutSeconds() * 1000);
        if (traceId) {
            consolidatedHeaders[X_TRACE_ID] = traceId;
        }
        // When validateStatus returns true, HTTP-4xx and 5xx responses are processed as regular response.
        // We can then handle different HTTP responses in a consistent fashion.
        // Since we don't know the payload size of the HTTP response, 'stream' is a better option.
        const requestConfig: AxiosRequestConfig = {
            method: method,
            url: fqUrl,
            headers: consolidatedHeaders,
            timeout: timeout,
            responseType: 'stream',
            validateStatus: (status) => status != null
        };
        if (PUT == method || POST == method || PATCH == method) {
            const reqContentType = consolidatedHeaders[CONTENT_TYPE];
            const reqBody = request.getBody();
            const streamId = request.getStreamRoute();
            const filename = request.getFileName();
            if (streamId && streamId.startsWith('stream.') && streamId.endsWith('.in')) {
                // handle input stream
                const upload = new ObjectStreamReader(streamId, timeout);
                const uploadStream = new stream.Readable({
                    read: function(size?: number) {
                        upload.read().then(v => {
                            if (v) {
                                let b: Buffer = null;
                                if (v instanceof Buffer) {
                                    b = v;
                                } else if (typeof v == 'string') {
                                    b = Buffer.from(v);
                                } else {
                                    log.error(`Stream dropped because data in ${streamId} is not Buffer or string`);
                                    this.push(null);
                                }
                                if (size) {
                                    if (b.length > size) {
                                        let start = 0;
                                        let end = size;
                                        while (start <= b.length) {
                                            if (end - start < size) {
                                                this.push(b.subarray(start));
                                                break;
                                            } else {
                                                this.push(b.subarray(start, end));
                                                start = end;
                                                end += size;
                                            }   
                                        }
                                    } else {
                                        this.push(b);
                                    }    
                                } else {
                                    this.push(b);
                                }                                                               
                            } else {
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
                if (reqContentType && reqContentType.startsWith(MULTIPART_FORM_DATA) &&
                        POST == method && filename) {
                    const form = new FormData();
                    form.append('file', uploadStream, filename);
                    requestConfig.data = form;                      
                } else {
                    requestConfig.data = uploadStream;
                }
            } else if (reqBody) {
                let b: Buffer = null;
                if (reqBody instanceof Buffer) {
                    b = reqBody;
                } else if (typeof reqBody == 'string') {
                    b = Buffer.from(reqBody);
                } else if (reqBody instanceof Object) {
                    b = Buffer.from(JSON.stringify(reqBody));
                }
                requestConfig.data = b;
                consolidatedHeaders[CONTENT_LENGTH] = b.length;
            } else {
                consolidatedHeaders[CONTENT_LENGTH] = 0;
            }
        }
        try {
            const httpResponse = await axios(requestConfig);
            const resHeaders = new Map<string, string>();
            for (const h in httpResponse.headers) {
                resHeaders.set(h.toLowerCase(), String(httpResponse.headers[h]));
            }            
            const resContentType = resHeaders.get(CONTENT_TYPE);
            const resContentLen = resHeaders.get(CONTENT_LENGTH);
            const textContent = isTextResponse(resContentType);
            const fixedLenContent = resContentLen || textContent; 
            let len = 0;
            const blocks = Array<Buffer>();
            let objectStream: ObjectStreamIO = null;
            let responseStream: ObjectStreamWriter = null;
            const outputStream = new stream.Writable({
                write: function(chunk, _encoding, next) {
                    if (chunk instanceof Buffer) {
                        len += chunk.length;
                        if (fixedLenContent) {
                            blocks.push(chunk);
                        } else {
                            if (objectStream == null) {
                                objectStream = new ObjectStreamIO(timeout / 1000);
                                responseStream = new ObjectStreamWriter(objectStream.getOutputStreamId());
                            }
                            responseStream.write(chunk);
                        }
                    }
                    next();
                }
            });
            outputStream.on('close', () => {
                const result = new EventEnvelope().setTo(evt.getReplyTo()).setCorrelationId(evt.getCorrelationId());
                result.setStatus(httpResponse.status);
                const headerNames = Array.from(resHeaders.keys());
                for (const h of headerNames) {
                    result.setHeader(h, resHeaders.get(h));
                }
                if (OPTIONS == method || HEAD == method) {
                    result.setHeader(CONTENT_LENGTH, "0");
                    result.setBody('');
                } else if (fixedLenContent) {
                    const b = Buffer.concat(blocks);                    
                    if (resContentType.startsWith(APPLICATION_JSON)) {
                        const text = normalizeTextResponse(httpResponse.status, b.toString(UTF_8)).trim();
                        if ((text.startsWith('{') && text.endsWith('}')) ||
                            (text.startsWith('[') && text.endsWith(']'))) {
                            try {
                                result.setBody(JSON.parse(text));
                            } catch (_ignore) {
                                result.setBody(text);
                            }
                        } else {
                            result.setBody(text);
                        }
                    } else if (textContent) {
                        result.setBody(normalizeTextResponse(httpResponse.status, b.toString(UTF_8)));
                    } else {
                        // binary content
                        result.setBody(b);
                    }
                } else {
                    if (responseStream != null) {
                        result.setHeader(STREAM_CONTENT, objectStream.getInputStreamId());
                        result.setHeader(X_TTL, String(timeout));
                        result.setHeader(X_CONTENT_LENGTH, String(len));
                        responseStream.close();
                    }
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
        } catch (ex) {
            // this happens only when HTTP connection fails
            const error = new EventEnvelope().setTo(evt.getReplyTo()).setCorrelationId(evt.getCorrelationId());
            error.setStatus(500).setBody(normalizeTextResponse(500, ex.message));
            po.send(error);
        }
        return null;    
    }
}

function normalizeTextResponse(status: number, message: string): string {
    if (status < 400) {
        return message;
    } else {
        // convert error code for connection failure into a readable message
        const ex = message.indexOf(ECONNREFUSED);
        return ex == -1? message : 'Connection refused - ' + message.substring(ex + ECONNREFUSED.length).trim();
    }
}

function isTextResponse(contentType: string): boolean {
    return  contentType != null && (
            contentType.startsWith(APPLICATION_JSON) || contentType.startsWith(APPLICATION_XML) ||
            contentType.startsWith(TEXT_PREFIX) || contentType.startsWith(APPLICATION_JAVASCRIPT));
}

function allowedHeader(header: string): boolean {
    const lowerCaseHeader = header.toLowerCase();
    for (const h of MUST_DROP_HEADERS) {
        if (lowerCaseHeader == h) {
            return false;
        }
    }
    return true;
}

function queryParametersToString(request: AsyncHttpRequest): string {
    let sb = '';
    const params = request.getQueryParameters() as object;
    for (const k in params) {
        const v = params[k];
        if (typeof(v) == 'string') {
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
    return sb.length > 0? sb.substring(0, sb.length-1) : sb;
}

function cleanEncodeURI(uri: string): string {
    const result = encodeURI(uri).replaceAll("+", "%20");
    return result.startsWith('/')? result : '/' + result;
}

function getSafeDisplayUri(uri: string): string {
    let path = decodeURI(uri);
    path = dropDangerousSegment(path, "://");
    path = dropDangerousSegment(path, "%");
    path = dropDangerousSegment(path, "<");
    path = dropDangerousSegment(path, ">");
    path = dropDangerousSegment(path, "&");
    path = dropDangerousSegment(path, ";");
    return path;
}

function dropDangerousSegment(uri: string, pattern: string) {
    return uri.includes(pattern)? uri.substring(0, uri.indexOf(pattern)) : uri;
}
