import shell from 'shelljs';

function getRootFolder() {
    const filename = import.meta.url.substring(7);
    const parts = filename.split('/');
    const pathname = parts.length > 2 && parts[1].endsWith(':')? filename.substring(1) : filename;
    return pathname.includes('/')? pathname.substring(0, pathname.lastIndexOf('/')) : pathname;
}

const src = getRootFolder() + '/src/resources';
const target = getRootFolder() + '/target';

shell.cp("-R", src, target);
