import { v4 as uuid4 } from 'uuid';
import NodeCache from 'node-cache'

let self: Util = null;

export class Utility {

    constructor() {
        if (self == null) {
            self = new Util();
        }
    }
  
    getInstance(): Util {
        return self;
    }
}

class Util {

    private cache = new NodeCache();

    getUuid(): string {
        return uuid4().replace(new RegExp('-', 'g'), '');
    }

    sleep(milliseconds = 1000) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve(milliseconds);
            }, Math.max(0, milliseconds));
        });
    }

    getFloat(n: number, decimalPoint = 3): number {
        return n && n.constructor == Number? parseFloat(n.toFixed(decimalPoint)) : 0.0;
    }

    saveCache(key: string, value, expirySeconds: number): boolean {
        return this.cache.set(key, value == null? '' : value, expirySeconds);
    }

    getCached(key: string) {
        return this.cache.get(key);
    }

    removeCache(key: string): void {
        this.cache.del(key);
    }

    cacheExists(key: string): boolean {
        return this.cache.has(key);
    }

    cacheStats(): object {
        const stats = this.cache.getStats();
        return {
                'hits': stats.hits, 'misses': stats.misses, 
                'count': stats.keys, 'key_size': stats.ksize, 
                'value_size': stats.vsize
            };
    }

    cacheCount(): number {
        return this.cache.getStats().keys;
    }

    cacheHits(): number {
        return this.cache.getStats().hits;
    }

    cacheMisses(): number {
        return this.cache.getStats().misses;
    }

    cacheKeySize(): number {
        return this.cache.getStats().ksize
    }

    cacheValueSize(): number {
        return this.cache.getStats().vsize;
    }

}