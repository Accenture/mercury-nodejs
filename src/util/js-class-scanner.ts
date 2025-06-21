import fs from 'fs';
import { Utility } from './utility.js';
import { ClassScanUtility } from './ts-class-scanner.js';

const util = new Utility();

function scanDecorator(content: string, methodAnnotation: string): DecoratorMetadata {
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

function scanPrototype(parent: string, path: string, md: DecoratorMetadata, clsParameters: object, clsMethods: object, clsMap: object) {
    const clsList = new Array<string>();
    if (md.parameterBlocks.length == md.classBlocks.length) {
        for (let i=0; i < md.classBlocks.length; i++) {
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
        const relativePath = `../${path.substring(parent.length)}`;
        clsMap[ClassScanUtility.list2str(clsList)] = relativePath;                  
    }     
}

class DecoratorMetadata {
    parameterBlocks = new Array<string>();
    classBlocks = new Array<string>();
    hasDecorators = false;
    hasPreload = false;
}

export class JavaScriptClassScanner {
    private readonly parentFolder: string;
    private readonly jsFolder: string;
    private readonly methodAnnotation: string;
    private readonly clsMap = {};
    private readonly clsParameters = {};
    private readonly clsMethods = {};

    constructor(parentFolder: string, jsFolder: string, methodAnnotation: string) {
        this.parentFolder = parentFolder || 'null/';
        this.jsFolder = this.parentFolder + (jsFolder || 'null');
        this.methodAnnotation = methodAnnotation? `${methodAnnotation}(` : 'undefined(';
    }

    async scan() {
        await this.scanJs(this.parentFolder, this.jsFolder);
        return {'classes': this.clsMap, 'parameters': this.clsParameters, 'methods': this.clsMethods};
    }

    private async scanJs(parent: string, folder?: string) {
        const files = await fs.promises.readdir(folder);
        for (const f of files) {
            const path = `${folder}/${f}`;
            const stat = await fs.promises.stat(path);
            if (stat.isDirectory()) {
                await this.scanJs(parent, path);
            } else if (f.endsWith('.js')) {
                const content = await fs.promises.readFile(path, 'utf-8');
                const md = scanDecorator(content, this.methodAnnotation);
                scanPrototype(parent, path, md, this.clsParameters, this.clsMethods, this.clsMap);              
            }
        }
    }
}
