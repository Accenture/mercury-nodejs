import fs from 'fs';
import { fileURLToPath } from "url";
import { v4 as uuid4 } from 'uuid';
import { parse as parseYaml } from 'yaml';
import { MultiLevelMap } from './multi-level-map.js';
const ONE_SECOND_MS = BigInt(1000);
const ONE_MINUTE_MS = BigInt(60) * ONE_SECOND_MS;
const ONE_HOUR_MS = BigInt(60) * ONE_MINUTE_MS;
const ONE_DAY_MS = BigInt(24) * ONE_HOUR_MS;
const ONE_MINUTE = 60;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;
export class Utility {
    /**
     * Generate UUID without hyphen characters
     *
     * @returns unique ID
     */
    getUuid() {
        return uuid4().replaceAll('-', '');
    }
    getUuid4() {
        return uuid4();
    }
    /**
     * sleep for a short time in a non-blocking fashion
     *
     * @param milliseconds to sleep
     * @returns promise
     */
    sleep(milliseconds = 1000) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve(milliseconds);
            }, Math.max(0, milliseconds));
        });
    }
    /**
     * Format a floating point number to 3 decimal points
     *
     * @param n is the number
     * @param decimalPoint default 3
     * @returns formatted floating point number
     */
    getFloat(n, decimalPoint = 3) {
        return n && n.constructor == Number ? parseFloat(n.toFixed(decimalPoint)) : 0.0;
    }
    htmlEscape(text) {
        return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
    /**
     * Convert a text string into a number
     *
     * @param s is the text string containing a number
     * @returns integer value
     */
    str2int(s) {
        if (s) {
            const v = parseInt(s);
            return isNaN(v) ? -1 : v;
        }
        else {
            return -1;
        }
    }
    /**
     * Convert a text string into a floating point number
     *
     * @param s is the text string containing a number
     * @returns floating point number
     */
    str2float(s) {
        if (s) {
            const v = parseFloat(s);
            return isNaN(v) ? -1 : v;
        }
        else {
            return -1;
        }
    }
    bytesToBase64(b) {
        return b.toString('base64');
    }
    base64ToBytes(b64Text) {
        return Buffer.from(b64Text, 'base64');
    }
    /**
     * Test if the text string contains only digits
     *
     * @param text string to be tested
     * @returns true if numbers
     */
    isDigits(text) {
        for (let i = 0; i < text.length; i++) {
            if (text.charAt(i) >= '0' && text.charAt(i) <= '9')
                continue;
            return false;
        }
        return true;
    }
    isNumeric(text) {
        if (text) {
            if (text.length > 1 && text.startsWith("-")) {
                return this.isDigits(text.substring(1));
            }
            else {
                return this.isDigits(text);
            }
        }
        else {
            return false;
        }
    }
    /**
     * Check if the given route name is in valid format
     *
     * @param route name
     * @returns true if valid
     */
    validRouteName(route) {
        if (route) {
            if (route.startsWith(".") || route.startsWith("_") || route.startsWith("-") || route.includes("..") ||
                route.endsWith(".") || route.endsWith("_") || route.endsWith("-"))
                return false;
            for (let i = 0; i < route.length; i++) {
                if (route.charAt(i) >= '0' && route.charAt(i) <= '9')
                    continue;
                if (route.charAt(i) >= 'a' && route.charAt(i) <= 'z')
                    continue;
                if (route.charAt(i) == '.' || route.charAt(i) == '_' || route.charAt(i) == '-')
                    continue;
                return false;
            }
            return route.includes('.');
        }
        else {
            return false;
        }
    }
    /**
     * Convert milliseconds into a statement describing the elapsed time
     *
     * @param milliseconds to convert
     * @returns elapsed time
     */
    getElapsedTime(milliseconds) {
        let sb = '';
        let time = BigInt(Math.round(milliseconds));
        if (time > ONE_DAY_MS) {
            const days = time / ONE_DAY_MS;
            sb += days;
            sb += (days == 1n ? " day " : " days ");
            time -= days * ONE_DAY_MS;
        }
        if (time > ONE_HOUR_MS) {
            const hours = time / ONE_HOUR_MS;
            sb += hours;
            sb += (hours == 1n ? " hour " : " hours ");
            time -= hours * ONE_HOUR_MS;
        }
        if (time > ONE_MINUTE_MS) {
            const minutes = time / ONE_MINUTE_MS;
            sb += minutes;
            sb += (minutes == 1n ? " minute " : " minutes ");
            time -= minutes * ONE_MINUTE_MS;
        }
        if (time >= ONE_SECOND_MS) {
            const seconds = time / ONE_SECOND_MS;
            sb += seconds;
            sb += (seconds == 1n ? " second" : " seconds");
        }
        return sb.length == 0 ? time + " ms" : sb.trim();
    }
    /**
     * Convert milliseconds to a local timestamp
     *
     * @param milliseconds to convert
     * @returns local timestamp
     */
    getLocalTimestamp(milliseconds) {
        const now = milliseconds ? new Date(milliseconds) : new Date();
        const offset = now.getTimezoneOffset() * 60 * 1000;
        const ms = now.getTime();
        return new Date(ms - offset).toISOString().replace('T', ' ').replace('Z', '');
    }
    /**
     * Convert simple time format into seconds
     *
     * @param duration in simple time format ending s, m, h, d
     * @returns number of seconds
     */
    getDurationInSeconds(duration) {
        let multiplier = 1;
        let n;
        if (duration.endsWith("s") || duration.endsWith("m") || duration.endsWith("h") || duration.endsWith("d")) {
            n = this.str2int(duration.substring(0, duration.length - 1).trim());
            if (duration.endsWith("m")) {
                multiplier = ONE_MINUTE;
            }
            if (duration.endsWith("h")) {
                multiplier = ONE_HOUR;
            }
            if (duration.endsWith("d")) {
                multiplier = ONE_DAY;
            }
        }
        else {
            n = this.str2int(duration);
        }
        return n * multiplier;
    }
    /**
     * Load a YAML file as a multi-level map
     *
     * @param filePath to the YAML file
     * @returns a multi-level map
     */
    loadYamlFile(filePath) {
        if (filePath) {
            const normalizedPath = this.normalizeFilePath(filePath);
            const fileExists = fs.existsSync(normalizedPath);
            if (fileExists) {
                const fileContent = fs.readFileSync(normalizedPath, { encoding: 'utf-8', flag: 'r' });
                return new MultiLevelMap(parseYaml(fileContent)).normalizeMap();
            }
            else {
                throw new Error(`${filePath} does not exist`);
            }
        }
        throw new Error('Missing file path');
    }
    /**
     * Detect and convert from Windows to Unix file path
     *
     * @param filePath that may use Windows backslash format
     * @returns normalized file path in Unix format
     */
    normalizeFilePath(filePath) {
        const fPath = filePath.includes('\\') ? filePath.replace(/\\/g, '/') : filePath;
        const colon = fPath.indexOf(':');
        return colon == 1 ? fPath.substring(2) : fPath;
    }
    getDecodedUri(uriPath) {
        if (uriPath == null) {
            return "/";
        }
        else {
            // Decode URI escape characters
            const uri = uriPath.includes("%") ? decodeURI(uriPath) : uriPath;
            // Avoid "path traversal" attack
            return uri.replace(/\\/g, '/').replace(/\.\.\//g, '');
        }
    }
    /**
     * Create a directory if not exists
     *
     * @param path of directory to create
     */
    mkdirsIfNotExist(path) {
        if (path) {
            const filePath = this.normalizeFilePath(path);
            const parts = filePath.split('/').map(v => v.trim()).filter(v => v.length > 0 && !v.includes(':'));
            if (parts.length > 0) {
                let folder = '';
                for (const p of parts) {
                    folder += ('/' + p);
                    if (!fs.existsSync(folder)) {
                        fs.mkdirSync(folder);
                    }
                    else {
                        const file = fs.statSync(folder);
                        if (!file.isDirectory) {
                            throw new Error(`Unable to create ${path} - ${folder} is not a directory`);
                        }
                    }
                }
            }
        }
    }
    /**
     * Check if a file path is a directory
     *
     * @param filePath to the directory
     * @returns true if the directory exists
     */
    isDirectory(filePath) {
        try {
            const stats = fs.statSync(filePath);
            return stats.isDirectory();
        }
        catch (_e) {
            // file not found
            return false;
        }
    }
    async file2bytes(filePath) {
        if (fs.existsSync(filePath) && !this.isDirectory(filePath)) {
            return await fs.promises.readFile(filePath);
        }
        else {
            return Buffer.from('');
        }
    }
    async bytes2file(filePath, b) {
        const content = await this.file2bytes(filePath);
        if (!content.equals(b)) {
            await fs.promises.writeFile(filePath, b);
        }
    }
    async file2str(filePath) {
        if (fs.existsSync(filePath) && !this.isDirectory(filePath)) {
            return await fs.promises.readFile(filePath, { encoding: 'utf-8', flag: 'r' });
        }
        else {
            return '';
        }
    }
    async str2file(filePath, text) {
        const content = await this.file2str(filePath);
        if (content != text) {
            await fs.promises.writeFile(filePath, text);
        }
    }
    /**
     * Split a text string into an array of elements
     *
     * @param text string
     * @param chars as separators
     * @param empty if true, returns empty elements else skip them
     * @returns array of separated text string
     */
    split(text, chars, empty = false) {
        const result = [];
        if (text && chars) {
            let sb = '';
            for (const i of text) {
                let found = false;
                for (const j of chars) {
                    if (i == j) {
                        if (sb.length > 0) {
                            result.push(sb);
                        }
                        else if (empty) {
                            result.push('');
                        }
                        sb = '';
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    sb += i;
                }
            }
            if (sb.length > 0) {
                result.push(sb);
            }
        }
        return result;
    }
    /**
     * DO NOT call this function directly in your applicaton code.
     *
     * This function is reserved for system use because the folder is relative
     * to the Utility class in the library.
     *
     * @param relativePath relative to the Utility class
     * @returns a fully qualified folder path
     */
    getFolder(relativePath) {
        const folder = fileURLToPath(new URL(relativePath, import.meta.url));
        // for windows OS, convert backslash to regular slash and drop drive letter from path
        const fPath = folder.includes('\\') ? folder.replaceAll('\\', '/') : folder;
        const colon = fPath.indexOf(':');
        return colon == 1 ? fPath.substring(colon + 1) : fPath;
    }
}
//# sourceMappingURL=utility.js.map