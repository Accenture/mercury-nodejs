import fs from 'fs';
import { Utility } from '../util/utility.js';
const util = new Utility();
export class TemplateLoader {
    templateFolder;
    constructor() {
        this.templateFolder = util.getFolder("../resources/templates/");
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