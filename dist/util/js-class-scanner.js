import fs from 'fs';
import { Utility } from './utility.js';
import { ClassScanUtility } from './ts-class-scanner.js';
const util = new Utility();
export class JavaScriptClassScanner {
    parentFolder;
    jsFolder;
    methodAnnotation;
    clsMap = {};
    clsParameters = {};
    clsMethods = {};
    constructor(parentFolder, jsFolder, methodAnnotation) {
        this.parentFolder = parentFolder ? parentFolder : 'null/';
        this.jsFolder = this.parentFolder + (jsFolder ? jsFolder : 'null');
        this.methodAnnotation = methodAnnotation ? `${methodAnnotation}(` : 'undefined(';
    }
    async scan() {
        await this.scanJs(this.parentFolder, this.jsFolder);
        return { 'classes': this.clsMap, 'parameters': this.clsParameters, 'methods': this.clsMethods };
    }
    async scanJs(parent, folder) {
        const files = await fs.promises.readdir(folder);
        for (const f of files) {
            const path = `${folder}/${f}`;
            const stat = await fs.promises.stat(path);
            if (stat.isDirectory()) {
                await this.scanJs(parent, path);
            }
            else {
                if (f.endsWith('.js')) {
                    const content = await fs.promises.readFile(path, 'utf-8');
                    const parameterBlocks = new Array();
                    const classBlocks = [];
                    const lines = util.split(content, '\r\n');
                    let hasDecorators = false;
                    let hasPreload = false;
                    for (const line of lines) {
                        const text = line.trim();
                        if (!text.startsWith('//')) {
                            if (!hasDecorators && text.startsWith('__decorate([')) {
                                hasDecorators = true;
                                continue;
                            }
                            if (hasDecorators && text.startsWith(this.methodAnnotation)) {
                                parameterBlocks.push(text);
                                hasPreload = true;
                                continue;
                            }
                            if (hasPreload && text.startsWith('],')) {
                                classBlocks.push(text);
                                hasDecorators = false;
                                hasPreload = false;
                            }
                        }
                    }
                    const clsList = [];
                    if (parameterBlocks.length == classBlocks.length) {
                        for (let i = 0; i < classBlocks.length; i++) {
                            const block = classBlocks[i];
                            const parameters = parameterBlocks[i];
                            const preloadParams = util.split(parameters, '(, \'")');
                            if (block.includes('.prototype') && preloadParams.length > 1) {
                                const elements = util.split(block, '], ";)');
                                if (elements.length > 1 && elements[0].endsWith('.prototype')) {
                                    const clsName = elements[0].substring(0, elements[0].lastIndexOf('.'));
                                    clsList.push(clsName);
                                    this.clsParameters[clsName] = ClassScanUtility.getParams(parameters);
                                    this.clsMethods[clsName] = elements[1];
                                }
                            }
                        }
                    }
                    if (clsList.length > 0) {
                        const relativePath = `../${path.substring(parent.length)}`;
                        this.clsMap[ClassScanUtility.list2str(clsList)] = relativePath;
                    }
                }
            }
        }
    }
}
//# sourceMappingURL=js-class-scanner.js.map