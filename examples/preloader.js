import { TemplateLoader, Logger, Utility, AppConfig } from 'mercury-composable';
import { fileURLToPath } from 'url';
import fs from 'fs';

const log = Logger.getInstance();
const util = new Utility();
const clsMap = new Map();
const clsParameters = new Map();

const IMPORT_TAG = '${import-statements}';
const SERVICE_TAG = '${service-list}';

const EXPORT_TAG = 'export';
const PRELOAD_TAG = '@preload(';
const INITIALIZE_TAG = 'initialize()';

async function scanPackage(packageName) {
    const parent = getCurrentFolder();
    const target = parent + 'node_modules/' + packageName + '/dist';
    const relativePath = './node_modules/' + packageName + '/dist';
    log.info(`Scanning ${relativePath}`);
    try {
        await scanLibrary(parent, target);
    } catch(e) {
        const message = String(e);
        if (message.includes('no such file')) {
            log.error(`Unable to scan ${packageName} - package does not exist`);
        } else {
            log.error(`Unable to scan ${packageName} - ${message}`);
        }        
    }
}

async function scanLibrary(parent, folder) {
    const files = await fs.promises.readdir(folder);
    for (const f of files) {
        const path = folder + '/' +f;
        const stat = await fs.promises.stat(path);
        if (stat.isDirectory()) {
            await scanLibrary(parent, path);
        } else {
            if (f.endsWith('.js')) {
                const content = await fs.promises.readFile(path, 'utf-8');
                const parameterBlocks = [];
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
                        if (hasDecorators && text.startsWith('preload(')) {
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
                // const metadata = {};
                const clsList = [];
                if (parameterBlocks.length == classBlocks.length) {
                    for (let i=0; i < classBlocks.length; i++) {
                        const block = classBlocks[i];
                        const parameters = parameterBlocks[i];
                        const preloadParams = util.split(parameters, '(, \'")');
                        if (block.includes('.prototype') && preloadParams.length > 1) {
                            const metadata = getMetadata(preloadParams);                            
                            const elements = util.split(block, '], ";)');                 
                            if (elements.length > 1 && elements[1] == 'initialize' && elements[0].endsWith('.prototype')) {
                                const clsName = elements[0].substring(0, elements[0].lastIndexOf('.'));
                                clsList.push(clsName);
                                clsParameters.set(clsName, metadata);
                            }
                        }

                    }
                }
                if (clsList.length > 0) {
                    const relativePath = '../../' + path.substring(parent.length);
                    clsMap.set(list2str(clsList), relativePath);
                    for (const c of clsList) {
                        log.info(`Class ${c}`);
                    }                    
                }               
            }            
        }
    }
}

function getMetadata(params) {
    const md = {};
    const route = params[1];
    const instances = params.length > 2? Math.max(1, util.str2int(params[2])) : 1;
    const isPrivate = params.length > 3? "true" == params[3] : true;
    const interceptor = params.length == 5? "true" == params[4] : false;
    md['route'] = route;
    md['instances'] = instances;
    md['private'] = isPrivate;
    md['interceptor'] = interceptor;
    return md;
}

async function scanSource(parent, folder) {
    const files = await fs.promises.readdir(folder);
    for (const f of files) {
        const path = folder + '/' +f;
        const stat = await fs.promises.stat(path);
        if (stat.isDirectory()) {
            await scanSource(parent, path);
        } else {
            if (f.endsWith('.ts') && !f.endsWith('.d.ts')) {
                const clsList = await getComposableSourceFile(path);
                if (clsList.length > 0) {
                    const relativePath = '..' + path.substring(parent.length, path.length-3) + '.js';
                    clsMap.set(list2str(clsList), relativePath);
                    for (const c of clsList) {
                        log.info(`Class ${c}`);
                    }
                }
            }            
        }
    }
}

async function getComposableSourceFile(path) {
    const content = await fs.promises.readFile(path, 'utf-8');
    const lines = content.split('\n').map(v => v.trim()).filter(v => v);
    const clsList = [];
    const metadataStore = [];
    let clsName = null;
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
            const preloadParams = util.split(line, '(, \'")');
            if (preloadParams.length > 1) {
                metadataStore.push(getMetadata(preloadParams));
                signature = INITIALIZE_TAG;
            }
        } else if (INITIALIZE_TAG == signature && line.startsWith(INITIALIZE_TAG)) {
            clsList.push(clsName);
            const metadata = metadataStore.pop();
            if (metadata) {
                clsParameters.set(clsName, metadata);
            }
            signature = EXPORT_TAG;
        }
    }
    return clsList;
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
                    const composite = util.split(cls, ', ');
                    for (const c of composite) {
                        const md = clsParameters.get(c);
                        if (md) {
                            const route = md['route'];
                            const normalizedRoute = util.validRouteName(route)? `'${route}'` : route;
                            const instances = md['instances'];
                            const isPrivate = md['private'];
                            const interceptor = md['interceptor'];
                            sb += `${spaces}platform.register(${normalizedRoute}, new ${c}(), ${instances}, ${isPrivate}, ${interceptor});\n`;
                        }                        
                    }                    
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
    await fs.promises.writeFile(targetFile, sb);
    const relativePath = targetFile.substring(src.length);
    log.info(`Composable class loader (${relativePath}) generated`);
}

function list2str(list) {
    let result = '';
    for (const item of list) {
        result += item;
        result += ', ';
    }
    return result.length > 2? result.substring(0, result.length-2) : result;
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
    const config = AppConfig.getInstance(resources);
    const packages = config.getProperty('web.component.scan');
    if (packages) {
        const packageList = util.split(packages, ', ');
        for (const p of packageList) {
            await scanPackage(p);
        }
    }
    log.info('Scanning ./src');
    await scanSource(src, src);
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
