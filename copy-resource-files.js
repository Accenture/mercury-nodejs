import fs from 'fs';
import { fileURLToPath } from "url";

function getCurrentFolder() {
    const folder = fileURLToPath(new URL(".", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon === 1? path.substring(colon+1) : path;
}

function getFolder(target) {
    return getCurrentFolder() + target;
}

function isDir(folder) {
    if (fs.existsSync(folder)) {
        const stats = fs.statSync(folder);
        return stats.isDirectory();
    } else {
        return false;
    }
}

function copyFolder(src, target) {
    if (fs.existsSync(src)) {
        fs.readdirSync(src).forEach(f => {
            const srcPath = `${src}/${f}`
            const targetPath = `${target}/${f}`
            const srcStats = fs.statSync(srcPath);
            if (srcStats.isDirectory()) {
                createParentFolders(targetPath);
                copyFolder(srcPath, targetPath);               
            } else {
                if (fs.existsSync(targetPath)) {
                    fs.rmSync(targetPath);
                }
                fs.copyFileSync(srcPath, targetPath);
            }
        });
    }
}

function createParentFolders(path) {
    const parts = path.split('/');
    let s = '';
    for (const p of parts) {
        s += `/${p}`;
        if (!fs.existsSync(s)) {
            fs.mkdirSync(s);
        }        
    }
}

function copyResourceFiles(src, target) {
    if (!fs.existsSync(src)) {
        console.log(`ERROR: ${src} does not exist`);
        return;
    }
    if (!fs.existsSync(target)) {
        console.log(`ERROR: ${target} does not exist`);
        return;
    }
    if (!isDir(src)) {
        console.log(`ERROR: ${src} is not a folder`);
        return;
    }
    if (!isDir(target)) {
        console.log(`ERROR: ${target} is not a folder`);
        return;
    }
    const srcResource = `${src}/resources`;
    if (!isDir(srcResource)) {
        console.log(`ERROR: ${srcResource} is not a folder`);
        return;
    }
    const targetResource = `${target}/resources`;
    if (!isDir(targetResource)) {
        fs.mkdirSync(targetResource);
    }
    copyFolder(srcResource, targetResource);
}

const src = getFolder('src');
const target = getFolder('dist');
// copy version from package.json
const packageJson = getCurrentFolder() + 'package.json';
if (fs.existsSync(packageJson)) {
    const content = fs.readFileSync(packageJson, { encoding: 'utf-8', flag: 'r' });
    const value = JSON.parse(content);
    const version = value['version'];
    if (version) {
        const versionFile = `${src}/resources/version.txt`;
        fs.writeFileSync(versionFile, version);
    }
}
// copy the "resources" folder
copyResourceFiles(src, target);
