import { ConfigReader, AppConfig } from "./config-reader.js";
import { Logger } from './logger.js';

const log = Logger.getInstance();

export class ContentTypeResolver {
    private static instance: ContentTypeResolver;
    private loaded = false;
    private readonly customContentTypes = new Map<string, string>();

    private constructor() {}

    static getInstance() {
        ContentTypeResolver.instance ??= new ContentTypeResolver();
        return ContentTypeResolver.instance;
    }

    loadCustomContentTypes(config: ConfigReader) {
        if (!this.loaded) {
            this.loaded = true;
            const appConfig = AppConfig.getInstance();
            const ctInternal = appConfig.get('custom.content.types');
            if (ctInternal instanceof Object && Array.isArray(ctInternal)) {
                for (const entry of ctInternal) {
                    this.addCustomContentType(entry); 
                }
            }
            const ctExternal = config.get('custom.content.types');
            if (ctExternal instanceof Object && Array.isArray(ctExternal)) {
                for (const entry of ctExternal) {
                    this.addCustomContentType(entry); 
                }
            }
            if (this.customContentTypes.size > 0) {
                log.info(`Loaded ${this.customContentTypes.size} custom content types`);
            } 
        }
    }

    private addCustomContentType(entry: string) {
        const sep = entry.indexOf('->');
        if (sep != -1) {
            const k = entry.substring(0, sep).trim();
            const v = entry.substring(sep+2).trim();
            if (k && v) {
                this.customContentTypes.set(k, v.toLowerCase());
            }                        
        }
    }

    getContentType(contentType: string) {
        if (contentType) {
            const sep = contentType.indexOf(';');
            const ct = sep == -1? contentType.trim() : contentType.substring(0, sep).trim();
            const customType = this.customContentTypes.get(ct);
            return customType || ct;
        } else {
            return null;
        }
    }
}
