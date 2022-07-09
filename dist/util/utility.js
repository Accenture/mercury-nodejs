import { v4 as uuid4 } from 'uuid';
import NodeCache from 'node-cache';
let self = null;
export class Utility {
    constructor() {
        if (self == null) {
            self = new Util();
        }
    }
    getInstance() {
        return self;
    }
}
class Util {
    constructor() {
        this.cache = new NodeCache();
    }
    getUuid() {
        return uuid4().replace(new RegExp('-', 'g'), '');
    }
    sleep(milliseconds = 1000) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve(milliseconds);
            }, Math.max(0, milliseconds));
        });
    }
    getFloat(n, decimalPoint = 3) {
        return n && n.constructor == Number ? parseFloat(n.toFixed(decimalPoint)) : 0.0;
    }
    saveCache(key, value, expirySeconds) {
        return this.cache.set(key, value == null ? '' : value, expirySeconds);
    }
    getCached(key) {
        return this.cache.get(key);
    }
    removeCache(key) {
        this.cache.del(key);
    }
    cacheExists(key) {
        return this.cache.has(key);
    }
    cacheStats() {
        const stats = this.cache.getStats();
        return {
            'hits': stats.hits, 'misses': stats.misses,
            'count': stats.keys, 'key_size': stats.ksize,
            'value_size': stats.vsize
        };
    }
    cacheCount() {
        return this.cache.getStats().keys;
    }
    cacheHits() {
        return this.cache.getStats().hits;
    }
    cacheMisses() {
        return this.cache.getStats().misses;
    }
    cacheKeySize() {
        return this.cache.getStats().ksize;
    }
    cacheValueSize() {
        return this.cache.getStats().vsize;
    }
}
//# sourceMappingURL=utility.js.map