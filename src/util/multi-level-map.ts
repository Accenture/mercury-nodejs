
class NotFound {
    status = 404;
}

class StartMetadata {
    start = false;
}

class ScanMetadata {
    current: object;
    value = null;
}

function scanArrayInMap(key: string, v, target: object) {
    let n = 0;
    for (const o of v) {
        const next = key +'['+n+']';
        n++;
        if (Array.isArray(o)) {
            getFlattenList(next, o, target);
        } else if (o && o.constructor == Object) {
            getFlattenMap(next, o, target);
        } else if (o != null) {
            target[next] =  o;
        }
    }
}

function getFlattenMap(prefix: string, src: object, target: object): void {
    for (const k of Object.keys(src)) {
        const key = prefix == null? k : prefix+'.'+k;
        const v = src[k];
        if (Array.isArray(v)) {
            scanArrayInMap(key, v, target);
        } else if (v && v.constructor == Object) {
            getFlattenMap(key, v, target);        
        } else if (v != null) {
            target[key] = v;
        }
    }
}

function getFlattenList(prefix: string, src, target: object): void {
    let n = 0;
    for (const v of src) {
        const key = prefix+'['+n+']';
        n++;
        if (Array.isArray(v)) {
            getFlattenList(key, v, target);
        } else if (v && v.constructor == Object) {
            getFlattenMap(key, v, target);
        } else {
            target[key] = v;
        }
    }
}

function removeMapElement(pathname: string, map: object): void {
    setMapElement(pathname, null, map, true);
}

function setMapElement(compositePath: string, value, map: object, remove = false): void {    
    validateCompositePathSyntax(compositePath);
    const pathname = compositePath.includes("[]")? appendIndex(compositePath, map) : compositePath;
    const nullValue = value == null || value === undefined;
    // ignore null value
    if (pathname && !nullValue && map.constructor == Object) {
        const list = pathname.split('.').filter(v => v.length > 0);
        // if parent exists, do recursion to create/update key-value.
        if (list.length == 0 || (list.length > 1 && updateMapElement(pathname, list, map, value))) {
            return;
        }
        // if parent does not exist, walk the composite path and create key-value.
        insertElement(list, map, value, remove);
    }
}

function insertElement(list: Array<string>, map: object, value, remove: boolean) {
    let current = map;
    const len = list.length;
    let n = 0;
    let composite = '';
    for (const p of list) {
        n++;
        if (isListElement(p)) {
            const sep = p.indexOf('[');
            const indexes = getIndexes(p.substring(sep));
            const element = p.substring(0, sep);
            const parent = getMapElement(composite+element, map);
            if (n == len) {
                setLastListElement(parent, element, indexes, current, value);
                break;
            } else if (Array.isArray(parent)) {
                current = setNewMapElement(parent, composite, p, indexes, map);
            } else {
                current = setNewListElement(current, indexes, element);
            }
        } else if (n == len) {
            if (remove) {
                delete current[p];                        
            } else {
                current[p] = value;
            }                    
            break;
        } else {
            current = insertMapElement(p, current);
        }
        composite += (p + '.');
    }
}

function insertMapElement(p: string, current: object): object {
    const next = current[p];
    if (next && next.constructor == Object) {
        return next;
    } else {
        const nextMap = {};
        current[p] = nextMap;
        return nextMap;
    }
}

function updateMapElement(pathname: string, list: Array<string>, map: object, value): boolean {
    const parentMap = getMapElement(list[0], map);
    if (parentMap && parentMap.constructor == Object) {
        const dot = pathname.indexOf('.');
        const childPath = pathname.substring(dot+1);
        setMapElement(childPath, value, parentMap);
        return true;
    } else {
        return false;
    }
}

function setLastListElement(parent, element: string, indexes: Array<number>, current: object, value) {
    if (Array.isArray(parent)) {
        setListElement(indexes, parent, value);
    } else {
        const newList = [];
        setListElement(indexes, newList, value);
        current[element] = newList;
    }    
}

function setNewMapElement(parent, composite: string, p: string, indexes: Array<number>, map: object) {
    const next = getMapElement(composite+p, map);
    if (next && next.constuctor == Object) {                        
        return next;
    } else {
        const newMap = {};
        setListElement(indexes, parent, newMap);
        return newMap;
    }
}

function setNewListElement(current: object, indexes: Array<number>, element: string): object {
    const nextMap = {};
    const newList = [];
    setListElement(indexes, newList, nextMap);
    current[element] = newList;
    return nextMap;
}

function appendIndex(compositePath: string, map: object): string {
    const emptyIndex = compositePath.indexOf("[]");
    if (emptyIndex != -1) {
        const parent = compositePath.substring(0, emptyIndex);
        const result = compositePath.substring(0, emptyIndex) + "[" + findLastIndex(parent, map) + "]" +
                        compositePath.substring(emptyIndex+2);
        return appendIndex(result, map);
    }
    return compositePath;
}

function findLastIndex(key: string, map: object): number {
    const value = getMapElement(`${key}[0]`, map);
    if (value instanceof NotFound) {
        return 0;
    } else {
        return getMapElement(key, map).length;
    }
}

function setListElement(indexes: Array<number>, dataset, value) {
    const v = value ?? null;
    let current = expandList(indexes, dataset);
    const len = indexes.length;
    for (let i=0; i < len; i++) {
        const idx = indexes[i];
        if (i == len - 1) {
            current[idx] = v;
        } else {
            const o = current[idx];
            if (Array.isArray(o)) {
                current = o;
            }
        }
    }
}

function expandList(indexes: Array<number>, dataset) {
    let current = dataset;
    const len = indexes.length;
    for (let i=0; i < len; i++) {
        const idx = indexes[i];
        if (idx >= current.length) {
            let diff = idx - current.length;
            while (diff-- >= 0) {
                current.push(null);
            }
        }
        if (i == len - 1) {
            break;
        }
        const o = current[idx];
        if (Array.isArray(o)) {
            current = o;
        } else {
            const newList = [];
            current[idx] = newList;
            current = newList;
        }
    }
    return dataset;
}

function validateIndexFormat(md: StartMetadata, c: string) {
    if (c == '[') {
        if (md.start) {
            throw new Error('Invalid composite path - missing end bracket');
        } else {
            md.start = true;
        }
    } else if (c == ']') {
        if (!md.start) {
            throw new Error('Invalid composite path - duplicated end bracket');
        } else {
            md.start = false;
        }
    } else if (md.start) {
        if (c < '0' || c > '9') {
            throw new Error('Invalid composite path - indexes must be digits');
        }
    } else {
        throw new Error('Invalid composite path - invalid indexes');
    }    
}

function validateCompositePathIndex(s: string, sep: number) {
    const md = new StartMetadata();
    const text = s.substring(sep);
    for (const element of text) {
        validateIndexFormat(md, element);
    }    
}

function validateCompositePathSyntax(pathname: string): void {
    const list = pathname.split('.').filter(v => v.length > 0);
    if (list.length == 0) {
        throw new Error('composite path cannot be empty');
    }
    if (list[0].trim().startsWith("[")) {
        throw new Error('Invalid composite path - missing first element');
    }
    for (const s of list) {
        if (s.includes('[') || s.includes(']')) {
            if (!s.includes('[')) {
                throw new Error('Invalid composite path - missing start bracket');
            }
            if (!s.endsWith(']')) {
                throw new Error('Invalid composite path - missing end bracket');
            }
            // check start-end pair
            const start = s.indexOf('[');
            const end = s.indexOf(']');
            if (end < start) {
                throw new Error('Invalid composite path - missing start bracket');
            }
            validateCompositePathIndex(s, start);            
        }
    }
}

function scanListElement(md: ScanMetadata, p: string, n: number, len: number): ScanMetadata | string {
    const start = p.indexOf('[');
    const end = p.indexOf(']', start);
    if (end == -1) return 'break';
    const key = p.substring(0, start);
    const index = p.substring(start+1, end);
    if (index.length == 0 || !isDigits(index)) return 'break';
    if (key in md.current) {
        const nextList = md.current[key];
        if (Array.isArray(nextList)) {
            const indexes = getIndexes(p.substring(start));
            const next = getListElement(indexes, nextList);
            if (n == len) {
                md.value = next;
                return md;
            }
            if (next && next.constructor == Object) {
                md.current = next as object;
                return 'continue';
            }
        }
    }
   return 'break';
}

function scanMapElement(md: ScanMetadata, p: string, n: number, len: number): ScanMetadata | string {
    const next = md.current[p];
    if (n == len) {
        md.value = next;
        return md;
    } else if (next && next.constructor == Object) {
        md.current = next as object;
        return 'continue';
    } 
    return 'break';
}

function scanElement(md: ScanMetadata, p: string, n: number, len: number) {
    if (isListElement(p)) {
        return scanListElement(md, p, n, len);         
    } else if (p in md.current) {
        return scanMapElement(md, p, n, len);
    } 
    return 'break';
}

function getMapElement(pathname: string, map: object) {
    if (pathname && map && map.constructor == Object) {
        if (pathname in map) {
            return map[pathname];
        }
        if (!isComposite(pathname)) {
            return new NotFound();
        }
        const list = pathname.split('.').filter(v => v.length > 0);
        const md = new ScanMetadata();
        md.current = map;
        const len = list.length;
        let n = 0;
        for (const p of list) {
            n++;
            const result = scanElement(md, p, n, len);
            if (result instanceof ScanMetadata) {
                return result.value;
            } else if ('break' == result) {
                break;
            }            
        } 
    }
    return new NotFound();
}

function isComposite(item: string): boolean {
    return item.includes('.') || item.includes('[') || item.includes(']')
}

function isListElement(item: string): boolean {
    return item.includes('[') && item.endsWith(']') && !item.startsWith('[');
}

function isDigits(text: string): boolean {
    if (text) {
        for (const c of text) {
            if (c >= '0' && c <= '9') continue;
            return false;
        }
        return text.length > 0;
    } else {
        return false;
    }
}

function getIndexes(indexSegment: string): Array<number> {
    const indexes = indexSegment.split(/[[\]]+/).filter(v => v.length > 0);
    const result: Array<number> = [];
    for (const v of indexes) {
        const n = Number(v);
        result.push(isNaN(n)? -1 : n);
    }
    return result;
}

function getListElement(indexes: Array<number>, data) {
    let current = data;
    let n = 0;
    const len = indexes.length;
    for (const i of indexes) {
        n++;
        if (i < 0 || i >= current.length) break;
        const o = current[i];
        if (n == len) {
            return o;
        }
        if (o instanceof Array) {
            current = o;
        } else {
            break;
        }
    }
    return new NotFound();
}

/**
 * Convenient helper class to read/write key-values using javascript dot-bracket convention.
 * 
 * Javascript supports retrieval of key-value using the dot-bracket convention.
 * However, this would require the use of 'eval' to convert a composite key string.
 * 
 * This helper class extends this to allow use of composite key as a string without using 'eval'.
 * Therefore developers can programmatically construct a composite key.
 */
export class MultiLevelMap {
    private multiLevels = {};

    constructor(kv?: object) {
        this.reload(kv);
    }

    /**
     * Retrieve the underlying map
     * 
     * @returns map
     */
    getMap(): object {
        return this.multiLevels;
    }

    reload(kv?: object): void {
        if (kv && kv.constructor == Object) {
            this.multiLevels = kv;
        }
    }

    /**
     * Check if the map is empty
     * 
     * @returns true or false
     */
    isEmpty(): boolean {
        return Object.keys(this.multiLevels).length == 0;
    }

    /**
     * Check if a key-value exists
     * 
     * @param compositePath in dot-bracket convention
     * @returns true or false
     */
    exists(compositePath: string): boolean {
        const value = getMapElement(compositePath, this.multiLevels);
        return value != null && !(value instanceof NotFound);
    }

    /**
     * Check if a key exists where the value can be null
     * 
     * @param compositePath in dot-bracket convention
     * @returns true or false
     */
    keyExists(compositePath: string): boolean {
        const value = getMapElement(compositePath, this.multiLevels);
        return !(value instanceof NotFound);
    }

    /**
     * Retrieve an element using a composite key
     * 
     * @param compositePath in dot-bracket convention
     * @param defaultValue is optional
     * @returns element value
     */
    getElement(compositePath: string, defaultValue = null) {
        const value = getMapElement(compositePath, this.multiLevels);
        return value instanceof NotFound? defaultValue : value;
    }

    /**
     * Set value using a composite key. e.g.
     * const m = {'hello': 'world', 'x': {'y': [1, [10, 20, 30], {'a': 'b'}]}}
     * const mm = new MultiLevelMap(m);
     * const result = mm.getElement('x.y[1][1]'))
     * // result is 20
     * 
     * @param compositePath in dot-bracket convention
     * @param value 
     * @returns this
     */
    setElement(compositePath: string, value): this {
        setMapElement(compositePath, value, this.multiLevels);
        return this;
    }

    /**
     * Remove an element using a composite key
     * 
     * @param compositePath in dot-bracket convention
     * @returns this
     */
    removeElement(compositePath: string): this {
        removeMapElement(compositePath, this.multiLevels);
        return this;
    }

    /**
     * Flatten key-values in a single layer
     * 
     * @returns map with a flatten data structure
     */
    getFlatMap(): object {
        const result = {};
        getFlattenMap(null, this.multiLevels, result);
        return result;
    }

    /**
     * Convert a flatten map into a multi-level map
     * 
     * @returns multi-level map
     */
    normalizeMap(): this {
        const flatMap = this.getFlatMap();
        this.multiLevels = {};
        Object.keys(flatMap).forEach(k => {
            this.setElement(k, flatMap[k]);
        });
        return this;
    }
}
