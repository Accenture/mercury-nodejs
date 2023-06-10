import fs from 'fs';
import { fileURLToPath } from "url";
export class TemplateLoader {
    templateFolder;
    constructor() {
        const folder = fileURLToPath(new URL("../resources/templates/", import.meta.url));
        this.templateFolder = folder.includes('\\') ? folder.replaceAll('\\', '/') : folder;
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