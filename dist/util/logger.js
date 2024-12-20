import { Utility } from '../util/utility.js';
const util = new Utility();
let isDebug = false;
let isInfo = true;
let isWarn = true;
let isError = true;
function getLineNumber() {
    const stack = new Error().stack;
    const lines = stack.split('\n').filter(v => v.toString().trim().startsWith('at '));
    if (lines.length > 2) {
        const elements = lines[2].trim().split(' ');
        const method = elements.length == 2 || elements[1] == 'new' || elements[1].endsWith('<anonymous>') ? '' : elements[1];
        const last = elements.length - 1;
        const parts = elements[last].lastIndexOf('\\') != -1 ? elements[last].split('\\') : elements[last].split('/');
        const composite = parts[parts.length - 1].split(':');
        const filename = composite[0];
        const lineNumber = composite[1];
        return (method ? method + ':' : '') + filename + ':' + lineNumber;
    }
    else {
        // Incomplete stack trace -
        // This happens when logger is used as the only argument in a promise like ".then(log.info)"
        return '';
    }
}
function getText(message) {
    if (message) {
        if (message instanceof Object) {
            return JSON.stringify(message);
        }
        else {
            return String(message);
        }
    }
    else {
        return '';
    }
}
function printLog(jsonFormat, lineNumber, label, message, e) {
    const timestamp = util.getLocalTimestamp();
    if (jsonFormat) {
        const json = { 'time': timestamp, 'level': label, 'message': message };
        if (lineNumber) {
            json['module'] = lineNumber;
        }
        if (e) {
            const stack = e.stack ? e.stack : String(e);
            json['exception'] = stack.split('\n').map(v => v.trim());
        }
        console.log(JSON.stringify(json, null, 2));
    }
    else {
        const text = getText(message);
        const location = lineNumber ? ' (' + lineNumber + ')' : '';
        if (e) {
            const stack = e.stack ? e.stack : String(e);
            console.info(timestamp + ' ' + label + ' ' + text + location + '\n' + stack);
        }
        else {
            console.info(timestamp + ' ' + label + ' ' + text + location);
        }
    }
}
export class Logger {
    static singleton;
    logger;
    constructor() {
        this.logger = new SimpleLogger();
    }
    static getInstance() {
        if (!Logger.singleton) {
            Logger.singleton = new Logger();
        }
        return Logger.singleton;
    }
    setJsonFormat(jsonFormat) {
        this.logger.setJsonFormat(jsonFormat);
    }
    getLevel() {
        return this.logger.getLevel();
    }
    setLevel(level) {
        this.logger.setLevel(level);
    }
    info(message, e) {
        if (isInfo) {
            this.logger.info(getLineNumber(), message, e);
        }
    }
    warn(message, e) {
        if (isWarn) {
            this.logger.warn(getLineNumber(), message, e);
        }
    }
    debug(message, e) {
        if (isDebug) {
            this.logger.debug(getLineNumber(), message, e);
        }
    }
    error(message, e) {
        if (isError) {
            this.logger.error(getLineNumber(), message, e);
        }
    }
}
class SimpleLogger {
    logLevel = 'info';
    logAsJson = false;
    constructor() {
        if (process) {
            const level = process.env.LOG_LEVEL;
            if (level && this.validLevel(level)) {
                this.setLevel(level);
            }
        }
    }
    setJsonFormat(jsonFormat) {
        this.logAsJson = jsonFormat;
    }
    getLevel() {
        return this.logLevel;
    }
    setLevel(level) {
        if (level) {
            const value = level.toString().toLowerCase();
            if (this.validLevel(value)) {
                this.logLevel = value;
            }
            if ('all' == value || 'debug' == value) {
                isDebug = true;
                isInfo = true;
                isWarn = true;
                isError = true;
            }
            if ('info' == value) {
                isDebug = false;
                isInfo = true;
                isWarn = true;
                isError = true;
            }
            if ('warn' == value) {
                isDebug = false;
                isInfo = false;
                isWarn = true;
                isError = true;
            }
            if ('error' == value) {
                isDebug = false;
                isInfo = false;
                isWarn = false;
                isError = true;
            }
        }
    }
    validLevel(level) {
        const value = level.toString().toLowerCase();
        return value && ('all' == value || 'debug' == value || 'info' == value || 'warn' == value || 'error' == value);
    }
    info(lineNumber, message, e) {
        printLog(this.logAsJson, lineNumber, 'INFO', message, e);
    }
    warn(lineNumber, message, e) {
        printLog(this.logAsJson, lineNumber, 'WARN', message, e);
    }
    debug(lineNumber, message, e) {
        printLog(this.logAsJson, lineNumber, 'DEBUG', message, e);
    }
    error(lineNumber, message, e) {
        printLog(this.logAsJson, lineNumber, 'ERROR', message, e);
    }
}
//# sourceMappingURL=logger.js.map