import { __decorate } from "tslib";
import { preload } from '../models/composable.js';
export class NoOp {
    name = "no.op";
    initialize() {
        // no-op
    }
    getName() {
        return this.name;
    }
    async handleEvent(evt) {
        return evt;
    }
}
__decorate([
    preload(10)
], NoOp.prototype, "initialize", null);
//# sourceMappingURL=no-op.js.map