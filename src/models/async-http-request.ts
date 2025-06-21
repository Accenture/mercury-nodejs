import { Utility } from '../util/utility.js';
const util = new Utility();
const HEADERS = "headers";
const METHOD = "method";
const IP = "ip";
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
const FILE_NAME = "filename";
const CONTENT_LENGTH = "size";
const TRUST_ALL_CERT = "trust_all_cert";
const TARGET_HOST = "host";

type eventPayload = string | number | object | boolean | Buffer | Uint8Array;

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
    private filename: string;
    private targetHost: string;
    private trustAllCert = false;
    private https = false;
    private contentLength = -1;

    constructor(map?: object) {
        if (map && map instanceof Object && map.constructor == Object) {
            this.fromMap(map);
        }
    }

    /**
     * Retrieve the request's HTTP method name
     * (GET, POST, PUT, HEAD, PATCH, DELETE)
     * 
     * @returns HTTP method
     */
    getMethod(): string {
        return this.method? this.method : null;
    }

    /**
     * Set the HTTP method if this is an outgoing HTTP request
     * 
     * @param method (GET, POST, PUT, HEAD, PATCH, DELETE)
     * @returns this
     */
    setMethod(method: string): this {
        if (method) {
            this.method = method.toUpperCase();
        }
        return this;
    }

    /**
     * Retrieve the URI
     * 
     * @returns HTTP URI
     */
    getUrl(): string {
        return this.url? this.url : '/';
    }

    /**
     * Set the URI if this is an outgoing HTTP request
     * 
     * @param url - the URI portion of the url
     * @returns this
     */
    setUrl(url: string): this {
        this.url = url;
        return this;
    }

    /**
     * Retrieve the IP address of the caller
     * 
     * @returns ip address
     */
    getRemoteIp(): string {
        return this.ip;
    }

    /**
     * Set the caller's IP address if this is an outgoing HTTP request
     * 
     * @param ip address
     * @returns this
     */
    setRemoteIp(ip: string): this {
        this.ip = ip;
        return this;
    }

    /**
     * Retrieve all HTTP headers
     * 
     * @returns headers(key-values)
     */
    getHeaders(): object {
        return this.headers;
    }

    /**
     * Retrieve a header value
     * 
     * @param key of a header
     * @returns value of the header
     */
    getHeader(key: string): string {
        const lk = key.toLowerCase();
        for (const k of Object.keys(this.headers)) {
            if (lk == k.toLowerCase()) {
                return this.headers[k];
            }
        }
        return null;
    }

    /**
     * Set a key-value for a HTTP header
     * 
     * @param key of the header
     * @param value of the header
     * @returns this
     */
    setHeader(key: string, value: string): this {
        if (key) {
            this.removeHeader(key);
            this.headers[key] = value || "";
        }
        return this;
    }

    /**
     * Remove a header key-value
     * 
     * @param key for the header
     * @returns this
     */
    removeHeader(key: string): this {
        const lk = key.toLowerCase();
        let actualKey = null;
        for (const k of Object.keys(this.headers)) {
            if (lk == k.toLowerCase()) {
                actualKey = k;
                break;
            }
        }
        if (actualKey) {
            delete this.headers[actualKey];
        }
        return this;
    }

    /**
     * Retrieve the HTTP request body
     * 
     * Note that payload applies to PUT and POST only
     * 
     * @returns optional payload
     */
    getBody(): eventPayload {
        return this.body;
    }

    /**
     * Set the HTTP request payload if this is an outgoing HTTP request
     * 
     * @param body (aka payload)
     * @returns this
     */
    setBody(body: eventPayload): this {
        this.body = body || null;
        return this;
    }

    /**
     * The system will perform HTML/XML/JSON data format conversion.
     * i.e. HTML would become string, XML and JSON becomes a JSON object.
     * 
     * For other binary format, the HTTP request payload will be rendered
     * as a stream input object.
     * 
     * @returns optional route name of a streaming object
     */
    getStreamRoute(): string {
        return this.getHeader("x-stream-id");
    }

    /**
     * If you are sending a HTTP request, you can create a stream to render
     * the HTTP request payload.
     * 
     * @param streamRoute of the binary payload
     * @returns 
     */
    setStreamRoute(streamRoute: string): this {
        if (streamRoute) {
            this.setHeader("x-stream-id", streamRoute);
        }
        return this;
    }

    /**
     * Check if this HTTP request contains a streaming object
     * 
     * @returns true or false
     */
    isStream(): boolean {
        return this.getStreamRoute() != null;
    }

    /**
     * Retrieve the filename of the input stream
     * 
     * @returns filename of the input stream if this is a multi-part message
     */
    getFileName(): string {
        return this.filename;
    }

    /**
     * Set the filename if this is an outgoing HTTP request object
     * 
     * @param filename of the streaming object
     * @returns this
     */
    setFileName(filename: string): this {
        if (filename) {
            this.filename = filename;
        }
        return this;
    }

    /**
     * Check if the input stream is a file object
     * 
     * @returns true or false
     */
    isFile(): boolean {
        return this.filename != null;
    }

    /**
     * Retreive the request expiry timer in seconds
     * 
     * @returns timeout value
     */
    getTimeoutSeconds(): number {
        const v = this.getHeader("x-ttl");
        const timeout = v? util.str2int(v) : 1;
        return Math.max(1, timeout);
    }

    /**
     * Set request timeout value
     * 
     * @param timeoutSeconds for the request expiry timer
     * @returns this
     */
    setTimeoutSeconds(timeoutSeconds: number): this {
        if (timeoutSeconds) {
            const v = util.str2int(String(timeoutSeconds));
            this.setHeader("x-ttl", String(Math.max(1, v)));
        }
        return this;
    }

    /**
     * Retrieve the content length of a request payload if any
     * 
     * @returns content length
     */
    getContentLength(): number {
        return Math.max(0, this.contentLength? this.contentLength : -1);
    }

    /**
     * Since HTTP may use compression algorithm. 
     * Normally you do not need to set content length unless you know exactly what you are doing.
     * 
     * @param contentLength of the request paylod
     * @returns this
     */
    setContentLength(contentLength: number): this {
        if (contentLength) {
            this.contentLength = Math.max(0, contentLength);
        }
        return this;
    }

    /**
     * Optional session information may be inserted by an externalized API authentication service.
     * e.g. OAuth2.0 authenticator and RBAC validator.
     * 
     * Examples for session object are user-ID, user-name and roles.
     * 
     * @returns key-values
     */
    getSession(): object {
        return this.session;
    }

    /**
     * Retrieve a session parameter
     * 
     * @param key of a session parameter
     * @returns value of the session parameter
     */
    getSessionInfo(key: string): string {
        const lk = key.toLowerCase();
        for (const k of Object.keys(this.session)) {
            if (lk == k.toLowerCase()) {
                return this.session[k];
            }
        }
        return null;
    }

    /**
     * When you implement a custom API authentication service. You can use this method
     * to send session or user profile information to the BFF or user function.
     * 
     * @param key of the session parameter
     * @param value of the session parameter
     * @returns this
     */
    setSessionInfo(key: string, value: string): this {
        if (key) {
            this.removeSessionInfo(key);
            this.session[key] = value || "";
        }
        return this;
    }

    /**
     * Remove a session parameter
     * 
     * @param key of the session parameter
     * @returns this
     */
    removeSessionInfo(key: string): this {   
        if (key) {
            const lk = key.toLowerCase();
            let actualKey = null;
            for (const k of Object.keys(this.session)) {
                if (lk == k.toLowerCase()) {
                    actualKey = k;
                    break;
                }
            }
            if (actualKey) {
                delete this.session[actualKey];
            }
        }
        return this;
    }

    /**
     * Retrieve all cookies if any
     * 
     * @returns cookies in key-values
     */
    getCookies(): object {
        return this.cookies;
    }

    /**
     * Retrieve a cookie
     * 
     * @param key of a cookie
     * @returns this
     */
    getCookie(key: string): string {
        const lk = key.toLowerCase();
        for (const k of Object.keys(this.cookies)) {
            if (lk == k.toLowerCase()) {
                return this.cookies[k];
            }
        }
        return null;
    }

    /**
     * This is used if your service wants to set a browser cookie
     * 
     * @param key of a cookie
     * @param value of a cookie
     * @returns this
     */
    setCookie(key: string, value: string): this {
        if (key) {
            this.removeCookie(key);
            this.cookies[key] = value || "";
        }
        return this;
    }

    /**
     * Remove a cookie from this request dataset
     * 
     * This does not clear the cookie in the browser. To clear browser cookie, you use the SetCookie method.
     * 
     * @param key of the cookie
     * @returns this
     */
    removeCookie(key: string): this {   
        if (key) {
            const lk = key.toLowerCase();
            let actualKey = null;
            for (const k of Object.keys(this.cookies)) {
                if (lk == k.toLowerCase()) {
                    actualKey = k;
                    break;
                }
            }
            if (actualKey) {
                delete this.cookies[actualKey];
            }
        }     
        return this;
    }

    /**
     * Retrieve all path parameters
     * 
     * @returns key-values
     */
    getPathParameters(): object {
        return this.pathParams;
    }

    /**
     * Retrieve a path parameter from the URI
     * 
     * @param key of a path parameter
     * @returns value
     */
    getPathParameter(key: string) {
        const lk = key.toLowerCase();
        for (const k of Object.keys(this.pathParams)) {
            if (lk == k.toLowerCase()) {
                return this.pathParams[k];
            }
        }
        return null;
    }

    /**
     * Set a path parameter if this is an outgoing HTTP request
     * 
     * @param key of a path parameter
     * @param value of a path parameter
     * @returns this
     */
    setPathParameter(key: string, value: string): this {
        if (key) {
            this.removePathParameter(key);
            this.pathParams[key] = value || "";
        }
        return this;
    }

    /**
     * Remove a path parameter from the HTTP request dataset
     * 
     * @param key of a path parameter
     * @returns this
     */
    removePathParameter(key: string): this {
        if (key) {
            const lk = key.toLowerCase();
            let actualKey = null;
            for (const k of Object.keys(this.pathParams)) {
                if (lk == k.toLowerCase()) {
                    actualKey = k;
                    break;
                }
            }
            if (actualKey) {
                delete this.pathParams[actualKey];
            }
        } 
        return this;
    }

    /**
     * Retrieve the query string from the URI
     * 
     * @returns the complete query string
     */
    getQueryString(): string {
        return this.queryString;
    }

    setQueryString(query: string): this {
        this.queryString = query;
        return this;
    }

    /**
     * Check if the HTTP request uses HTTPS
     * 
     * @returns true or false
     */
    isSecure(): boolean {
        return !!this.https;
    }

    /**
     * Use HTTPS if this is an outgoing HTTP request
     * 
     * @param https true or false
     * @returns this
     */
    setSecure(https: boolean): this {
        this.https = !!https;
        return this;
    }

    /**
     * Retrieve the upload tag name in a multi-part file upload request
     * 
     * @returns upload tag name
     */
    getUploadTag(): string {
        return this.upload;
    }

    /**
     * Set the upload tag name if this is an outgoing HTTP request with multi-part file upload
     * 
     * @param tag name
     * @returns this
     */
    setUploadTag(tag: string): this {
        if (tag) {
            this.upload = tag;
        }
        return this;
    }

    /**
     * Retrieve the target host name if this is an outgoing HTTP request
     * 
     * @returns target host name
     */
    getTargetHost(): string {
        return this.targetHost? this.targetHost : null;
    }

    /**
     * Set the target host name if this is an outgoing HTTP request
     * 
     * @param host name
     * @returns this
     */
    setTargetHost(host: string): this {
        if (host && (host.startsWith(HTTP_PROTOCOL) || host.startsWith(HTTPS_PROTOCOL))) {
            this.targetHost = host;
            return this;
        } else {
            throw new Error("Invalid host - must starts with "+HTTP_PROTOCOL+" or "+HTTPS_PROTOCOL);
        }
    }

    /**
     * Check if this HTTP request skips certificate verification
     * 
     * @returns true or false
     */
    isTrustAllCert(): boolean {
        return !!this.trustAllCert;
    }

    /**
     * Decide if this outgoing HTTP request skips certification verification
     * 
     * (DO NOT disable certification verification unless this is a trusted zone with self-signed cert)
     * 
     * @param trustAllCert true or false
     * @returns this
     */
    setTrustAllCert(trustAllCert: boolean): this {
        this.trustAllCert = !!trustAllCert;
        return this;
    }

    /**
     * Retrieve a query parameter
     * 
     * @param key of a query parameter
     * @returns value
     */
    getQueryParameter(key: string): string {
        if (key) {
            const lk = key.toLowerCase();
            let value = null;
            for (const k of Object.keys(this.queryParams)) {
                if (lk == k.toLowerCase()) {
                    value = this.queryParams[k];
                    break;
                }
            }
            if (typeof value == 'string') {
                return value;
            } else if (Array.isArray(value)) {
                return String(value[0]);
            }
        }
        return null;
    }

    /**
     * Retrieve a multi-value query parameter.
     * If key is not given, it will return all query key-values.
     * 
     * @param key of a multi-value parameter
     * @returns a list of strings
     */
    getQueryParameters(key?: string) {
        if (key) {
            const lk = key.toLowerCase();
            let values = null;
            for (const k of Object.keys(this.queryParams)) {
                if (lk == k.toLowerCase()) {
                    values = this.queryParams[k];
                    break;
                }
            }
            if (typeof values == 'string') {
                const result = [];
                result.push(values);
                return result;
            } else if (Array.isArray(values)) {
                return values;
            }
        } else {
            return this.queryParams;
        }
        return null;
    }

    /**
     * Set the value of a query parameter
     * 
     * @param key of a query parameter
     * @param value of a query parameter
     * @returns this
     */
    setQueryParameter(key: string, value: string | Array<string>): this {
        if (key) {
            this.removeQueryParameter(key);
            if (value) {
                if (typeof value == 'string') {
                    this.queryParams[key] = value;
                } else if (Array.isArray(value)) {
                    const params = [];
                    for (const v of value) {
                        params.push(String(v));
                    }
                    this.queryParams[key] = params;
                }
            } else {
                this.queryParams[key] = '';
            }
        }
        return this;
    }

    /**
     * Remove a query parameter
     * 
     * @param key of the query parameter
     * @returns this
     */
    removeQueryParameter(key: string): this {
        if (key) {
            const lk = key.toLowerCase();
            let actualKey = null;
            for (const k of Object.keys(this.queryParams)) {
                if (lk == k.toLowerCase()) {
                    actualKey = k;
                    break;
                }
            }
            if (actualKey) {
                delete this.queryParams[actualKey];
            }
        }
        return this;
    }

    /**
     * Convert this HTTP request object to a JSON object
     * 
     * @returns a JSON object
     */
    toMap(): object {
        const result = {};
        if (this.headers && Object.keys(this.headers).length > 0) {
            result[HEADERS] = this.headers;
        }
        if (this.cookies && Object.keys(this.cookies).length > 0) {
            result[COOKIES] = this.cookies;
        }
        if (this.session && Object.keys(this.session).length > 0) {
            result[SESSION] = this.session;
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
        if (this.filename) {
            result[FILE_NAME] = this.filename;
        }
        if (this.contentLength != -1) {
            result[CONTENT_LENGTH] = this.contentLength;
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
        this.toMoreMap(result);
        return result;
    }

    private toMoreMap(result: object) {
        const hasPathParams = Object.keys(this.pathParams).length > 0;
        const hasQueryParams = Object.keys(this.queryParams).length > 0;
        if (hasPathParams || hasQueryParams) {
            const parameters = {};
            result[PARAMETERS] = parameters;
            if (hasPathParams) {
                parameters[PATH] = this.pathParams;
            }
            if (hasQueryParams) {
                parameters[QUERY] = this.queryParams;
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
    }

    /**
     * Convert a JSON object into a HTTP request object
     * 
     * Normally you should use the constructor to do this conversion.
     * 
     * Assuming the function is a BFF service that listens to HTTP request event from the REST automation,
     * you can do this:
     * 
     * const request = new AsyncHttpRequest(event.getBody());
     * 
     * @param map input JSON object
     */
    fromMap(map: object) {
        if (map && map.constructor == Object) {
            if (HEADERS in map) {
                this.headers = map[HEADERS] as object;
            }
            if (COOKIES in map) {
                this.cookies = map[COOKIES] as object;
            }
            if (SESSION in map) {
                this.session = map[SESSION] as object;
            }
            if (typeof map[METHOD] == 'string') {
                this.method = map[METHOD];
            }
            if (typeof map[IP] == 'string') {
                this.ip = map[IP];
            }
            this.fromMoreMap(map);
        }
    }

    private fromMoreMap(map: object) {
        if (typeof map[URL_LABEL] == 'string') {
            this.url = map[URL_LABEL];
        }
        if (typeof map[FILE_NAME] == 'string') {
            this.filename = map[FILE_NAME];
        }
        if (typeof map[CONTENT_LENGTH] == 'number') {
            this.contentLength = parseInt(String(map[CONTENT_LENGTH]));
        }
        if (BODY in map) {
            this.body = map[BODY];
        }
        if (typeof map[QUERY] == 'string') {
            this.queryString = map[QUERY];
        }
        if (typeof map[HTTPS] == 'boolean' || typeof map[HTTPS] == 'string') {
            this.https = String(map[HTTPS]) == 'true';
        }
        if (typeof map[TARGET_HOST] == 'string') {
            this.targetHost = map[TARGET_HOST];
        }
        if (typeof map[TRUST_ALL_CERT] == 'boolean' || typeof map[TRUST_ALL_CERT] == 'string') {
            this.trustAllCert = String(map[TRUST_ALL_CERT]) == 'true';
        }
        if (typeof map[UPLOAD] == 'string') {
            this.upload = map[UPLOAD];
        }
        if (PARAMETERS in map) {
            const parameters = map[PARAMETERS] as object;
            if (PATH in parameters) {
                this.pathParams = parameters[PATH] as object;
            }
            if (QUERY in parameters) {
                this.queryParams = parameters[QUERY] as object;
            }
        }
    }
}
