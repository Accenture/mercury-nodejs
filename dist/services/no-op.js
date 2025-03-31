import { __decorate } from "tslib";
import { preload } from '../models/composable.js';
export class NoOp {
    initialize() {
        return this;
    }
    async handleEvent(evt) {
        return evt;
    }
}
__decorate([
    preload('no.op', 50)
], NoOp.prototype, "initialize", null);
//# sourceMappingURL=no-op.js.map