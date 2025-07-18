import { MultiLevelMap } from '../src/util/multi-level-map';
import { TypeScriptClassScanner } from '../src/util/ts-class-scanner';
import { JavaScriptClassScanner } from '../src/util/js-class-scanner';
import { fileURLToPath } from "url";

function getRootFolder() {
    const folder = fileURLToPath(new URL("..", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
  }

describe('Annotation scan tests', () => {

    it('can scan Composable class with preload annotation', async () => {
        const folder = getRootFolder();
        const scanner = new TypeScriptClassScanner(folder, 'src', 'preload');
        const result = await scanner.scan();
        const map = new MultiLevelMap(result);
        // proves that it finds the NoOp class with parents, method and parameters
        expect(map.getElement('classes.NoOp')).toBe('src/services/no-op');
        expect(map.getElement('parents.NoOp.implements[0]')).toBe('Composable');
        expect(map.getElement('methods.NoOp')).toBe('initialize');
        // the original single or double quotes are preserved
        expect(map.getElement('parameters.NoOp[0]')).toBe("'no.op'");
        expect(map.getElement('parameters.NoOp[1]')).toBe('50');


    });

    it('can scan Javascript compiled code with preload annotation', async () => {
        const parent = getRootFolder();
        const scanner = new JavaScriptClassScanner(parent, 'tests', 'preload');
        const result = await scanner.scan();
        const map = new MultiLevelMap(result);
        // proves that it finds the NoOp class with method and parameters
        // note that any parent class inheritance is lost from the compiled JS files
        expect(map.getElement('classes.NoOp')).toBe('tests/resources/annotated/no-op.js');
        expect(map.getElement('methods.NoOp')).toBe('initialize');
                // the original single or double quotes are preserved
        expect(map.getElement('parameters.NoOp[0]')).toBe("'no.op'");
        expect(map.getElement('parameters.NoOp[1]')).toBe('50');
    });
});
