import fs from 'fs';

function getRootFolder() {
    const filename = import.meta.url.substring(7);
    const parts = filename.split('/');
    const pathname = parts.length > 2 && parts[1].endsWith(':')? filename.substring(1) : filename;
    return pathname.includes('/')? pathname.substring(0, pathname.lastIndexOf('/')) : pathname;
}

function removeDirectory(folder) {
    if (fs.existsSync(folder)) {
        fs.readdirSync(folder).forEach(f => {
            const path = `${folder}/${f}`
            const stats = fs.statSync(path);
            if (stats.isDirectory()) {
                removeDirectory(path);
            } else {
                fs.rmSync(path);
            }
        })
        fs.rmdirSync(folder);
    }
}

const coverage = getRootFolder() + '/coverage';
const dist = getRootFolder() + '/dist';
const tmp = getRootFolder() + '/tmp';

removeDirectory(coverage);
removeDirectory(dist);
removeDirectory(tmp);
