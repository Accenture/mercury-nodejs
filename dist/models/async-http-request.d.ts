export declare class AsyncHttpRequest {
    private method;
    private queryString;
    private url;
    private ip;
    private upload;
    private headers;
    private queryParams;
    private pathParams;
    private cookies;
    private session;
    private body;
    private filename;
    private targetHost;
    private trustAllCert;
    private https;
    private contentLength;
    constructor(map?: object);
    /**
     * Retrieve the request's HTTP method name
     * (GET, POST, PUT, HEAD, PATCH, DELETE)
     *
     * @returns HTTP method
     */
    getMethod(): string;
    /**
     * Set the HTTP method if this is an outgoing HTTP request
     *
     * @param method (GET, POST, PUT, HEAD, PATCH, DELETE)
     * @returns this
     */
    setMethod(method: string): AsyncHttpRequest;
    /**
     * Retrieve the URI
     *
     * @returns HTTP URI
     */
    getUrl(): string;
    /**
     * Set the URI if this is an outgoing HTTP request
     *
     * @param url - the URI portion of the url
     * @returns this
     */
    setUrl(url: string): AsyncHttpRequest;
    /**
     * Retrieve the IP address of the caller
     *
     * @returns ip address
     */
    getRemoteIp(): string;
    /**
     * Set the caller's IP address if this is an outgoing HTTP request
     *
     * @param ip address
     * @returns this
     */
    setRemoteIp(ip: string): AsyncHttpRequest;
    /**
     * Retrieve all HTTP headers
     *
     * @returns headers(key-values)
     */
    getHeaders(): object;
    /**
     * Retrieve a header value
     *
     * @param key of a header
     * @returns value of the header
     */
    getHeader(key: string): string;
    /**
     * Set a key-value for a HTTP header
     *
     * @param key of the header
     * @param value of the header
     * @returns this
     */
    setHeader(key: string, value: string): AsyncHttpRequest;
    /**
     * Remove a header key-value
     *
     * @param key for the header
     * @returns this
     */
    removeHeader(key: string): AsyncHttpRequest;
    /**
     * Retrieve the HTTP request body
     *
     * Note that payload applies to PUT and POST only
     *
     * @returns optional payload
     */
    getBody(): string | number | object | boolean | Buffer | Uint8Array;
    /**
     * Set the HTTP request payload if this is an outgoing HTTP request
     *
     * @param body (aka payload)
     * @returns this
     */
    setBody(body: string | number | object | boolean | Buffer | Uint8Array): AsyncHttpRequest;
    /**
     * The system will perform HTML/XML/JSON data format conversion.
     * i.e. HTML would become string, XML and JSON becomes a JSON object.
     *
     * For other binary format, the HTTP request payload will be rendered
     * as a stream input object.
     *
     * @returns optional route name of a streaming object
     */
    getStreamRoute(): string;
    /**
     * If you are sending a HTTP request, you can create a stream to render
     * the HTTP request payload.
     *
     * @param streamRoute of the binary payload
     * @returns
     */
    setStreamRoute(streamRoute: string): AsyncHttpRequest;
    /**
     * Check if this HTTP request contains a streaming object
     *
     * @returns true or false
     */
    isStream(): boolean;
    /**
     * Retrieve the filename of the input stream
     *
     * @returns filename of the input stream if this is a multi-part message
     */
    getFileName(): string;
    /**
     * Set the filename if this is an outgoing HTTP request object
     *
     * @param filename of the streaming object
     * @returns this
     */
    setFileName(filename: string): AsyncHttpRequest;
    /**
     * Check if the input stream is a file object
     *
     * @returns true or false
     */
    isFile(): boolean;
    /**
     * Retreive the request expiry timer in seconds
     *
     * @returns timeout value
     */
    getTimeoutSeconds(): number;
    /**
     * Set request timeout value
     *
     * @param timeoutSeconds for the request expiry timer
     * @returns this
     */
    setTimeoutSeconds(timeoutSeconds: number): AsyncHttpRequest;
    /**
     * Retrieve the content length of a request payload if any
     *
     * @returns content length
     */
    getContentLength(): number;
    /**
     * Since HTTP may use compression algorithm.
     * Normally you do not need to set content length unless you know exactly what you are doing.
     *
     * @param contentLength of the request paylod
     * @returns this
     */
    setContentLength(contentLength: number): AsyncHttpRequest;
    /**
     * Optional session information may be inserted by an externalized API authentication service.
     * e.g. OAuth2.0 authenticator and RBAC validator.
     *
     * Examples for session object are user-ID, user-name and roles.
     *
     * @returns key-values
     */
    getSession(): object;
    /**
     * Retrieve a session parameter
     *
     * @param key of a session parameter
     * @returns value of the session parameter
     */
    getSessionInfo(key: string): string;
    /**
     * When you implement a custom API authentication service. You can use this method
     * to send session or user profile information to the BFF or user function.
     *
     * @param key of the session parameter
     * @param value of the session parameter
     * @returns this
     */
    setSessionInfo(key: string, value: string): AsyncHttpRequest;
    /**
     * Remove a session parameter
     *
     * @param key of the session parameter
     * @returns this
     */
    removeSessionInfo(key: string): AsyncHttpRequest;
    /**
     * Retrieve all cookies if any
     *
     * @returns cookies in key-values
     */
    getCookies(): object;
    /**
     * Retrieve a cookie
     *
     * @param key of a cookie
     * @returns this
     */
    getCookie(key: string): string;
    /**
     * This is used if your service wants to set a browser cookie
     *
     * @param key of a cookie
     * @param value of a cookie
     * @returns this
     */
    setCookie(key: string, value: string): AsyncHttpRequest;
    /**
     * Remove a cookie from this request dataset
     *
     * This does not clear the cookie in the browser. To clear browser cookie, you use the SetCookie method.
     *
     * @param key of the cookie
     * @returns this
     */
    removeCookie(key: string): AsyncHttpRequest;
    /**
     * Retrieve all path parameters
     *
     * @returns key-values
     */
    getPathParameters(): object;
    /**
     * Retrieve a path parameter from the URI
     *
     * @param key of a path parameter
     * @returns value
     */
    getPathParameter(key: string): any;
    /**
     * Set a path parameter if this is an outgoing HTTP request
     *
     * @param key of a path parameter
     * @param value of a path parameter
     * @returns this
     */
    setPathParameter(key: string, value: string): AsyncHttpRequest;
    /**
     * Remove a path parameter from the HTTP request dataset
     *
     * @param key of a path parameter
     * @returns this
     */
    removePathParameter(key: string): AsyncHttpRequest;
    /**
     * Retrieve the query string from the URI
     *
     * @returns the complete query string
     */
    getQueryString(): string;
    setQueryString(query: string): AsyncHttpRequest;
    /**
     * Check if the HTTP request uses HTTPS
     *
     * @returns true or false
     */
    isSecure(): boolean;
    /**
     * Use HTTPS if this is an outgoing HTTP request
     *
     * @param https true or false
     * @returns this
     */
    setSecure(https: boolean): AsyncHttpRequest;
    /**
     * Retrieve the upload tag name in a multi-part file upload request
     *
     * @returns upload tag name
     */
    getUploadTag(): string;
    /**
     * Set the upload tag name if this is an outgoing HTTP request with multi-part file upload
     *
     * @param tag name
     * @returns this
     */
    setUploadTag(tag: string): AsyncHttpRequest;
    /**
     * Retrieve the target host name if this is an outgoing HTTP request
     *
     * @returns target host name
     */
    getTargetHost(): string;
    /**
     * Set the target host name if this is an outgoing HTTP request
     *
     * @param host name
     * @returns this
     */
    setTargetHost(host: string): AsyncHttpRequest;
    /**
     * Check if this HTTP request skips certificate verification
     *
     * @returns true or false
     */
    isTrustAllCert(): boolean;
    /**
     * Decide if this outgoing HTTP request skips certification verification
     *
     * (DO NOT disable certification verification unless this is a trusted zone with self-signed cert)
     *
     * @param trustAllCert true or false
     * @returns this
     */
    setTrustAllCert(trustAllCert: boolean): AsyncHttpRequest;
    /**
     * Retrieve a query parameter
     *
     * @param key of a query parameter
     * @returns value
     */
    getQueryParameter(key: string): string;
    /**
     * Retrieve a multi-value query parameter.
     * If key is not given, it will return all query key-values.
     *
     * @param key of a multi-value parameter
     * @returns a list of strings
     */
    getQueryParameters(key?: string): {};
    /**
     * Set the value of a query parameter
     *
     * @param key of a query parameter
     * @param value of a query parameter
     * @returns this
     */
    setQueryParameter(key: string, value: string): AsyncHttpRequest;
    /**
     * Remove a query parameter
     *
     * @param key of the query parameter
     * @returns this
     */
    removeQueryParameter(key: string): AsyncHttpRequest;
    /**
     * Convert this HTTP request object to a JSON object
     *
     * @returns a JSON object
     */
    toMap(): object;
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
    fromMap(map: object): void;
}
