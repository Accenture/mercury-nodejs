import { ConfigReader } from "./config-reader.js";
export declare class EventHttpResolver {
    private static instance;
    private loaded;
    private eventHttpTargets;
    private eventHttpHeaders;
    private constructor();
    static getInstance(): EventHttpResolver;
    loadHttpRoutes(file: string, config: ConfigReader): void;
    getEventHttpTarget(route: string): string;
    getEventHttpHeaders(route: string): object;
}
