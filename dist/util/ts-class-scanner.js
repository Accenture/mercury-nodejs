import fs from 'fs';
import { Utility } from './utility.js';
const util = new Utility();
const EXPORT_TAG = 'export ';
export class ClassScanUtility {
    static getParams(text) {
        const start = text.indexOf('(');
        const end = text.indexOf(')');
        if (end > start) {
            const inner = text.substring(start + 1, end);
            return util.split(inner, ', ');
        }
        else {
            return new Array();
        }
    }
    static list2str(list) {
        let result = '';
        for (const item of list) {
            result += item;
            result += ', ';
        }
        return result.length > 2 ? result.substring(0, result.length - 2) : result;
    }
}
export class TypeScriptClassScanner {
    parentFolder;
    tsFolder;
    methodAnnotation;
    clsMap = {};
    clsParents = {};
    clsParameters = {};
    clsMethods = {};
    constructor(parentFolder, tsFolder, methodAnnotation) {
        this.parentFolder = parentFolder || 'null/';
        this.tsFolder = this.parentFolder + (tsFolder || 'null');
        this.methodAnnotation = methodAnnotation ? `@${methodAnnotation}` : '@undefined';
    }
    async scan() {
        await this.scanSource(this.parentFolder, this.tsFolder);
        return { 'classes': this.clsMap, 'parents': this.clsParents, 'parameters': this.clsParameters, 'methods': this.clsMethods };
    }
    async scanSource(parent, folder) {
        const files = await fs.promises.readdir(folder);
        for (const f of files) {
            const filePath = `${folder}/${f}`;
            const stat = await fs.promises.stat(filePath);
            if (stat.isDirectory()) {
                await this.scanSource(parent, filePath);
            }
            else if (f.endsWith('.ts') && !f.endsWith('.d.ts')) {
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const lines = content.split('\n').map(v => v.trim()).filter(v => v);
                const clsList = this.scanSourceCode(lines);
                if (clsList.length > 0) {
                    const relativePath = `${filePath.substring(parent.length, filePath.length - 3)}`;
                    this.clsMap[ClassScanUtility.list2str(clsList)] = relativePath;
                }
            }
        }
    }
    scanSourceCode(lines) {
        const clsList = new Array();
        const md = new ClassMetadata();
        for (const line of lines) {
            const statement = this.getAnnotation(line);
            if (statement) {
                if (EXPORT_TAG == md.signature && statement.startsWith(EXPORT_TAG)) {
                    this.parseExportTag(statement, md);
                }
                else if (this.methodAnnotation == md.signature &&
                    statement.startsWith(this.methodAnnotation) &&
                    statement.includes('(') && statement.includes(')')) {
                    md.store.push(ClassScanUtility.getParams(statement));
                }
                else if (this.methodAnnotation == md.signature && md.store.length > 0 &&
                    md.clsName && statement.includes('(') && statement.includes(')')) {
                    const parts = util.split(statement, '() :{');
                    if (parts.length > 0) {
                        this.parseMethod(parts, clsList, md);
                        md.signature = EXPORT_TAG;
                    }
                }
            }
        }
        return clsList;
    }
    getAnnotation(statement) {
        if (statement.startsWith('//')) {
            const text = statement.substring(2).trim();
            if (text.startsWith(this.methodAnnotation)) {
                return text;
            }
            else {
                return null;
            }
        }
        else {
            return statement;
        }
    }
    parseExportTag(line, md) {
        const parts = util.split(line, ', {');
        if (parts.length >= 3 && 'class' == parts[1]) {
            md.clsName = parts[2];
            md.signature = this.methodAnnotation;
            if (parts.length > 3) {
                const inheritance = new Array();
                for (let i = 3; i < parts.length; i++) {
                    inheritance.push(parts[i]);
                }
                const extendsParents = new Array();
                const implementsParents = new Array();
                if (inheritance.length > 0) {
                    this.parseInheritance(inheritance, extendsParents, implementsParents);
                }
                md.parents = { 'extends': extendsParents, 'implements': implementsParents };
            }
        }
    }
    parseInheritance(inheritance, extendsParents, implementsParents) {
        let mode = '';
        for (const item of inheritance) {
            if (item == 'extends') {
                mode = 'extends';
            }
            else if (item == 'implements') {
                mode = 'implements';
            }
            else if ('extends' == mode) {
                extendsParents.push(item);
            }
            else if ('implements' == mode) {
                implementsParents.push(item);
            }
        }
    }
    parseMethod(parts, clsList, md) {
        clsList.push(md.clsName);
        const metadata = md.store.pop();
        if (metadata) {
            this.clsParameters[md.clsName] = metadata;
        }
        if (md.parents) {
            this.clsParents[md.clsName] = md.parents;
        }
        this.clsMethods[md.clsName] = parts[0];
        md.clsName = null;
        md.parents = null;
    }
}
class ClassMetadata {
    store = new Array();
    clsName = null;
    parents = null;
    signature = EXPORT_TAG;
}
//# sourceMappingURL=ts-class-scanner.js.map