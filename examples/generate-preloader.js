import { TemplateLoader, Logger, Utility, AppConfig } from 'mercury';
import { fileURLToPath } from 'url';
import fs from 'fs';

const log = Logger.getInstance();
const util = new Utility();
const clsMap = new Map();

const IMPORT_TAG = '${import-statements}';
const SERVICE_TAG = '${service-list}';

const EXPORT_TAG = 'export';
const PRELOAD_TAG = '@preload(';
const INITIALIZE_TAG = 'initialize()';

async function scanPackage(packageName) {
    const parent = getCurrentFolder();
    const target = parent + 'node_modules/' + packageName + '/dist';
    log.info(`Scanning ${target}`);
    try {
        await scanPackageJs(parent, target);
    } catch(e) {
        const message = String(e);
        if (message.includes('no such file')) {
            log.error(`Unable to scan ${packageName} - package does not exist`);
        } else {
            log.error(`Unable to scan ${packageName} - ${message}`);
        }
        
    }
}

async function scanPackageJs(parent, folder) {
    const files = await fs.promises.readdir(folder);
    for (const f of files) {
        const path = folder + '/' +f;
        const stat = await fs.promises.stat(path);
        if (stat.isDirectory()) {
            await scanPackageJs(parent, path);
        } else {
            if (f.endsWith('.js')) {
                const content = await fs.promises.readFile(path, 'utf-8');
                const blocks = [];
                const lines = util.split(content, '\r\n');
                let hasDecorators = false;
                for (const line of lines) {
                    const text = line.trim();
                    if (!text.startsWith('//')) {
                        if (text.startsWith('__decorate(')) {
                            hasDecorators = true;
                            continue;
                        }
                        if (hasDecorators) {
                            blocks.push(text);
                        }
                    }
                }
                if (hasDecorators) {
                    let found = false;
                    for (const block of blocks) {
                        if (block.startsWith('preload(')) {
                            found = true;
                            continue;
                        }
                        if (found) {
                            const elements = util.split(block, '], ";)');
                            const relativePath = '../../'+path.substring(parent.length);
                            if (elements.length > 1 && elements[1] == 'initialize' && elements[0].endsWith('.prototype')) {
                                const clsName = elements[0].substring(0, elements[0].lastIndexOf('.'));
                                clsMap.set(clsName, relativePath);
                                log.info(`Class ${clsName}`);
                            }
                            break;
                        }
                    }
                }
            }            
        }
    }
}

async function scanSourceFolder(parent, folder) {
    const files = await fs.promises.readdir(folder);
    for (const f of files) {
        const path = folder + '/' +f;
        const stat = await fs.promises.stat(path);
        if (stat.isDirectory()) {
            await scanSourceFolder(parent, path);
        } else {
            if (f.endsWith('.ts') && !f.endsWith('.d.ts')) {
                const clsName = await getComposableSourceFile(path);
                if (clsName) {               
                    const relativePath = '..' + path.substring(parent.length, path.length-3) + '.js';
                    clsMap.set(clsName, relativePath);
                    log.info(`Class ${clsName}`);
                }
            }            
        }
    }
}

async function getComposableSourceFile(path) {
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
                    signature = PRELOAD_TAG;
                }
            }
        } else if (PRELOAD_TAG == signature && line.startsWith(PRELOAD_TAG) && line.includes(')')) {
            signature = INITIALIZE_TAG;
        } else if (INITIALIZE_TAG == signature && line.startsWith(INITIALIZE_TAG)) {
            found = true;
            break;
        }
    }
    return found && clsName? clsName : null;
}

async function generatePreLoader(src, lines) {
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
    log.info(`Composable class loader (${relativePath}) generated`);
}

function getCurrentFolder() {
    const folder = fileURLToPath(new URL(".", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
}

async function main() {
    const root = getCurrentFolder();
    const src = root + 'src';
    const resources = src + '/resources';
    // initialize configuration manager to use 'src/resources/application.yml' config file
    const config = AppConfig.getInstance(resources).getReader();
    const packages = config.getProperty('web.component.scan');
    if (packages) {
        const packageList = util.split(packages, ', ');
        for (const p of packageList) {
            await scanPackage(p);
        }
    }
    log.info(`Scanning ${src}`);
    await scanSourceFolder(src, src);
    if (clsMap.size > 0) {
        const loader = new TemplateLoader();
        const template = loader.getTemplate('preload.template');
        if (template && template.includes(IMPORT_TAG) && template.includes(SERVICE_TAG)) {
            const lines = template.split('\n');
            await generatePreLoader(src, lines);
        } else {
            throw new Error(`Invalid preload.template - missing ${IMPORT_TAG} and ${SERVICE_TAG} tags`);
        }
    } else {
        log.info('There are no composable functions in the source folder');
    }
}

main();
