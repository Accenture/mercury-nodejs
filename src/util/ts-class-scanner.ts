import fs from 'fs';
import { Utility } from './utility.js';

const util = new Utility();
const EXPORT_TAG = 'export ';

export class ClassScanUtility {
    static getParams(text: string): Array<string> {
        const start = text.indexOf('(');
        const end = text.indexOf(')');
        if (end > start) {
            const inner = text.substring(start+1, end);
            return inner.split(',').map(v => v.trim()).filter(v => v);
        } else {
            return [];
        }
    }

    static list2str(list: Array<string>): string {
        let result = '';
        for (const item of list) {
            result += item;
            result += ', ';
        }
        return result.length > 2? result.substring(0, result.length-2) : result;
    }
}

export class TypeScriptClassScanner {

    private sourceFolder: string;
    private methodAnnotation: string;
    private clsMap = {};
    private clsParents = {};
    private clsParameters = {};
    private clsMethods = {};

    constructor(sourceFolder: string, methodAnnotation: string) {
        this.sourceFolder = sourceFolder? sourceFolder : 'null/';
        this.methodAnnotation = methodAnnotation? `@${methodAnnotation}` : '@undefined';
    }

    async scan() {
        await this.scanSource(this.sourceFolder);
        return {'classes': this.clsMap, 'parents': this.clsParents, 'parameters': this.clsParameters, 'methods': this.clsMethods};
    }

    private async scanSource(parent: string, folder?: string) {
        const target = folder? folder : parent;
        const files = await fs.promises.readdir(target);
        for (const f of files) {
            const path = target + '/' + f;
            const stat = await fs.promises.stat(path);
            if (stat.isDirectory()) {
                await this.scanSource(parent, path);
            } else {
                if (f.endsWith('.ts') && !f.endsWith('.d.ts')) {
                    const clsList = await this.getSourceFile(path);
                    if (clsList.length > 0) {
                        const relativePath = `..${path.substring(parent.length, path.length-3)}.js`;
                        this.clsMap[ClassScanUtility.list2str(clsList)] = relativePath;
                    }
                }            
            }
        }
    }

    private async getSourceFile(path: string) {
        const content = await fs.promises.readFile(path, 'utf-8');
        const lines = content.split('\n').map(v => v.trim()).filter(v => v);
        const clsList = [];
        const metadataStore = [];
        let clsName = null;
        let parents: object;
        let signature = EXPORT_TAG;        
        for (const line of lines) {
            if (line.startsWith('//')) {
                continue;
            }
            if (EXPORT_TAG == signature) {
                if (line.startsWith(signature)) {
                    const parts = util.split(line, ', {');
                    if (parts.length >= 3 && 'class' == parts[1]) {
                        clsName = parts[2];
                        signature = this.methodAnnotation;
                        if (parts.length > 3) {
                            const inheritance = [];
                            for (let i=3; i < parts.length; i++) {
                                inheritance.push(parts[i]);
                            }
                            const extendsParents = [];
                            const implementsParents = [];
                            let mode = '';
                            if (inheritance.length > 0) {
                                for (let i=0; i < inheritance.length; i++) {
                                    if (inheritance[i] == 'extends') {
                                        mode = 'extends';
                                        continue;
                                    } else if (inheritance[i] == 'implements') {
                                        mode = 'implements';
                                        continue;
                                    } else if ('extends' == mode) {
                                        extendsParents.push(inheritance[i]);
                                    } else if ('implements' == mode) {
                                        implementsParents.push(inheritance[i]);
                                    }
                                }
                            }
                            parents = {'extends': extendsParents, 'implements': implementsParents};
                        }
                    }
                }
            } else if (this.methodAnnotation == signature && line.startsWith(this.methodAnnotation) && line.includes('(') && line.includes(')')) {
                metadataStore.push(ClassScanUtility.getParams(line));
            } else if (this.methodAnnotation == signature && metadataStore.length > 0 && clsName && line.includes('(') && line.includes(')')) {
                const parts = util.split(line, '() :{');
                if (parts.length > 0) {
                    clsList.push(clsName);
                    const metadata = metadataStore.pop();
                    if (metadata) {
                        this.clsParameters[clsName] = metadata;
                    }
                    if (parents) {
                        this.clsParents[clsName] = parents;
                    }
                    this.clsMethods[clsName] = parts[0];
                    clsName = null;
                    parents = null;
                    signature = EXPORT_TAG;
                }            
            }
        }
        return clsList;
    }
}
