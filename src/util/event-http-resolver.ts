import { ConfigReader } from "./config-reader.js";
import { Logger } from './logger.js';

const log = Logger.getInstance();

export class EventHttpResolver {
    private static instance: EventHttpResolver;
    private loaded = false;
    private eventHttpTargets = new Map<string, string>();
    private eventHttpHeaders = new Map<string, object>();

    private constructor() {}

    static getInstance() {
        if (EventHttpResolver.instance === undefined) {
            EventHttpResolver.instance = new EventHttpResolver();
        }
        return EventHttpResolver.instance;
    }

    loadHttpRoutes(file: string, config: ConfigReader) {
        if (!this.loaded) {
            this.loaded = true;
            const o = config.get("event.http");
            if (Array.isArray(o)) {
                const eventHttpEntries = o as object[];
                for (let i=0; i < eventHttpEntries.length; i++) {
                    const route = config.getProperty("event.http["+i+"].route");
                    const target = config.getProperty("event.http["+i+"].target");
                    if (route && target) {
                        this.eventHttpTargets.set(route, target);
                        let headerCount = 0;
                        const h = config.get("event.http["+i+"].headers");
                        if (h instanceof Object && !Array.isArray(h)) {
                            const headers = {};
                            Object.keys(h).forEach(k => {
                                headers[String(k)] = config.getProperty("event.http["+i+"].headers."+k);
                                headerCount++;
                            });
                            this.eventHttpHeaders.set(route, headers);
                        }
                        log.info(`Event-over-HTTP ${route} -> ${target} with ${headerCount} header${headerCount == 1? '' : 's'}`);
                    }
                }
                const total = this.eventHttpTargets.size;
                log.info(`Total ${total} event-over-http target${total == 1? '' : 's'} configured`);
            } else {
                log.error(`Invalid config ${file} - the event.http section should be a list of route and target`);
            }
        }
    }

    getEventHttpTarget(route: string): string {
        return this.eventHttpTargets.get(route);
    }

    getEventHttpHeaders(route: string): object {
        return this.eventHttpHeaders.has(route)? this.eventHttpHeaders.get(route) : {};
    }
}
