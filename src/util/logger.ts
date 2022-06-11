import logger from 'simple-node-logger';

const OPTS = { timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS' };
const LOG = logger.createSimpleLogger(OPTS);

let isDebug = true;
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
        return ' [' + method + ':' + filename + ':' + lineNumber + ']';
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

let self: LogSystem = null;

export class Logger {

    constructor() {
        if (self == null) {
            self = new LogSystem();
        }
    }
  
    getInstance(): LogSystem {
        return self;
    }
}

class LogSystem {

    private logLevel = 'info';

    constructor() {
        const level = process.env.LOG_LEVEL;
        if (level && this.validLevel(level)) {
            this.setLevel(level);
        }
    }

    validLevel(level: string): boolean {
        const value = level.toString().toLowerCase();
        return value && ('all' == value || 'debug' == value || 'info' == value || 'warn' == value || 'error' == value);
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

    info(message: string | object, e?: Error): void {
        if (isInfo) {
            const text = getText(message);
            if (e && e instanceof Error) {
                LOG.info(text + getLineNumber() + '\n' + e.stack);
            } else {
                LOG.info(text + getLineNumber());
            }
        }
    }

    warn(message: string | object, e?: Error): void {
        if (isWarn) {
            const text = getText(message);
            if (e && e instanceof Error) {
                LOG.warn(text + getLineNumber() + '\n' + e.stack);
            } else {
                LOG.warn(text + getLineNumber());
            }
        }
    }

    debug(message: string | object, e?: Error): void {
        if (isDebug) {
            const text = getText(message);
            if (e && e instanceof Error) {
                LOG.debug(text + getLineNumber() + '\n' + e.stack);
            } else {
                LOG.debug(text + getLineNumber());
            }
        }
    }

    error(message: string | object, e?: Error): void {
        if (isError) {
            const text = getText(message);
            if (e && e instanceof Error) {
                LOG.error(text + getLineNumber() + '\n' + e.stack);
            } else {
                LOG.error(text + getLineNumber());
            }
        }
    }

}


