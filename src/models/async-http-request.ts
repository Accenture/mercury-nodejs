const HEADERS = "headers";
const METHOD = "method";
const IP = "ip";
const TIMEOUT = "timeout";
const SESSION = "session";
const PARAMETERS = "parameters";
const HTTP_PROTOCOL = "http://";
const HTTPS_PROTOCOL = "https://";
const HTTPS = "https";
const QUERY = "query";
const PATH = "path";
const COOKIES = "cookies";
const URL_LABEL = "url";
const BODY = "body";
const UPLOAD = "upload";
const STREAM = "stream";
const FILE_NAME = "filename";
const CONTENT_LENGTH = "size";
const TRUST_ALL_CERT = "trust_all_cert";
const TARGET_HOST = "host";

function setLowerCase(source: object): object {
    const result = {};
    for (const key of Object.keys(source)) {
        result[key.toLowerCase()] = source[key];
    }
    return result;
}

export class AsyncHttpRequest {
    private method: string;
    private queryString: string;
    private url: string;
    private ip: string;
    private upload: string;
    private headers = {};
    private queryParams = {};
    private pathParams = {};
    private cookies = {};
    private session = {};
    private body = null;
    private streamRoute: string;
    private filename: string;
    private targetHost: string;
    private trustAllCert = false;
    private https = false;
    private contentLength = -1;
    private timeoutSeconds = -1;

    constructor(map?) {
        if (map && map.constructor == Object) {
            this.fromMap(map as object);
        }
    }

    getMethod(): string {
        return this.method;
    }

    setMethod(method: string): AsyncHttpRequest {
        this.method = method;
        return this;
    }

    getUrl(): string {
        return this.url;
    }

    getRemoteIp(): string {
        return this.ip;
    }

    setRemoteIp(ip: string): AsyncHttpRequest {
        this.ip = ip;
        return this;
    }

    getHeaders(): object {
        return this.headers;
    }

    setHeader(key: string, value: string): AsyncHttpRequest {
        if (key) {
            this.headers[key.toLowerCase()] = value? value : "";
        }
        return this;
    }

    getBody() {
        return this.body;
    }

    setBody(body): AsyncHttpRequest {
        this.body = body? body : null;
        return this;
    }

    getStreamRoute(): string {
        return this.streamRoute;
    }

    setStreamRoute(streamRoute: string): AsyncHttpRequest {
        if (streamRoute) {
            this.streamRoute = streamRoute;
        }
        return this;
    }

    isStream(): boolean {
        return this.streamRoute != null;
    }

    getFileName(): string {
        return this.filename;
    }

    setFileName(filename: string): AsyncHttpRequest {
        if (filename) {
            this.filename = filename;
        }
        return this;
    }

    isFile(): boolean {
        return this.filename != null;
    }

    getTimeoutSeconds(): number {
        return Math.max(0, this.timeoutSeconds? this.timeoutSeconds : -1);
    }

    setTimeoutSeconds(timeoutSeconds: number): AsyncHttpRequest {
        if (timeoutSeconds) {
            this.timeoutSeconds = Math.max(0, timeoutSeconds);
        }
        return this;
    }

    getContentLength(): number {
        return Math.max(0, this.contentLength? this.contentLength : -1);
    }

    setContentLength(contentLength: number): AsyncHttpRequest {
        if (contentLength) {
            this.contentLength = Math.max(0, contentLength);
        }
        return this;
    }

    getSessionInfo(): object {
        return this.session;
    }

    setSessionInfo(key: string, value: string): AsyncHttpRequest {
        if (key) {
            this.session[key.toLowerCase()] = value? value : "";
        }
        return this;
    }

    removeSessionInfo(key: string): AsyncHttpRequest {   
        if (key) {
            delete this.session[key.toLowerCase()];
        }
        return this;
    }

    getCookies(): object {
        return this.cookies;
    }

    setCookie(key: string, value: string): AsyncHttpRequest {
        if (key) {
            this.cookies[key.toLowerCase()] = value? value : "";
        }
        return this;
    }

    removeCookie(key: string): AsyncHttpRequest {   
        if (key) {
            delete this.cookies[key.toLowerCase()];
        }     
        return this;
    }

    getPathParameters(): object {
        return this.pathParams;
    }

    getPathParameter(key: string) {
        return key != null? this.pathParams[key.toLowerCase()] : null;
    }

    setPathParameter(key: string, value: string): AsyncHttpRequest {
        if (key) {
            this.pathParams[key.toLowerCase()] = value? value : "";
        }
        return this;
    }

    removePathParameter(key: string): AsyncHttpRequest {
        if (key) {
            delete this.pathParams[key.toLowerCase()];
        }
        return this;
    }

    getQueryString(): string {
        return this.queryString;
    }

    isSecure(): boolean {
        return this.https? true : false;
    }

    setSecure(https: boolean): AsyncHttpRequest {
        this.https = https? true : false;
        return this;
    }

    getUploadTag(): string {
        return this.upload;
    }

    setUploadTag(tag: string): AsyncHttpRequest {
        if (tag) {
            this.upload = tag;
        }
        return this;
    }

    getTargetHost(): string {
        return this.targetHost;
    }

    setTargetHost(host: string): AsyncHttpRequest {
        if (host != null && (host.startsWith(HTTP_PROTOCOL) || host.startsWith(HTTPS_PROTOCOL))) {
            this.targetHost = host;
            return this;
        } else {
            throw new Error("Invalid host - must starts with "+HTTP_PROTOCOL+" or "+HTTPS_PROTOCOL);
        }
    }

    isTrustAllCert(): boolean {
        return this.trustAllCert? true : false;
    }

    setTrustAllCert(trustAllCert: boolean): AsyncHttpRequest {
        this.trustAllCert = trustAllCert? true : false;
        return this;
    }

    getQueryParameter(key: string): string {
        if (key) {
            const value = this.queryParams[key.toLowerCase()];
            if (value) {
                if (value.constructor == String) {
                    return value as string;
                } else if (value.constructor == Array) {
                    return String(value[0]);
                }
            }
        }
        return null;
    }

    getQueryParameters(key?: string) {
        if (key) {
            const values = this.queryParams[key.toLowerCase()];
            if (values.constructor == String) {
                const result = [];
                result.push(values);
                return result;
            } else if (values.constructor == Array) {
                return values;
            }
        } else {
            return this.queryParams;
        }
        return null;
    }

    setQueryParameter(key: string, value: string): AsyncHttpRequest {
        if (key) {
            if (value) {
                if (value.constructor == String) {
                    this.queryParams[key.toLowerCase()] = value;
                } else if (value.constructor == Array) {
                    const valueArray = value as Array<string>;
                    const params = [];
                    for (const v of valueArray) {
                        params.push(String(v));
                    }
                    this.queryParams[key.toLowerCase()] = params;
                }
            } else {
                this.queryParams[key.toLowerCase()] = '';
            }
        }
        return this;
    }

    toMap(): object {
        const result = {};
        if (this.headers && Object.keys(this.headers).length > 0) {
            result[HEADERS] = setLowerCase(this.headers);
        }
        if (this.cookies && Object.keys(this.cookies).length > 0) {
            result[COOKIES] = setLowerCase(this.cookies);
        }
        if (this.session && Object.keys(this.session).length > 0) {
            result[SESSION] = setLowerCase(this.session);
        }
        if (this.method) {
            result[METHOD] = this.method;
        }
        if (this.ip) {
            result[IP] = this.ip;
        }
        if (this.url) {
            result[URL_LABEL] = this.url;
        }
        if (this.timeoutSeconds != -1) {
            result[TIMEOUT] = this.timeoutSeconds;
        }
        if (this.filename) {
            result[FILE_NAME] = this.filename;
        }
        if (this.contentLength != -1) {
            result[CONTENT_LENGTH] = this.contentLength;
        }
        if (this.streamRoute) {
            result[STREAM] = this.streamRoute;
        }
        if (this.body) {
            result[BODY] = this.body;
        }
        if (this.queryString) {
            result[QUERY] = this.queryString;
        }
        if (this.upload) {
            result[UPLOAD] = this.upload;
        }
        const hasPathParams = Object.keys(this.pathParams).length > 0;
        const hasQueryParams = Object.keys(this.queryParams).length > 0;
        if (hasPathParams || hasQueryParams) {
            const parameters = {};
            result[PARAMETERS] = parameters;
            if (hasPathParams) {
                parameters[PATH] = setLowerCase(this.pathParams);
            }
            if (hasQueryParams) {
                parameters[QUERY] = setLowerCase(this.queryParams);
            }
        }
        result[HTTPS] = this.https;
        /*
         * Optional HTTP host name in the "relay" field
         *
         * This is used by the rest-automation "async.http.request" service
         * when forwarding HTTP request to a target HTTP endpoint.
         */
        if (this.targetHost) {
            result[TARGET_HOST] = this.targetHost;
            result[TRUST_ALL_CERT] = this.trustAllCert;
        }
        return {};
    }

    fromMap(map: object) {
        if (map && map.constructor == Object) {
            if (HEADERS in map) {
                this.headers = setLowerCase(map[HEADERS]);
            }
            if (COOKIES in map) {
                this.cookies = setLowerCase(map[COOKIES]);
            }
            if (SESSION in map) {
                this.session = setLowerCase(map[SESSION]);
            }
            if (METHOD in map) {
                this.method = map[METHOD];
            }
            if (IP in map) {
                this.ip = map[IP];
            }
            if (URL_LABEL in map) {
                this.url = map[URL_LABEL];
            }
            if (TIMEOUT in map) {
                this.timeoutSeconds = map[TIMEOUT];
            }
            if (FILE_NAME in map) {
                this.filename = map[FILE_NAME];
            }
            if (CONTENT_LENGTH in map) {
                this.contentLength = map[CONTENT_LENGTH];
            }
            if (STREAM in map) {
                this.streamRoute = map[STREAM];
            }
            if (BODY in map) {
                this.body = map[BODY];
            }
            if (QUERY in map) {
                this.queryString = map[QUERY];
            }
            if (HTTPS in map) {
                this.https = map[HTTPS];
            }
            if (TARGET_HOST in map) {
                this.targetHost = map[TARGET_HOST];
            }
            if (TRUST_ALL_CERT in map) {
                this.trustAllCert = map[TRUST_ALL_CERT];
            }
            if (UPLOAD in map) {
                this.upload = map[UPLOAD];
            }
            if (PARAMETERS in map) {
                const parameters = map[PARAMETERS];
                if (PATH in parameters) {
                    this.pathParams = setLowerCase(parameters[PATH]);
                }
                if (QUERY in parameters) {
                    this.queryParams = setLowerCase(parameters[QUERY]);
                }
            }
        }
    }
}