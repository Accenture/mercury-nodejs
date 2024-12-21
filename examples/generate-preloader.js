import { TemplateLoader, Logger, Utility } from 'mercury';
import { fileURLToPath } from 'url';
import fs from 'fs';

const log = Logger.getInstance();
const util = new Utility();
const clsMap = new Map();

const IMPORT_TAG = '${import-statements}';
const SERVICE_TAG = '${service-list}';

const EXPORT_TAG = 'export';
const PRELOAD_TAG = '@preload()';
const INITIALIZE_TAG = 'initialize()';

async function scanDir(folder) {
    const files = await fs.promises.readdir(folder);
    for (const f of files) {
        const stat = await fs.promises.stat(folder + f);
        if (stat.isDirectory()) {
            await scanDir(folder + f +'/');
        } else {
            if (f.endsWith('.ts') && !f.endsWith('.d.ts')) {
                const path = folder + f;
                const clsName = await getComposable(path);
                if (clsName) {
                    clsMap.set(clsName, path);
                    log.info(`Class ${clsName}`);
                }
            }            
        }
    }
}

async function getComposable(path) {
    const content = await fs.promises.readFile(path, 'utf-8');
    const lines = content.split('\n').map(v => v.trim()).filter(v => v);
    let clsName = null;
    let found = false;
    let signature = EXPORT_TAG;
    for (const line of lines) {
        if (EXPORT_TAG == signature) {
            if (line.startsWith(signature + ' ')) {
                const parts = line.split(' ').filter(v => v);
                if (parts.length >= 5 && 'class' == parts[1] && 
                    'implements' == parts[3] && 'Composable' == parts[4]) {
                    clsName = parts[2];
                    signature = '@preload()';
                }
            }
        } else if (PRELOAD_TAG == signature && PRELOAD_TAG == line) {
            signature = INITIALIZE_TAG;
        } else if (INITIALIZE_TAG == signature && line.startsWith(INITIALIZE_TAG)) {
            found = true;
            break;
        }
    }
    return found && clsName? clsName : null;
}

async function generateCode(src, lines) {
    const names = Array.from(clsMap.keys());
    let section = 'import';
    let sb = '';
    for (const line of lines) {
        if (section == 'import') {
            if (line.includes(IMPORT_TAG)) {         
                for (const cls of names) {
                    const filePath = clsMap.get(cls);
                    const path = '../' + filePath.substring(src.length, filePath.length-3) + '.js';
                    sb += `import { ${cls} } from '${path}';\n`;
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
    const targetDir = src + 'preload';
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir);
    }
    const targetFile = src + 'preload/preload.ts';
    fs.writeFileSync(targetFile, sb);
    const relativePath = targetFile.substring(src.length);
    log.info(`Service loader (${relativePath}) generated`);
}

function getCurrentFolder() {
    const folder = fileURLToPath(new URL(".", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
}

async function main() {
    const src = getCurrentFolder() + 'src/';
    log.info(`Scanning ${src}`);
    await scanDir(src);
    if (clsMap.size > 0) {
        const loader = new TemplateLoader();
        const template = loader.getTemplate('preload.template');
        if (template && template.includes(IMPORT_TAG) && template.includes(SERVICE_TAG)) {
            const lines = template.split('\n');
            await generateCode(src, lines);
        } else {
            throw new Error(`Invalid preload.template - missing ${IMPORT_TAG} and ${SERVICE_TAG} tags`);
        }
    } else {
        log.info('There are no composable functions in the source folder');
    }
}

main();
