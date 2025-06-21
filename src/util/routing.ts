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
        self ??= RestEntry.getInstance();
    }

    load(config: ConfigReader): void {
        self.load(config);
    }

    getRouteInfo(method: string, url: string): AssignedRoute {
        return self.getRouteInfo(method, url);
    }

    getRequestHeaderInfo(id: string): HeaderInfo {
        const result = self.getRequestHeaderInfo(id);
        return result || null;
    }

    getResponseHeaderInfo(id: string): HeaderInfo {
        const result = self.getResponseHeaderInfo(id);
        return result || null;
    }

    getCorsInfo(id: string): CorsInfo {
        const result = self.getCorsInfo(id);
        return result || null;
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
        return result || null;
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
    private readonly requestHeaderInfo = new Map<string, HeaderInfo>();
    private readonly responseHeaderInfo = new Map<string, HeaderInfo>();
    private readonly corsConfig = new Map<string, CorsInfo>();
    private readonly exactRoutes = new Map<string, boolean>();
    private readonly routes = new Map<string, RouteInfo>();
    private readonly urlPaths = new Array<string>();

    private constructor() {}

    static getInstance() {
        RestEntry.instance ??= new RestEntry();
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
                this.loadRest(config);
                this.completed();
            } else {
                log.error("'rest' section must be a list of endpoint entries (url, service, methods, timeout...)");
            }           
        }
    } 

    private completed() {
        const exact = Array.from(this.exactRoutes.keys());
        if (exact.length > 0) {
            const sorted = exact.slice().sort((a, b) => a.localeCompare(b));
            log.info({'type': 'url', 'match': 'exact', 'total': exact.length, 'path': sorted});
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
            const sorted = this.urlPaths.slice().sort((a, b) => a.localeCompare(b));
            log.info({'type': 'url', 'match': 'parameters', 'total': this.urlPaths.length, 'path': sorted});
        } 
    }

    private loadHeaderTransform(config: ConfigReader, total: number): void {
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

    private loadHeaderEntry(config: ConfigReader, idx: number, isRequest: boolean): void {
        const id = config.getProperty(HEADERS+"["+idx+"]."+ID);
        const type = isRequest? REQUEST : RESPONSE;
        const counters = new HeaderCounters();
        const info = new HeaderInfo();
        const addList = config.get(HEADERS+"["+idx+"]."+type+"."+ADD);
        if (Array.isArray(addList)) {
            this.addHeaders(config, idx, type, info, addList, counters);
        }
        const dropList = config.get(HEADERS+"["+idx+"]."+type+"."+DROP);
        if (Array.isArray(dropList)) {
            this.dropHeaders(config, idx, type, info, dropList, counters);
        }
        const keepList = config.get(HEADERS+"["+idx+"]."+type+"."+KEEP);
        if (Array.isArray(keepList)) {
            this.keepHeaders(config, idx, type, info, keepList, counters);
        }
        if (isRequest) {
            this.requestHeaderInfo.set(id, info);
        } else {
            this.responseHeaderInfo.set(id, info);
        }
        log.info(`Loaded ${id}, ${type} headers, add=${counters.addCount}, drop=${counters.dropCount}, keep=${counters.keepCount}`);
    }

    private addHeaders(config: ConfigReader, idx: number, type: string, info: HeaderInfo, addList: Array<string>, counters: HeaderCounters) {
        const id = config.getProperty(HEADERS+"["+idx+"]."+ID);
        for (let j=0; j < addList.length; j++) {
            let valid = false;
            const kv = config.getProperty(HEADERS+"["+idx+"]."+type+"."+ADD+"["+j+"]", "null");
            const colon = kv.indexOf(':');
            if (colon > 0) {
                const k = kv.substring(0, colon).trim().toLowerCase();
                const v = kv.substring(colon+1).trim();
                if (k && v) {
                    info.additionalHeaders.set(k, v);
                    counters.addCount++;
                    valid = true;
                }                    
            } 
            if (!valid) {
                log.warn(`Skipping invalid header ${id} ${HEADERS}[${idx}].${type}.${ADD}`);
            }
        }        
    }

    private dropHeaders(config: ConfigReader, idx: number, type: string, info: HeaderInfo, dropList: Array<string>, counters: HeaderCounters) {
        for (let j=0; j < dropList.length; j++) {
            const key = config.getProperty(HEADERS+"["+idx+"]."+type+"."+DROP+"["+j+"]");
            if (key) {
                info.dropHeaders.push(key);
                counters.dropCount++;
            }
        }        
    }

    private keepHeaders(config: ConfigReader, idx: number, type: string, info: HeaderInfo, keepList: Array<string>, counters: HeaderCounters) {
        for (let j=0; j < keepList.length; j++) {
            const key = config.getProperty(HEADERS+"["+idx+"]."+type+"."+KEEP+"["+j+"]");
            if (key) {
                info.keepHeaders.push(key);
                counters.keepCount++;
            }
        }       
    }

    private loadCors(config: ConfigReader, total: number): void {
        for (let i=0; i < total; i++) {
            const id = config.getProperty(CORS+"["+i+"]."+ID);
            const options = config.get(CORS+"["+i+"]."+OPTIONS);
            const headers = config.get(CORS+"["+i+"]."+HEADERS);
            if (id && Array.isArray(options) && Array.isArray(headers)) {
                if (this.validCorsList(options) && this.validCorsList(headers)) {
                    this.parseCors(config, i);
                } else {
                    log.error(`Skipping invalid cors entry id=${id}, options=${options}, headers=${headers}`);
                }
            } else {
                log.error(`Skipping invalid cors definition ${config.get(CORS+"["+i+"]")}`);
            }
        }
    }

    private parseCors(config: ConfigReader, i: number) {
        const id = config.getProperty(CORS+"["+i+"]."+ID);
        const options = config.get(CORS+"["+i+"]."+OPTIONS);
        const headers = config.get(CORS+"["+i+"]."+HEADERS);
        const info = new CorsInfo();
        for (let j=0; j < options.length; j++) {
            info.addOption(config.getProperty(CORS + "[" + i + "]." + OPTIONS + "[" + j + "]"));
        }
        for (let j=0; j < headers.length; j++) {
            info.addHeader(config.getProperty(CORS + "[" + i + "]." + HEADERS + "[" + j + "]"));
        } 
        this.corsConfig.set(id, info);
        log.info(`Loaded ${id} cors headers (${info.getOrigin(false)})`);       
    }

    private validCorsList(list: Array<string>): boolean {
        for (const entry of list) {
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

    private validCorsElement(element: string): boolean {
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

    private loadRest(config: ConfigReader): void {
        this.addDefaultEndpoints(config);
        const rest = config.get(REST);
        const total = rest.length;
        // perform custom sort in ascending order of URL, methods and services
        const keys = [];
        for (let i=0; i < total; i++) {
            const services = config.get(REST+"["+i+"]."+SERVICE);
            const methods = config.get(REST+"["+i+"]."+METHODS);
            const url = config.getProperty(REST+"["+i+"]."+URL_LABEL);
            if (url && Array.isArray(methods) && (typeof services == 'string' || Array.isArray(services))) {
                keys.push(`${url} | ${JSON.stringify(methods)} |${i}`);
            } else {                
                log.error(`Skip invalid REST entry ${config.get(REST+"["+i+"]")}`);
            }
        }
        keys.sort((a, b) => a.localeCompare(b));
        // generate the sorted REST entries
        const mm = new MultiLevelMap();
        let n = 0;
        for (const k of keys) {     
            const idx = k.substring(k.lastIndexOf('|') + 1);
            mm.setElement(REST+"["+n+"]", config.get(REST+"["+idx+"]"));
            n++;
        }
        const sortedConfig = new ConfigReader(mm.getMap());
        for (let i=0; i < total; i++) {
            const services = sortedConfig.get(REST+"["+i+"]."+SERVICE);
            const methods = sortedConfig.get(REST+"["+i+"]."+METHODS);
            const url = sortedConfig.getProperty(REST+"["+i+"]."+URL_LABEL);
            if (url && Array.isArray(methods) && (typeof services == 'string' || Array.isArray(services))) {
                try {
                    this.loadRestEntry(sortedConfig, i, !url.includes("{") && !url.includes("}") && !url.includes("*"));
                } catch (e) {
                    log.error(`Skip entry - ${e.message}`);                     
                }                
            }
        }
    }

    private addDefaultEndpoints(config: ConfigReader) {
        const defaultRest = util.loadYamlFile(util.getFolder("../resources/default-rest.yaml"));
        const defaultRestEntries = defaultRest.getElement(REST) as Array<object>;
        const defaultTotal = defaultRestEntries.length;
        const essentials = {};
        const configured = new Array<string>();
        for (let i=0; i < defaultTotal; i++) {
            const methods = defaultRest.getElement(REST+"["+i+"]."+METHODS);
            const url = defaultRest.getElement(REST+"["+i+"]."+URL_LABEL);
            essentials[url+" "+JSON.stringify(methods)] = i;
        }
        const restEntries = config.get(REST) as Array<object>;
        let total = restEntries.length;
        for (let i=0; i < total; i++) {
            const methods = config.get(REST+"["+i+"]."+METHODS);
            const url = config.getProperty(REST+"["+i+"]."+URL_LABEL);
            if (url && Array.isArray(methods)) {
                configured.push(url+" "+JSON.stringify(methods));
            }
        }
        // find out if there are missing default entries in the configured list
        const missing = new Array<string>();
        for (const entry of Object.keys(essentials)) {
            if (!configured.includes(entry)) {
                missing.push(entry);
            }
        }
        if (missing.length > 0) {
            const map = new MultiLevelMap(config.getMap());
            for (const entry of missing) {
                const idx = essentials[entry] as number;
                map.setElement(REST + "[" + total + "]", defaultRest.getElement(REST + "[" + idx + "]"));
                total++;
            }
            config.reload(map);
        }
    }

    private loadRestEntry(config: ConfigReader, idx: number, exact: boolean): void {
        const info = new RouteInfo();
        const services = config.get(REST+"["+idx+"]."+SERVICE);
        let url = config.getProperty(REST+"["+idx+"]."+URL_LABEL).toLowerCase();
        try {
            info.services = this.validateServiceList(services);
        } catch (e) {
            throw new Error(`${config.get(REST+"["+idx+"]")} - ${e.message}`);
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
        this.validateAuthConfig(config, idx, info);
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
                throw new Error(`cors ID ${corsId} not found, ${config.get(REST+"["+idx+"]")}`);
            }
        }
        const headerId = config.getProperty(REST+"["+idx+"]."+HEADERS);
        if (headerId) {
            this.validateHeaderTransformers(config, idx, headerId, info);
        }
        if (info.primary.startsWith(HTTP) || info.primary.startsWith(HTTPS)) {
            this.parseUrlRewrite(config, idx, info);
        } else {
            const trustAll = config.getProperty(REST+"["+idx+"]."+TRUST_ALL_CERT);
            if (trustAll) {
                log.warn(`${TRUST_ALL_CERT} parameter for ${info.primary} is not relevant for regular service`);
            }
        }    
        this.parseMethods(config, idx, info, url, exact);        
    }

    private validateAuthConfig(config: ConfigReader, idx: number, info: RouteInfo) {
        const authConfig = config.get(REST+"["+idx+"]."+AUTHENTICATION);        
        if (typeof authConfig == 'string') {
            // authentication: "v1.api.auth"
            if (util.validRouteName(authConfig)) {
                info.defaultAuthService = authConfig;
            } else {
                throw new Error(`invalid authentication service name ${config.get(REST+"["+idx+"]")}`);
            }
        }
        if (Array.isArray(authConfig)) {
            /*
                authentication:
                - "x-app-name: demo : v1.demo.auth"
                - "authorization: v1.basic.auth"
                - "default: v1.api.auth"
            */                
            for (const entry of authConfig) {
                this.loadAuthConfig(config, idx, String(entry), info);
            }
            if (info.defaultAuthService == null) {
                throw new Error(`missing default authentication service ${config.get(REST+"["+idx+"]")}`);
            }
        }        
    }

    private validateHeaderTransformers(config: ConfigReader, idx: number, headerId: string, info: RouteInfo) {
        let found = false;
        if (this.requestHeaderInfo.has(headerId)) {
            info.requestTransformId = headerId;
            found = true;
        }
        if (this.responseHeaderInfo.has(headerId)) {
            info.responseTransformId = headerId;
            found = true;
        }
        if (!found) {
            throw new Error(`headers ID ${headerId} not found, ${config.get(REST+"["+idx+"]")}`);
        }
    }

    private parseMethods(config: ConfigReader, idx: number, info: RouteInfo, url: string, exact: boolean) {
        const methods = config.get(REST+"["+idx+"]."+METHODS) as Array<string>;
        if (!this.validMethods(methods)) {
            throw new Error(`invalid method ${config.get(REST+"["+idx+"]")}`);
        }
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
            throw new Error(`invalid url ${config.get(REST+"["+idx+"]")}`);
        }        
    }

    private parseUrlRewrite(config: ConfigReader, idx: number, info: RouteInfo) {
        const rewrite = config.get(REST+"["+idx+"]."+URL_REWRITE);
        // URL rewrite
        if (Array.isArray(rewrite)) {
            if (rewrite.length == 2) {
                info.urlRewrite = rewrite;
            } else {                    
                throw new Error(`invalid ${URL_REWRITE} - ${rewrite}. It should contain a list of 2 prefixes`);
            }
        } else {
            throw new Error(`invalid ${URL_REWRITE} - ${rewrite}, expected: List<String>`);
        }
        const u = new URL(info.primary);
        if (u.pathname != '/') {
            throw new Error(`invalid service URL ${info.primary} - Must not contain path`);
        }
        if (u.search) {
            throw new Error(`invalid service URL ${info.primary} - Must not contain query`);
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
    }

    private loadAuthConfig(config: ConfigReader, idx: number, authEntry: string, info: RouteInfo) {
        let valid = false;
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
        for (const m of methods) {
            if (!VALID_METHODS.includes(m)) {
                return false;
            }            
        }
        return true;
    }

    getUrl(url: string, exact: boolean): string {
        let result = '';
        const parts = url.toLowerCase().split('/').filter(v => v.length > 0);
        for (const s of parts) {
            result += '/';
            if (!exact) {
                if (s.includes("*") && !this.validWildcard(s)) {
                    log.error(`wildcard url segment must end with *, actual ${s}`);
                    return null;
                } else if (s.includes('{') && s.includes('}') && !this.validArgument(s)) {
                    log.error(`invalid url path parameter inside curly brackets, actual ${s}`);
                    return null;
                }
            }
            result += s;
        }
        return result;
    }

    validArgument(arg: string): boolean {
        if (arg.startsWith('{') && arg.endsWith('}')) {
            if (arg.includes('*')) {
                return false;
            }
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
            for (const svc of services) {
                result.push(String(svc));
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
        for (const item of result) {
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
        const urlParts = url.split('/').filter(v => v.length > 0);
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
                    similar ??= assigned;
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
        const segments = configured.split('/').filter(v => v.length > 0);
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
        } else if (segments.length != input.length) {
                return false;
        }
        for (let i=0; i < segments.length; i++) {
            const configuredItem = segments[i];
            if ((configuredItem.startsWith("{") && configuredItem.endsWith("}")) || "*" == configuredItem) {
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

class HeaderCounters {
    addCount = 0;
    dropCount = 0;
    keepCount = 0;
}
