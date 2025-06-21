import { ConfigReader } from "./config-reader.js";
export declare class ContentTypeResolver {
    private static instance;
    private loaded;
    private readonly customContentTypes;
    private constructor();
    static getInstance(): ContentTypeResolver;
    loadCustomContentTypes(config: ConfigReader): void;
    private addCustomContentType;
    getContentType(contentType: string): string;
}
