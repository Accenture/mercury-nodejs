import { ConfigReader } from './config-reader.js';
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export declare class RoutingEntry {
    constructor();
    load(config: ConfigReader): void;
    getRouteInfo(method: string, url: string): AssignedRoute;
    getRequestHeaderInfo(id: string): HeaderInfo;
    getResponseHeaderInfo(id: string): HeaderInfo;
    getCorsInfo(id: string): CorsInfo;
}
export declare class AssignedRoute {
    arguments: Map<string, string>;
    info: RouteInfo;
    constructor(info: RouteInfo);
    setArgument(key: string, value: string): void;
}
export declare class RouteInfo {
    authHeaders: string[];
    authServices: Map<string, string>;
    url: string;
    defaultAuthService: string;
    corsId: string;
    flowId: string;
    requestTransformId: string;
    responseTransformId: string;
    primary: string;
    services: string[];
    tracing: boolean;
    methods: string[];
    timeoutSeconds: number;
    upload: boolean;
    host: string;
    trustAllCert: boolean;
    urlRewrite: string[];
    getAuthService(headerKey: string, headerValue?: string): string;
    setAuthService(headerKey: string, headerValue: string, service: string): void;
}
export declare class CorsInfo {
    options: Map<string, string>;
    headers: Map<string, string>;
    getOrigin(isOption: boolean): string;
    addOption(element: string): void;
    addHeader(element: string): void;
}
export declare class HeaderInfo {
    additionalHeaders: Map<string, string>;
    keepHeaders: string[];
    dropHeaders: string[];
}
