import { Logger } from './logger.js';
import { Utility } from './utility.js';
import { ConfigReader } from './config-reader.js';
import { MultiLevelMap } from './multi-level-map.js';

const log = Logger.getInstance();
const util = new Utility();

const ID = "id";
const HEADERS = 'headers';
const OPTIONS = "options";
const REQUEST = "request";
const RESPONSE = "response";
const ADD = "add";
const DROP = "drop";
const KEEP = "keep";
const CORS = "cors";
const ACCESS_CONTROL_PREFIX = "Access-Control-";
const ACCESS_CONTROL_ORIGIN = "access-control-allow-origin";
const REST = "rest";
const SERVICE = "service";
const METHODS = "methods";
const URL_LABEL = "url";
const FLOW = "flow";
const HTTP = "http://";
const HTTPS = "https://";
const UPLOAD = "upload";
const AUTHENTICATION = "authentication";
const TRACING = "tracing";
const TIMEOUT = "timeout";
const URL_REWRITE = "url_rewrite";
const TRUST_ALL_CERT = "trust_all_cert";
const ASYNC_HTTP_REQUEST = "async.http.request";
const VALID_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'HEAD', 'PATCH', 'OPTIONS'];
const OPTIONS_METHOD = 'OPTIONS';

let self: RestEntry;

/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class RoutingEntry {

    constructor() {
        if (self === undefined) {
            self = RestEntry.getInstance();
        }
    }

    load(config: ConfigReader): void {
        self.load(config);
    }

    getRouteInfo(method: string, url: string): AssignedRoute {
        return self.getRouteInfo(method, url);
    }

    getRequestHeaderInfo(id: string): HeaderInfo {
        const result = self.getRequestHeaderInfo(id);
        return result? result : null;
    }

    getResponseHeaderInfo(id: string): HeaderInfo {
        const result = self.getResponseHeaderInfo(id);
        return result? result : null;
    }

    getCorsInfo(id: string): CorsInfo {
        const result = self.getCorsInfo(id);
        return result? result : null;
    }

}

export class AssignedRoute {
    arguments = new Map<string, string>();
    info: RouteInfo;

    constructor(info: RouteInfo) {
        this.info = info;
    }

    setArgument(key: string, value: string): void {
        this.arguments.set(key.toLowerCase(), value);
    }
}

export class RouteInfo {
    authHeaders = new Array<string>();
    authServices = new Map<string, string>();
    url: string = null;
    defaultAuthService: string = null;
    corsId: string = null;
    flowId: string = null;
    requestTransformId: string = null;
    responseTransformId: string = null;
    primary: string = null;
    services = new Array<string>();
    tracing = false;
    methods = new Array<string>();
    timeoutSeconds = 30;
    upload = false;
    host: string = null;
    trustAllCert = false;
    urlRewrite = new Array<string>();
    
    getAuthService(headerKey: string, headerValue = '*'): string {
        const result = this.authServices.get(headerKey.toLowerCase()+':'+headerValue);
        return result? result : null;
    }

    setAuthService(headerKey: string, headerValue: string, service: string): void {
        if (headerKey && headerValue) {
            const lh = headerKey.toLowerCase();
            if (!this.authHeaders.includes(lh)) {
                this.authHeaders.push(lh);
            }
            this.authServices.set(lh + ":" + headerValue.toLowerCase(), service);
        }
    }
}

export class CorsInfo {
    options = new Map<string, string>();
    headers = new Map<string, string>();

    getOrigin(isOption: boolean): string {
        return isOption? this.options.get(ACCESS_CONTROL_ORIGIN) : this.headers.get(ACCESS_CONTROL_ORIGIN);
    }

    addOption(element: string): void {
        const colon = element.indexOf(':');
        const key = element.substring(0, colon).trim().toLowerCase();
        const value = element.substring(colon+1).trim();
        this.options.set(key, value);
    }

    addHeader(element: string): void {
        const colon = element.indexOf(':');
        const key = element.substring(0, colon).trim().toLowerCase();
        const value = element.substring(colon+1).trim();
        this.headers.set(key, value);
    }
}

export class HeaderInfo {
    additionalHeaders = new Map<string, string>();
    keepHeaders = new Array<string>();
    dropHeaders = new Array<string>();
}

class RestEntry {
    private static instance: RestEntry;

    private requestHeaderInfo = new Map<string, HeaderInfo>();
    private responseHeaderInfo = new Map<string, HeaderInfo>();
    private corsConfig = new Map<string, CorsInfo>();
    private exactRoutes = new Map<string, boolean>();
    private routes = new Map<string, RouteInfo>();
    private urlPaths = new Array<string>();

    private constructor() {}

    static getInstance() {
        if (RestEntry.instance === undefined) {
            RestEntry.instance = new RestEntry();
        }
        return RestEntry.instance;
    }

    getRequestHeaderInfo(id: string): HeaderInfo {
        return this.requestHeaderInfo.get(id);
    }

    getResponseHeaderInfo(id: string): HeaderInfo {
        return this.responseHeaderInfo.get(id);
    }

    getCorsInfo(id: string): CorsInfo {
        return this.corsConfig.get(id);
    }

    load(config: ConfigReader): void {
        if (config.exists(HEADERS)) {
            const headers = config.get(HEADERS);
            if (Array.isArray(headers)) {
                this.loadHeaderTransform(config, headers.length);
            } else {
                log.error("'headers' section must be a list of request and response entries");
            }
        }
        if (config.exists(CORS)) {
            const cors = config.get(CORS);
            if (Array.isArray(cors)) {
                this.loadCors(config, cors.length);
            } else {
                log.error("'cors' section must be a list of Access-Control entries (id, options and headers)");
            }
        }
        if (config.exists(REST)) {
            const rest = config.get(REST);
            if (Array.isArray(rest)) {
                this.loadRest(config, rest.length);
                const exact = Array.from(this.exactRoutes.keys());
                if (exact.length > 0) {
                    log.info({'type': 'url', 'match': 'exact', 'total': exact.length, 'path': exact.sort()});
                }
                // sort URL for easy parsing
                if (this.routes.size > 0) {
                    const routeList = Array.from(this.routes.keys());
                    routeList.forEach(r => {
                        const colon = r.indexOf(':');
                        if (colon > 0) {
                            const urlOnly = r.substring(colon+1);
                            if (!this.exactRoutes.has(urlOnly) && !this.urlPaths.includes(urlOnly)) {
                                this.urlPaths.push(urlOnly);
                            }
                        }
                    });
                }
                if (this.urlPaths.length > 0) {
                    log.info({'type': 'url', 'match': 'parameters', 'total': this.urlPaths.length, 'path': this.urlPaths.sort()});
                } 
            } else {
                log.error("'rest' section must be a list of endpoint entries (url, service, methods, timeout...)");
            }           
        }
    } 

    loadHeaderTransform(config: ConfigReader, total: number): void {
        for (let i=0; i < total; i++) {            
            const id = config.getProperty(HEADERS+"["+i+"]."+ID);
            if (id != null) {
                this.loadHeaderEntry(config, i, true);
                this.loadHeaderEntry(config, i, false);
            } else {
                log.error(`Skipping invalid header definition - Missing ${HEADERS}[${i}]`);
            }
        }
    } 

    loadHeaderEntry(config: ConfigReader, idx: number, isRequest: boolean): void {
        const id = config.getProperty(HEADERS+"["+idx+"]."+ID);
        const type = isRequest? REQUEST : RESPONSE;
        let addCount = 0;
        let dropCount = 0;
        let keepCount = 0;
        const info = new HeaderInfo();
        const addList = config.get(HEADERS+"["+idx+"]."+type+"."+ADD);
        if (Array.isArray(addList)) {
            for (let j=0; j < addList.length; j++) {
                let valid = false;
                const kv = config.getProperty(HEADERS+"["+idx+"]."+type+"."+ADD+"["+j+"]", "null");
                const colon = kv.indexOf(':');
                if (colon > 0) {
                    const k = kv.substring(0, colon).trim().toLowerCase();
                    const v = kv.substring(colon+1).trim();
                    if (k && v) {
                        info.additionalHeaders.set(k, v);
                        addCount++;
                        valid = true;
                    }                    
                } 
                if (!valid) {
                    log.warn(`Skipping invalid header ${id} ${HEADERS}[${idx}].${type}.${ADD}`);
                }
            }
        }
        const dropList = config.get(HEADERS+"["+idx+"]."+type+"."+DROP);
        if (Array.isArray(dropList)) {
            for (let j=0; j < dropList.length; j++) {
                const key = config.getProperty(HEADERS+"["+idx+"]."+type+"."+DROP+"["+j+"]");
                if (key) {
                    info.dropHeaders.push(key);
                    dropCount++;
                }
            }
        }
        const keepList = config.get(HEADERS+"["+idx+"]."+type+"."+KEEP);
        if (Array.isArray(keepList)) {
            for (let j=0; j < keepList.length; j++) {
                const key = config.getProperty(HEADERS+"["+idx+"]."+type+"."+KEEP+"["+j+"]");
                if (key) {
                    info.keepHeaders.push(key);
                    keepCount++;
                }
            }
        }
        if (isRequest) {
            this.requestHeaderInfo.set(id, info);
        } else {
            this.responseHeaderInfo.set(id, info);
        }
        log.info(`Loaded ${id}, ${type} headers, add=${addCount}, drop=${dropCount}, keep=${keepCount}`);
    }

    loadCors(config: ConfigReader, total: number): void {
        for (let i=0; i < total; i++) {
            const id = config.getProperty(CORS+"["+i+"]."+ID);
            const options = config.get(CORS+"["+i+"]."+OPTIONS);
            const headers = config.get(CORS+"["+i+"]."+HEADERS);
            if (id && Array.isArray(options) && Array.isArray(headers)) {
                if (this.validCorsList(options) && this.validCorsList(headers)) {
                    const info = new CorsInfo();
                    for (let j=0; j < options.length; j++) {
                        info.addOption(config.getProperty(CORS + "[" + i + "]." + OPTIONS + "[" + j + "]"));
                    }
                    for (let j=0; j < headers.length; j++) {
                        info.addHeader(config.getProperty(CORS + "[" + i + "]." + HEADERS + "[" + j + "]"));
                    }
                    this.corsConfig.set(id, info);
                    log.info(`Loaded ${id} cors headers (${info.getOrigin(false)})`);

                } else {
                    log.error(`Skipping invalid cors entry id=${id}, options=${options}, headers=${headers}`);
                }

            } else {
                log.error(`Skipping invalid cors definition ${config.get(CORS+"["+i+"]")}`);
            }
        }

    }

    validCorsList(list: Array<string>): boolean {
        for (let i=0; i < list.length; i++) {
            const entry = list[i];
            if (typeof entry == 'string') {
                if (!this.validCorsElement(entry)) {
                    return false;
                }
            } else {
                log.error(`cors header must be a list of strings, actual: ${list}`);
                return false;
            }
        }
        return true;
    }

    validCorsElement(element: string): boolean {
        if (!element.startsWith(ACCESS_CONTROL_PREFIX)) {
            log.error(`cors header must start with ${ACCESS_CONTROL_PREFIX}, actual: ${element}`);
            return false;
        }
        const colon = element.indexOf(':');
        if (colon == -1) {
            log.error(`cors header must contain key-value separated by a colon, actual: ${element}`);
            return false;
        }
        const value = element.substring(colon+1).trim();
        if (value) {
            return true;
        } else {
            log.error(`Missing value in cors header ${element.substring(0, colon)}`);
            return false;
        }
    }

    loadRest(config: ConfigReader, total: number): void {
        // perform custom sort in ascending order of URL, methods and services
        const keys = [];
        for (let i=0; i < total; i++) {
            const services = config.get(REST+"["+i+"]."+SERVICE);
            const methods = config.get(REST+"["+i+"]."+METHODS);
            const url = config.getProperty(REST+"["+i+"]."+URL_LABEL);
            if (url && Array.isArray(methods) && (typeof services == 'string' || Array.isArray(services))) {
                keys.push(`${url}|${JSON.stringify(methods)}|${JSON.stringify(services)}|${i}`);
            } else {                
                log.error(`Skip invalid REST entry ${config.get(REST+"["+i+"]")}`);
            }
        }
        keys.sort();
        // generate the sorted REST entries
        const mm = new MultiLevelMap();
        let n = 0;
        for (const k of keys) {     
            const idx = util.str2int(k.substring(k.lastIndexOf('|') + 1));
            mm.setElement(REST+"["+n+"]", config.get(REST+"["+idx+"]"));
            n++;
        }
        const sortedConfig = new ConfigReader(mm.getMap());
        for (let i=0; i < total; i++) {
            const services = sortedConfig.get(REST+"["+i+"]."+SERVICE);
            const methods = sortedConfig.get(REST+"["+i+"]."+METHODS);
            const url = sortedConfig.getProperty(REST+"["+i+"]."+URL_LABEL);
            if (url && Array.isArray(methods) && (typeof services == 'string' || Array.isArray(services))) {
                this.loadRestEntry(sortedConfig, i, !url.includes("{") && !url.includes("}") && !url.includes("*"));
            }
        }
    }

    loadRestEntry(config: ConfigReader, idx: number, exact: boolean): void {
        const info = new RouteInfo();
        const services = config.get(REST+"["+idx+"]."+SERVICE);
        const methods = config.get(REST+"["+idx+"]."+METHODS) as Array<string>;
        let url = config.getProperty(REST+"["+idx+"]."+URL_LABEL).toLowerCase();
        try {
            info.services = this.validateServiceList(services);
        } catch (e) {
            log.error(`Skipping entry ${config.get(REST+"["+idx+"]")} - ${e.message}`);
            return;
        }
        info.primary = info.services[0];
        const flowId = config.getProperty(REST+"["+idx+"]."+FLOW);
        if (flowId) {
            info.flowId = flowId;
        }
        const upload = config.getProperty(REST+"["+idx+"]."+UPLOAD);
        if (upload) {
            info.upload = upload.toLowerCase() == 'true';
        }
        const authConfig = config.get(REST+"["+idx+"]."+AUTHENTICATION);
        // authentication: "v1.api.auth"
        if (typeof authConfig == 'string') {
            if (util.validRouteName(authConfig)) {
                info.defaultAuthService = authConfig;
            } else {
                log.error(`Skipping entry with invalid authentication service name ${config.get(REST+"["+idx+"]")}`);
                return;
            }
        }
        /*
            authentication:
            - "x-app-name: demo : v1.demo.auth"
            - "authorization: v1.basic.auth"
            - "default: v1.api.auth"
         */
        if (Array.isArray(authConfig)) {
            for (let i=0; i < authConfig.length; i++) {
                let valid = false;
                const authEntry = String(authConfig[i]);
                const parts = authEntry.split(':').filter(k => k.trim().length > 0);
                if (parts.length == 2) {
                    const authHeader = parts[0].trim();
                    const authService = parts[1].trim();
                    if (util.validRouteName(authService)) {
                        if ("default" == authHeader) {
                            info.defaultAuthService = authService;
                        } else {
                            info.setAuthService(authHeader, "*", authService);
                        }
                        valid = true;
                    }
                } else if (parts.length == 3) {
                    const authHeader = parts[0].trim();
                    const authValue = parts[1].trim();
                    const authService = parts[2].trim();
                    if (util.validRouteName(authService)) {
                        info.setAuthService(authHeader, authValue, authService);
                        valid = true;
                    }
                }
                if (!valid) {
                    log.error(`Skipping entry with invalid authentication service name ${config.get(REST+"["+idx+"]")}`);
                    return;
                }
            }
            if (info.defaultAuthService == null) {
                log.error(`Skipping entry because it is missing default authentication service ${config.get(REST+"["+idx+"]")}`);
                return;
            }
        }
        const tracing = config.getProperty(REST+"["+idx+"]."+TRACING);
        if (tracing == 'true') {
            info.tracing = true;
        }
        // drop query string when parsing URL
        if (url.includes("?")) {
            url = url.substring(0, url.indexOf('?'));
        }
        info.timeoutSeconds = this.getDurationInSeconds(config.getProperty(REST+"["+idx+"]."+TIMEOUT));
        const corsId = config.getProperty(REST+"["+idx+"]."+CORS);
        if (corsId) {
            if (this.corsConfig.has(corsId)) {
                info.corsId = corsId;
            } else {
                log.error(`Skipping invalid entry because cors ID ${corsId} is not found, ${config.get(REST+"["+idx+"]")}`);
                return;
            }
        }
        const headerId = config.getProperty(REST+"["+idx+"]."+HEADERS);
        if (headerId) {
            let foundTransform = false;
            if (this.requestHeaderInfo.has(headerId)) {
                info.requestTransformId = headerId;
                foundTransform = true;
            }
            if (this.responseHeaderInfo.has(headerId)) {
                info.responseTransformId = headerId;
                foundTransform = true;
            }
            if (!foundTransform) {
                log.error(`Skipping invalid entry because headers ID ${headerId} is not found, ${config.get(REST+"["+idx+"]")}`);
                return;
            }
        }
        if (info.primary.startsWith(HTTP) || info.primary.startsWith(HTTPS)) {
            const rewrite = config.get(REST+"["+idx+"]."+URL_REWRITE);
            // URL rewrite
            if (Array.isArray(rewrite)) {
                if (rewrite.length == 2) {
                    info.urlRewrite = rewrite;
                } else {                    
                    log.error(`Skipping entry with invalid ${URL_REWRITE} - ${rewrite}. It should contain a list of 2 prefixes`);
                    return;
                }
            } else {
                log.error(`Skipping entry with invalid ${URL_REWRITE} - ${rewrite}, expected: List<String>`);
                return;
            }
            try {
                const u = new URL(info.primary);
                if (u.pathname != '/') {
                    log.error(`Skipping entry with invalid service URL ${info.primary} - Must not contain path`);
                    return;
                }
                if (u.search) {
                    log.error(`Skipping entry with invalid service URL ${info.primary} - Must not contain query`);
                    return;
                }
                const trustAll = config.getProperty(REST+"["+idx+"]."+TRUST_ALL_CERT);
                if (info.primary.startsWith(HTTPS) && 'true' == trustAll) {
                    info.trustAllCert = true;
                    log.warn(`Be careful - ${TRUST_ALL_CERT}=true for ${info.primary}`);
                }
                if (info.primary.startsWith(HTTP) && trustAll != null) {
                    log.warn(`${TRUST_ALL_CERT}=true for ${info.primary} is not relevant - Do you meant https?`);
                }
                // set primary to ASYNC_HTTP_REQUEST
                info.host = info.primary;
                info.primary = ASYNC_HTTP_REQUEST;

            } catch (e) {
                log.error(`Skipping entry with invalid service URL ${info.primary} - ${e.message}`);
                return;
            }

        } else {
            const trustAll = config.getProperty(REST+"["+idx+"]."+TRUST_ALL_CERT);
            if (trustAll) {
                log.warn(`${TRUST_ALL_CERT} parameter for ${info.primary} is not relevant for regular service`);
            }
        }
        if (this.validMethods(methods)) {
            info.methods = methods;
            if (exact) {
                this.exactRoutes.set(url, true);
            }
            const nUrl = this.getUrl(url, exact);
            if (nUrl) {
                info.url = nUrl;
                const allMethods = new Set<string>(methods);
                // ensure OPTIONS method is supported
                allMethods.add(OPTIONS_METHOD);
                allMethods.forEach(m => {
                    const key = m+':'+nUrl;
                    this.routes.set(key, info);
                    if (m != OPTIONS_METHOD) {
                        const flowHint = info.flowId? `, flow=${info.flowId}` : '';
                        if (info.defaultAuthService) {
                            log.info(`${m} ${nUrl} -> ${info.defaultAuthService} -> ${info.services}, timeout=${info.timeoutSeconds}s, tracing=${info.tracing}${flowHint}`);
                        } else {
                            log.info(`${m} ${nUrl} -> ${info.services}, timeout=${info.timeoutSeconds}s, tracing=${info.tracing}${flowHint}`);
                        }
                    }
                });
            } else {
                log.error(`Skipping invalid entry ${config.get(REST+"["+idx+"]")}`);
            }
        } else {
            log.error(`Skipping entry with invalid method ${config.get(REST+"["+idx+"]")}`);
        }
    }

    getDurationInSeconds(duration?: string): number {
        if (duration) {
            return util.getDurationInSeconds(duration);
        } else {
            return 30;
        }
    }

    validMethods(methods: Array<string>): boolean {
        if (methods.length == 0) {
            return false;
        }
        for (let i=0; i < methods.length; i++) {
            if (!VALID_METHODS.includes(methods[i])) {
                return false;
            }
        }
        return true;
    }

    getUrl(url: string, exact: boolean): string {
        let result = '';
        const parts = url.toLowerCase().split('/').filter(v => v.length > 0);
        for (let i=0; i < parts.length; i++) {
            const s = parts[i];
            result += '/';
            if (!exact) {
                if (s.includes('{') && s.includes('}')) {
                    if (s.includes('*')) {
                        log.error(`wildcard url segment must not mix argument with *, actual ${s}`);
                        return null;
                    }
                    if (!this.validArgument(s)) {
                        log.error(`wildcard url segment must be enclosed with curly brackets, actual ${s}`);
                        return null;
                    }
                }
                if (s.includes("*") && !this.validWildcard(s)) {
                    log.error(`wildcard url segment must end with *, actual ${s}`);
                    return null;
                }
            }
            result += s;
        }
        return result;
    }

    validArgument(arg: string): boolean {
        if (arg.startsWith('{') && arg.endsWith('}')) {
            const v = arg.substring(1, arg.length - 1);
            if (v.length == 0) {
                return false;
            } else {
                return !v.includes('{') && !v.includes('}');
            }
        } else {
            return false;
        }
    }

    validWildcard(wildcard: string): boolean {
        if (wildcard == '*') {
            return true;
        }
        if (!wildcard.endsWith('*')) {
            return false;
        }
        const parts = wildcard.split('*');
        return parts.length == 1;
    }

    validateServiceList(services: string | Array<string>): Array<string> {
        const result = new Array<string>();
        if (typeof services == 'string') {
            result.push(services);
        } else if (Array.isArray(services)) {
            for (let i=0; i < services.length; i++) {
                result.push(String(services[i]));
            }
        }
        if (result.length == 0) {
            throw new Error('Missing service');
        }
        const firstItem = result[0];
        if (firstItem.startsWith(HTTP) || firstItem.startsWith(HTTPS)) {
            if (result.length > 1) {
                throw new Error('HTTP relay support a single URL only');
            }
            return result;
        }
        for (let i=0; i < result.length; i++) {
            const item = result[i];
            if (item.startsWith(HTTP) || item.startsWith(HTTPS)) {
                throw new Error('Cannot mix HTTP and service target');
            }
            if (!util.validRouteName(item)) {
                throw new Error('Invalid service name');
            }
        }
        return result;
    }

    getRouteInfo(method: string, url: string): AssignedRoute {
        let sb = ''
        const urlParts = url.split("/").filter(v => v.length > 0);
        for (const p of urlParts) {
            sb += '/';
            sb += p;
        }
        // do case-insensitive matching for exact URL
        const normalizedUrl = sb.toLowerCase();
        const key = method+":"+normalizedUrl;
        if (this.exactRoutes.has(normalizedUrl)) {
            return new AssignedRoute(this.routes.get(key));
        } else {
            // then compare each segment in the URL, also with case insensitivity
            let similar: AssignedRoute = null;
            for (const u of this.urlPaths) {
                const assigned = this.getMatchedRoute(urlParts, method, u);
                if (assigned != null) {
                    if (similar == null) {
                        similar = assigned;
                    }
                    // both URL path and method are correct
                    if (this.routes.has(method + ":" + u)) {
                        return assigned;
                    }
                }
            }
            /*
             * Similar path found but method does not match.
             * This allows it to reject the request with "HTTP-405 Method Not Allowed".
             */
            return similar;
        }
    }

    getMatchedRoute(urlParts: Array<string>, method: string, configured: string): AssignedRoute {
        // "configured" is a lower case URL in the routing entry
        const key = method+":"+configured;
        const result = new AssignedRoute(this.routes.get(key));
        const segments = configured.split("/").filter(v => v.length > 0);
        if (this.matchRoute(urlParts, segments, configured.endsWith("*"))) {
            this.addArguments(result, urlParts, segments);
            return result;
        }
        return null;
    }

    addArguments(info: AssignedRoute, urlParts: Array<string>, configured: Array<string>): void {
        for (let i=0; i < configured.length; i++) {
            const configuredItem = configured[i];
            if (configuredItem.startsWith("{") && configuredItem.endsWith("}")) {
                info.setArgument(configuredItem.substring(1, configuredItem.length-1), urlParts[i]);
            }
        }
    }

    matchRoute(input: Array<string>, segments: Array<string>, wildcard: boolean): boolean {
        // segment is lowercase parts of the configured URL
        if (wildcard) {
            if (segments.length > input.length) {
                return false;
            }
        } else {
            if (segments.length != input.length) {
                return false;
            }
        }
        for (let i=0; i < segments.length; i++) {
            const configuredItem = segments[i];
            if (configuredItem.startsWith("{") && configuredItem.endsWith("}")) {
                continue;
            }
            if ("*" == configuredItem) {
                continue;
            }
            // case-insensitive comparison using lowercase
            const inputItem = input[i].toLowerCase();
            if (configuredItem.endsWith("*")) {
                const prefix = configuredItem.substring(0, configuredItem.length-1);
                if (inputItem.startsWith(prefix)) {
                    continue;
                }
            }
            if (inputItem == configuredItem) {
                continue;
            }
            return false;
        }
        return true;
    }
}
