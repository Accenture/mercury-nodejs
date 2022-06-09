import shell from 'shelljs';

function getRootFolder() {
    const filename = import.meta.url.substring(7);
    const parts = filename.split('/');
    const pathname = parts.length > 2 && parts[1].endsWith(':')? filename.substring(1) : filename;
    return pathname.includes('/')? pathname.substring(0, pathname.lastIndexOf('/')) : pathname;
}

const coverage = getRootFolder() + '/coverage';
const dist = getRootFolder() + '/target';
const tmp = getRootFolder() + '/tmp';

shell.rm("-rf", coverage);
shell.rm("-rf", dist);
shell.rm("-rf", tmp);
