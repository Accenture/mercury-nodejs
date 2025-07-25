import fs from 'fs';
import { Utility } from './utility.js';
import { ClassScanUtility } from './ts-class-scanner.js';
const util = new Utility();
function scanDecorator(content, methodAnnotation) {
    const md = new DecoratorMetadata();
    const lines = util.split(content, '\r\n');
    for (const line of lines) {
        const text = line.trim();
        if (!text.startsWith('//')) {
            if (!md.hasDecorators && text.startsWith('__decorate([')) {
                md.hasDecorators = true;
                continue;
            }
            if (md.hasDecorators && text.startsWith(methodAnnotation)) {
                md.parameterBlocks.push(text);
                md.hasPreload = true;
                continue;
            }
            if (md.hasPreload && text.startsWith('],')) {
                md.classBlocks.push(text);
                md.hasDecorators = false;
                md.hasPreload = false;
            }
        }
    }
    return md;
}
function scanPrototype(parent, filePath, md, clsParameters, clsMethods, clsMap) {
    const clsList = new Array();
    if (md.parameterBlocks.length == md.classBlocks.length) {
        for (let i = 0; i < md.classBlocks.length; i++) {
            const block = md.classBlocks[i];
            const parameters = md.parameterBlocks[i];
            const preloadParams = util.split(parameters, '(, \'")');
            if (block.includes('.prototype') && preloadParams.length > 1) {
                const elements = util.split(block, '], ";)');
                if (elements.length > 1 && elements[0].endsWith('.prototype')) {
                    const clsName = elements[0].substring(0, elements[0].lastIndexOf('.'));
                    clsList.push(clsName);
                    clsParameters[clsName] = ClassScanUtility.getParams(parameters);
                    clsMethods[clsName] = elements[1];
                }
            }
        }
    }
    if (clsList.length > 0) {
        const relativePath = `${filePath.substring(parent.length)}`;
        clsMap[ClassScanUtility.list2str(clsList)] = relativePath;
    }
}
class DecoratorMetadata {
    parameterBlocks = new Array();
    classBlocks = new Array();
    hasDecorators = false;
    hasPreload = false;
}
export class JavaScriptClassScanner {
    parentFolder;
    jsFolder;
    methodAnnotation;
    clsMap = {};
    clsParameters = {};
    clsMethods = {};
    constructor(parentFolder, jsFolder, methodAnnotation) {
        this.parentFolder = parentFolder || 'null/';
        this.jsFolder = this.parentFolder + (jsFolder || 'null');
        this.methodAnnotation = methodAnnotation ? `${methodAnnotation}(` : 'undefined(';
    }
    async scan() {
        await this.scanJs(this.parentFolder, this.jsFolder);
        return { 'classes': this.clsMap, 'parameters': this.clsParameters, 'methods': this.clsMethods };
    }
    async scanJs(parent, folder) {
        const files = await fs.promises.readdir(folder);
        for (const f of files) {
            const filePath = `${folder}/${f}`;
            const stat = await fs.promises.stat(filePath);
            if (stat.isDirectory()) {
                await this.scanJs(parent, filePath);
            }
            else if (f.endsWith('.js')) {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const md = scanDecorator(content, this.methodAnnotation);
                scanPrototype(parent, filePath, md, this.clsParameters, this.clsMethods, this.clsMap);
            }
        }
    }
}
//# sourceMappingURL=js-class-scanner.js.map