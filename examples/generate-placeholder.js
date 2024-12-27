import { TemplateLoader, Logger, Utility, AppConfig } from 'mercury';
import { fileURLToPath } from 'url';
import fs from 'fs';

const log = Logger.getInstance();
const util = new Utility();
const clsMap = new Map();

const IMPORT_TAG = '${import-statements}';
const SERVICE_TAG = '${service-list}';

async function generatePlaceholder(src, lines) {
    const names = Array.from(clsMap.keys());
    let section = 'import';
    let sb = '';
    for (const line of lines) {
        if (section == 'import') {
            if (line.includes(IMPORT_TAG)) {         
                for (const cls of names) {
                    const filePath = clsMap.get(cls);
                    sb += `import { ${cls} } from '${filePath}';\n`;
                }
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
                for (const cls of names) {
                    sb += `${spaces}new ${cls}().initialize();\n`;
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
    const targetDir = src + '/preload';
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir);
    }
    const targetFile = src + '/preload/preload.ts';
    fs.writeFileSync(targetFile, sb);
    const relativePath = targetFile.substring(src.length);
    log.info(`Composable placeholder (${relativePath}) generated`);
}

function getCurrentFolder() {
    const folder = fileURLToPath(new URL(".", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
}

async function main() {
    const loader = new TemplateLoader();
    const template = loader.getTemplate('preload.template');
    if (template && template.includes(IMPORT_TAG) && template.includes(SERVICE_TAG)) {
        const lines = template.split('\n');
        const root = getCurrentFolder();
        const src = root + 'src';
        await generatePlaceholder(src, lines);
    } else {
        throw new Error(`Invalid preload.template - missing ${IMPORT_TAG} and ${SERVICE_TAG} tags`);
    }
}

main();
