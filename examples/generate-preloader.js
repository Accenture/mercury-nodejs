import { TemplateLoader, Utility, Logger } from 'mercury';
import { fileURLToPath } from "url";
import fs from 'fs';

const log = new Logger();
const util = new Utility();

const IMPORT_TAG = '${import-statements}';
const SERVICE_TAG = '${service-list}';

function main() {
    const folder = fileURLToPath(new URL("./src/", import.meta.url));
    const src = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;

    const loader = new TemplateLoader();
    const template = loader.getTemplate('preload.template');
    if (template && template.includes(IMPORT_TAG) && template.includes(SERVICE_TAG)) {
        const lines = template.split('\n');

        const preloadYaml = src + 'resources/preload.yaml';
        
        const map = util.loadYamlFile(preloadYaml);
    
        const importList = map.getElement('import');
        if (!Array.isArray(importList)) {
            throw new Error("Import section should be a list of map");
        }
        const clsList = [];
        let statementBlock = '';
        for (const entry of importList) {
            if (!Array.isArray(entry) && entry.constructor == Object) {
                const cls = entry['class'];
                const location = entry['location'];
                if (typeof(cls) == 'string' && typeof(location) == 'string') {
                    clsList.push(cls);
                    statementBlock += 'import { ';
                    statementBlock += cls;
                    statementBlock += " } from '";
                    statementBlock += location;
                    statementBlock += "';\n";
                } else {
                    throw new Error(`Invalid import entry - ${JSON.stringify(entry)}`);
                }
            }
        }
    
        let section = 'import';
        let sb = '';
        for (const line of lines) {
            if (section == 'import') {
                if (line.includes(IMPORT_TAG)) {
                    sb += statementBlock;
                    section = 'service';
                    continue;
                } else {
                    sb += `${line}\n`;
                }
            }
            if (section == 'service') {
                if (line.includes(SERVICE_TAG)) {
                    const idx = line.indexOf(SERVICE_TAG);
                    const spaces = line.substring(0, idx);
                    for (let i=0; i < clsList.length; i++) {
                        const cls = clsList[i];
                        const text = `${spaces}new ${cls}().initialize();\n`;
                        sb += text;
                    }
                    section = 'remaining';
                    continue;
                } else {
                    sb += `${line}\n`;
                }
            }
            if (section == 'remaining') {
                sb += `${line}\n`;
            }
        }
        const targetDir = src + 'preload';
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir);
        }
        const targetFile = src + 'preload/preload.ts';
        fs.writeFileSync(targetFile, sb);
        log.info(`${targetFile} successfully updated`);

    } else {
        throw new Error(`Invalid preload.template - missing ${IMPORT_TAG} and ${SERVICE_TAG} tags`);
    }
}

try {
    main();
} catch (e) {
    log.error(`Unable to generate preloader - ${e.message}`);
}

