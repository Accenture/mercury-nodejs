import { AppConfig } from "./config-reader.js";
import { Logger } from './logger.js';
const log = Logger.getInstance();
export class ContentTypeResolver {
    static instance;
    loaded = false;
    customContentTypes = new Map();
    constructor() { }
    static getInstance() {
        if (ContentTypeResolver.instance === undefined) {
            ContentTypeResolver.instance = new ContentTypeResolver();
        }
        return ContentTypeResolver.instance;
    }
    loadCustomContentTypes(config) {
        if (!this.loaded) {
            this.loaded = true;
            const cSettings = config.get('custom.content.types');
            if (cSettings instanceof Object && Array.isArray(cSettings)) {
                for (const entry of cSettings) {
                    const sep = entry.indexOf('->');
                    if (sep != -1) {
                        const k = entry.substring(0, sep).trim();
                        const v = entry.substring(sep + 2).trim();
                        if (k && v) {
                            this.customContentTypes.set(k, v.toLowerCase());
                        }
                    }
                }
            }
            const appConfig = AppConfig.getInstance();
            const ct = appConfig.get('custom.content.types');
            if (ct instanceof Object && Array.isArray(ct)) {
                for (const entry of ct) {
                    const sep = entry.indexOf('->');
                    if (sep != -1) {
                        const k = entry.substring(0, sep).trim();
                        const v = entry.substring(sep + 2).trim();
                        if (k && v) {
                            this.customContentTypes.set(k, v.toLowerCase());
                        }
                    }
                }
            }
            if (this.customContentTypes.size > 0) {
                log.info(`Loaded ${this.customContentTypes.size} custom content types`);
            }
        }
    }
    getContentType(contentType) {
        if (contentType) {
            const sep = contentType.indexOf(';');
            const ct = sep == -1 ? contentType.trim() : contentType.substring(0, sep).trim();
            const customType = this.customContentTypes.get(ct);
            return customType ? customType : ct;
        }
        else {
            return null;
        }
    }
}
//# sourceMappingURL=content-type-resolver.js.map