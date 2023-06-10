import shell from 'shelljs';
import { fileURLToPath } from "url";

function getCurrentFolder() {
    const folder = fileURLToPath(new URL(".", import.meta.url));
    return folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
}

function getFolder(target) {
    return getCurrentFolder() + target;
}

const src = getFolder('src/resources');
const target = getFolder('dist');

shell.cp("-R", src, target);
