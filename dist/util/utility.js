import { v4 as uuid4 } from 'uuid';
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
}
//# sourceMappingURL=utility.js.map