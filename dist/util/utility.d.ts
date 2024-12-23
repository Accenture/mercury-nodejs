import { MultiLevelMap } from './multi-level-map.js';
export declare class Utility {
    /**
     * Generate UUID without hyphen characters
     *
     * @returns unique ID
     */
    getUuid(): string;
    /**
     * sleep for a short time in a non-blocking fashion
     *
     * @param milliseconds to sleep
     * @returns promise
     */
    sleep(milliseconds?: number): Promise<unknown>;
    /**
     * Format a floating point number to 3 decimal points
     *
     * @param n is the number
     * @param decimalPoint default 3
     * @returns formatted floating point number
     */
    getFloat(n: number, decimalPoint?: number): number;
    /**
     * Convert a text string into a number
     *
     * @param s is the text string containing a number
     * @returns integer value
     */
    str2int(s: string): number;
    /**
     * Convert a text string into a floating point number
     *
     * @param s is the text string containing a number
     * @returns floating point number
     */
    str2float(s: string): number;
    /**
     * Test if the text string contains only digits
     *
     * @param text string to be tested
     * @returns true if numbers
     */
    isDigits(text: string): boolean;
    /**
     * Check if the given route name is in valid format
     *
     * @param route name
     * @returns true if valid
     */
    validRouteName(route: string): boolean;
    /**
     * Convert milliseconds into a statement describing the elapsed time
     *
     * @param milliseconds to convert
     * @returns elapsed time
     */
    getElapsedTime(milliseconds: number): string;
    /**
     * Convert milliseconds to a local timestamp
     *
     * @param milliseconds to convert
     * @returns local timestamp
     */
    getLocalTimestamp(milliseconds?: number): string;
    /**
     * Convert simple time format into seconds
     *
     * @param duration in simple time format ending s, m, h, d
     * @returns number of seconds
     */
    getDurationInSeconds(duration: string): number;
    /**
     * Load a YAML file as a multi-level map
     *
     * @param filePath to the YAML file
     * @returns a multi-level map
     */
    loadYamlFile(filePath: string): MultiLevelMap;
    /**
     * Detect and convert from Windows to Unix file path
     *
     * @param filePath that may use Windows backslash format
     * @returns normalized file path in Unix format
     */
    normalizeFilePath(filePath: string): string;
    /**
     * Create a directory if not exists
     *
     * @param path of directory to create
     */
    mkdirsIfNotExist(path: string): void;
    /**
     * Split a text string into an array of elements
     *
     * @param text string
     * @param chars as separators
     * @param empty if true, returns empty elements else skip them
     * @returns array of separated text string
     */
    split(text: string, chars: string, empty?: boolean): string[];
    /**
     * DO NOT call this function directly in your applicaton code.
     *
     * This function is reserved for system use because the folder is relative
     * to the Utility class in the library.
     *
     * @param relativePath relative to the Utility class
     * @returns a fully qualified folder path
     */
    getFolder(relativePath: string): string;
}
