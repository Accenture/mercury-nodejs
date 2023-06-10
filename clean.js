import shell from 'shelljs';
import { fileURLToPath } from "url";

function getCurrentFolder() {
    const folder = fileURLToPath(new URL(".", import.meta.url));
    return folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
}

function getFolder(target) {
    return getCurrentFolder() + target;
}

const coverage = getFolder('coverage');
const dist = getFolder('dist');

shell.rm("-rf", coverage);
shell.rm("-rf", dist);
