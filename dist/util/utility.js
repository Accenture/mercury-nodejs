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
    str2int(s) {
        if (s) {
            const v = parseInt(s);
            return isNaN(v) ? 0 : v;
        }
        else {
            return 0;
        }
    }
    str2float(s) {
        if (s) {
            const v = parseFloat(s);
            return isNaN(v) ? 0 : v;
        }
        else {
            return 0;
        }
    }
    isDigits(text) {
        for (let i = 0; i < text.length; i++) {
            if (text.charAt(i) >= '0' && text.charAt(i) <= '9')
                continue;
            return false;
        }
        return true;
    }
    validRouteName(route) {
        if (route == null || route.length == 0)
            return false;
        if (route.startsWith(".") || route.startsWith("_") || route.startsWith("-")
            || route.includes("..")
            || route.endsWith(".") || route.endsWith("_") || route.endsWith("-"))
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
    getLocalTimestamp(milliseconds) {
        const now = milliseconds ? new Date(milliseconds) : new Date();
        const offset = now.getTimezoneOffset() * 60 * 1000;
        const ms = now.getTime();
        return new Date(ms - offset).toISOString().replace('T', ' ').replace('Z', '');
    }
    getDurationInSeconds(duration) {
        let multiplier = 1;
        let n;
        if (duration.endsWith("s") || duration.endsWith("m") || duration.endsWith("h") || duration.endsWith("d")) {
            n = this.str2int(duration.substring(0, duration.length - 1));
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
    // for consistency between Windows, Mac and Linux, use "forward" slash
    normalizeFilePath(filePath) {
        return filePath.includes('\\') ? filePath.replaceAll('\\', '/') : filePath;
    }
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
                        console.log("Created " + folder);
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
    getFolder(relativePath) {
        const folder = fileURLToPath(new URL(relativePath, import.meta.url));
        // for windows OS, convert backslash to regular slash and drop drive letter from path
        const path = folder.includes('\\') ? folder.replaceAll('\\', '/') : folder;
        const colon = path.indexOf(':');
        return colon == 1 ? path.substring(colon + 1) : path;
    }
}
//# sourceMappingURL=utility.js.map