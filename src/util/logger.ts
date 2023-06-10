
import { Utility } from '../util/utility.js';

const util = new Utility();

let self: SimpleLogger = null;
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
        return (method? method + ':' : '')  + filename + ':' + lineNumber;
    } else {
        // Incomplete stack trace -
        // This happens when logger is used as the only argument in a promise like ".then(log.info)"
        return '';
    }
}

function getText(message: string | object) {
    if (message) {
        if (message instanceof Object) {
            return JSON.stringify(message);
        } else {
            return String(message);
        }
    } else {
        return '';
    }
}

function printLog(jsonFormat: boolean, lineNumber: string, label: string, message: string | object, e?: Error) {
    const timestamp = util.getLocalTimestamp();
    if (jsonFormat) {
        const json = {'time': timestamp, 'level': label, 'message': message};
        if (lineNumber) {
            json['module'] = lineNumber;
        }
        if (e) {
            const stack = e.stack? e.stack : String(e);
            json['exception'] = stack.split('\n').map(v => v.trim());
        }
        console.log(JSON.stringify(json, null, 2));
    } else {
        const text = getText(message);
        const location = lineNumber? ' (' + lineNumber + ')': '';
        if (e) {
            const stack = e.stack? e.stack : String(e);
            console.info(timestamp + ' ' + label + ' ' + text + location + '\n' + stack);
        } else {
            console.info(timestamp + ' ' + label + ' ' + text + location);
        }
    }
}

export class Logger {

    constructor() {
        if (self == null) {
            self = new SimpleLogger();
        }
    }

    setJsonFormat(jsonFormat: boolean) {
        self.setJsonFormat(jsonFormat);
    }

    getLevel(): string {
        return self.getLevel();
    }

    setLevel(level: string): void {
        self.setLevel(level);
    }

    info(message: string | object, e?: Error): void {
        if (isInfo) {
            self.info(getLineNumber(), message, e);
        }
    }

    warn(message: string | object, e?: Error): void {
        if (isWarn) {
            self.warn(getLineNumber(), message, e);
        }
    }

    debug(message: string | object, e?: Error): void {
        if (isDebug) {
            self.debug(getLineNumber(), message, e);
        }        
    }

    error(message: string | object, e?: Error): void {
        if (isError) {
            self.error(getLineNumber(), message, e);
        }
    }

}

class SimpleLogger {

    private logLevel = 'info';
    private logAsJson = false;

    constructor() {
        if (process) {
            const level = process.env.LOG_LEVEL;
            if (level && this.validLevel(level)) {
                this.setLevel(level);
            }
        }
    }   
    
    setJsonFormat(jsonFormat: boolean) {
        this.logAsJson = jsonFormat;
    }

    getLevel(): string {
        return this.logLevel;
    }

    setLevel(level: string): void {
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

    validLevel(level: string): boolean {
        const value = level.toString().toLowerCase();
        return value && ('all' == value || 'debug' == value || 'info' == value || 'warn' == value || 'error' == value);
    }

    info(lineNumber: string, message: string | object, e?: Error): void {
        printLog(this.logAsJson, lineNumber, 'INFO', message, e);
    }

    warn(lineNumber: string, message: string | object, e?: Error): void {
        printLog(this.logAsJson, lineNumber, 'WARN', message, e);
    }

    debug(lineNumber: string, message: string | object, e?: Error): void {
        printLog(this.logAsJson, lineNumber, 'DEBUG', message, e);
    }

    error(lineNumber: string, message: string | object, e?: Error): void {
        printLog(this.logAsJson, lineNumber, 'ERROR', message, e);
    }

}


