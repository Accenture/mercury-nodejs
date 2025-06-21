import { ConfigReader } from "./config-reader.js";
export declare class EventHttpResolver {
    private static instance;
    private loaded;
    private readonly eventHttpTargets;
    private readonly eventHttpHeaders;
    private constructor();
    static getInstance(): EventHttpResolver;
    loadHttpRoutes(file: string, config: ConfigReader): void;
    private addHttpEntry;
    getEventHttpTarget(route: string): string;
    getEventHttpHeaders(route: string): object;
}
