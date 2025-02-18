import fs from 'fs';
import { Utility } from '../util/utility.js';
const util = new Utility();
/**
 * This is reserved for system use.
 * DO NOT use this directly in your application code.
 */
export class TemplateLoader {
    templateFolder;
    constructor() {
        if (this.templateFolder === undefined) {
            this.templateFolder = util.getFolder("../resources/templates/");
        }
    }
    getTemplate(name) {
        const template = this.templateFolder + name;
        if (fs.existsSync(template)) {
            return fs.readFileSync(template, { encoding: 'utf-8', flag: 'r' });
        }
        else {
            return null;
        }
    }
}
//# sourceMappingURL=template-loader.js.map