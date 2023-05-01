import { v4 as uuid4 } from 'uuid';

let self: Util = null;

export class Utility {

    constructor() {
        if (self == null) {
            self = new Util();
        }
    }
  
    getInstance(): Util {
        return self;
    }
}

class Util {

    getUuid(): string {
        return uuid4().replace(new RegExp('-', 'g'), '');
    }

    sleep(milliseconds = 1000) {
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve(milliseconds);
            }, Math.max(0, milliseconds));
        });
    }

    getFloat(n: number, decimalPoint = 3): number {
        return n && n.constructor == Number? parseFloat(n.toFixed(decimalPoint)) : 0.0;
    }

}