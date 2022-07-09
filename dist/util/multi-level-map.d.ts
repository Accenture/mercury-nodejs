/**
 * Convenient helper class to read/write key-values using javascript dot-bracket convention.
 *
 * Javascript supports retrieval of key-value using the dot-bracket convention.
 * However, this would require the use of 'eval' to convert a composite key string.
 *
 * This helper class extends this to allow use of composite key as a string without using 'eval'.
 * Therefore developers can programmatically construct a composite key.
 */
export declare class MultiLevelMap {
    private multiLevels;
    constructor(multiLevel?: object);
    /**
     * Retrieve the underlying map
     *
     * @returns map
     */
    getMap(): object;
    /**
     * Check if the map is empty
     *
     * @returns true or false
     */
    isEmpty(): boolean;
    /**
     * Check if a key-value exists
     *
     * @param compositePath in dot-bracket convention
     * @returns true or false
     */
    exists(compositePath: string): boolean;
    /**
     * Check if a key exists where the value can be null
     *
     * @param compositePath in dot-bracket convention
     * @returns true or false
     */
    keyExists(compositePath: string): boolean;
    /**
     * Retrieve an element using a composite key
     *
     * @param compositePath in dot-bracket convention
     * @param defaultValue is optional
     * @returns element value
     */
    getElement(compositePath: string, defaultValue?: any): any;
    /**
     * Set value using a composite key
     *
     * e.g.
     * const m = {'hello': 'world', 'x': {'y': [1, [10, 20, 30], {'a': 'b'}]}}
     * const mm = new MultiLevelMap(m);
     * const result = mm.getElement('x.y[1][1]'))
     * // result is 20
     *
     * @param compositePath in dot-bracket convention
     * @param value
     * @returns this
     */
    setElement(compositePath: string, value: any): MultiLevelMap;
    /**
     * Flatten key-values in a single layer
     *
     * @returns map with a flatten data structure
     */
    getFlatMap(): object;
    /**
     * Convert a flatten map into a multi-level map
     *
     * @returns multi-level map
     */
    normalizeMap(): MultiLevelMap;
}
