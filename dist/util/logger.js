import { Utility } from '../util/utility.js';
const util = new Utility();
let isDebug = false;
let isInfo = true;
let isWarn = true;
let isError = true;
function getLineNumber() {
    const stack = new Error().stack;
    const lines = stack.split('\n').filter(v => String(v).trim().startsWith('at '));
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
function printLog(format, lineNumber, label, message, e) {
    const timestamp = util.getLocalTimestamp();
    if (format == 0) {
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
    else {
        const text = { 'time': timestamp, 'level': label, 'message': message };
        if (lineNumber) {
            text['source'] = lineNumber;
        }
        if (e) {
            const stack = e.stack ? e.stack : String(e);
            text['stack'] = util.split(stack, '\r\n');
        }
        if (format == 1) {
            // compact line feed if any
            console.log(JSON.stringify(text));
        }
        else {
            // pretty print
            console.log(JSON.stringify(text, null, 2));
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
    /**
     * This method is reserved by the platform.
     * Do not use this directly.
     *
     * @param format is 0 (text), 1 (compact), 2 (json)
     */
    setLogFormat(format) {
        this.logger.setLogFormat(format);
    }
    /**
     * Retreive the log level (info, warn, error, debug)
     * @returns log level
     */
    getLevel() {
        return this.logger.getLevel();
    }
    /**
     * Set the log level (info, warn, error, debug)
     *
     * @param level to set
     */
    setLevel(level) {
        this.logger.setLevel(level);
    }
    /**
     * Log a message in info level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    info(message, e) {
        if (isInfo) {
            this.logger.info(getLineNumber(), message, e);
        }
    }
    /**
     * Log a message in warning level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    warn(message, e) {
        if (isWarn) {
            this.logger.warn(getLineNumber(), message, e);
        }
    }
    /**
     * Log a message in debug level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    debug(message, e) {
        if (isDebug) {
            this.logger.debug(getLineNumber(), message, e);
        }
    }
    /**
     * Log a message in error level
     *
     * @param message as text or JSON object
     * @param e optional exception object
     */
    error(message, e) {
        if (isError) {
            this.logger.error(getLineNumber(), message, e);
        }
    }
}
class SimpleLogger {
    logLevel = 'info';
    logFormat = 0;
    constructor() {
        if (process) {
            const level = process.env.LOG_LEVEL;
            if (level && this.validLevel(level)) {
                this.setLevel(level);
            }
        }
    }
    /**
     * Set log format
     *
     * @param format is 0 (text), 1 (compact), 2 (json)
     */
    setLogFormat(format) {
        this.logFormat = format >= 0 && format < 3 ? format : 0;
    }
    getLevel() {
        return this.logLevel;
    }
    setLevel(level) {
        if (level) {
            const value = String(level).toLowerCase();
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
        const value = String(level).toLowerCase();
        return value && ('all' == value || 'debug' == value || 'info' == value || 'warn' == value || 'error' == value);
    }
    info(lineNumber, message, e) {
        printLog(this.logFormat, lineNumber, 'INFO', message, e);
    }
    warn(lineNumber, message, e) {
        printLog(this.logFormat, lineNumber, 'WARN', message, e);
    }
    debug(lineNumber, message, e) {
        printLog(this.logFormat, lineNumber, 'DEBUG', message, e);
    }
    error(lineNumber, message, e) {
        printLog(this.logFormat, lineNumber, 'ERROR', message, e);
    }
}
//# sourceMappingURL=logger.js.map