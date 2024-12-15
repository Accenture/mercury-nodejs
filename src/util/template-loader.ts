import fs from 'fs';
import { Utility } from '../util/utility.js';

const util = new Utility();

export class TemplateLoader {

    private templateFolder: string;

    constructor() {
        this.templateFolder = util.getFolder("../resources/templates/");
    }

    getTemplate(name: string): string {
        const template = this.templateFolder + name;
        if (fs.existsSync(template)) {
            return fs.readFileSync(template, {encoding:'utf-8', flag:'r'});
        } else {
            return null;
        }
    }
}