import { TemplateLoader, Logger, Utility, AppConfig, MultiLevelMap, TypeScriptClassScanner, JavaScriptClassScanner } from 'mercury-composable';
import { fileURLToPath } from 'url';
import fs from 'fs';

const log = Logger.getInstance();
const util = new Utility();
const clsMap = {};
const clsParameters = {};

const IMPORT_TAG = '${import-statements}';
const SERVICE_TAG = '${service-list}';

async function scanPackage(packageName) {
    const parent = getCurrentFolder();
    const target = `node_modules/${packageName}/dist`;
    const relativePath = `./node_modules/${packageName}/dist`;
    log.info(`Scanning ${relativePath}`);
    const scanner = new JavaScriptClassScanner(parent, target, 'preload');
    try {
        const result = await scanner.scan();
        const map = new MultiLevelMap(result);
        if (map.exists('classes')) {
            const allClasses = map.getElement('classes');
            for (const clsList of Object.keys(allClasses)) {
                // update path because the preload folder is one level deeper in the source folder
                const path = `../${allClasses[clsList]}`;
                const items = util.split(clsList, ', ');
                let csv = '';
                for (const cls of items) {
                    // validate the signature for method and parameters
                    if ('initialize' == map.getElement(`methods.${cls}`) && map.exists(`parameters.${cls}`)) {
                        const params = map.getElement(`parameters.${cls}`);
                        if (Array.isArray(params)) {
                            clsParameters[cls] = params;
                            csv += csv.length == 0? cls : `,${cls}`;
                            log.info(`Class ${cls}`);
                        }
                    }
                }
                if (csv) {
                    clsMap[csv] = path;
                }
            }            
        }    
    } catch(e) {
        const message = String(e);
        if (message.includes('no such file')) {
            log.error(`Unable to scan package - ${packageName} does not exist`);
        } else {
            log.error(`Unable to scan ${packageName} - ${message}`);
        }        
    }
}

async function generatePreLoader(src, lines) {
    const names = Object.keys(clsMap);
    let section = 'import';
    let sb = '';
    for (const line of lines) {
        if (section == 'import') {
            if (line.includes(IMPORT_TAG)) {
                for (const cls of names) {
                    const filePath = clsMap[cls];
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
                        const parameters = clsParameters[c];
                        let input = null;
                        for (const p of parameters) {
                            if (input) {
                                input += `, ${p}`;
                            } else {
                                input = `${p}, new ${cls}()`;
                            }
                        }
                        sb += `${spaces}platform.register(${input});\n`;
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
    const scanner = new TypeScriptClassScanner(src, 'preload');
    const result = await scanner.scan();
    const map = new MultiLevelMap(result);
    if (map.exists('classes')) {
        const allClasses = map.getElement('classes');
        for (const clsList of Object.keys(allClasses)) {
            // update path because the preload folder is one level deeper
            const path = allClasses[clsList];
            const items = util.split(clsList, ', ');
            let csv = '';
            for (const cls of items) {
                // validate the signature for method, parameters and parent class inheritance
                if ('initialize' == map.getElement(`methods.${cls}`) && map.exists(`parameters.${cls}`)) {
                    const params = map.getElement(`parameters.${cls}`);
                    if (Array.isArray(params)) {
                        const parents = map.getElement(`parents.${cls}.implements`);
                        if (Array.isArray(parents) && parents.includes('Composable')) {
                            clsParameters[cls] = params;
                            csv += csv.length == 0? cls : `,${cls}`;
                            log.info(`Class ${cls}`);
                        }
                    }
                }
            }
            if (csv) {
                clsMap[csv] = path;
            }
        }            
    }  
    if (Object.keys(clsMap).length > 0) {
        const loader = new TemplateLoader();
        const template = loader.getTemplate('preload.template');
        if (template && template.includes(IMPORT_TAG) && template.includes(SERVICE_TAG)) {
            await generatePreLoader(src, template.split('\n'));
        } else {
            throw new Error(`Invalid preload.template - missing ${IMPORT_TAG} and ${SERVICE_TAG} tags`);
        }
    } else {
        log.info('There are no composable functions in the source folder');
    }
}

main();
