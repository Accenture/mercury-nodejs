import { MultiLevelMap } from '../src/util/multi-level-map';
import { Utility } from '../src/util/utility';

const util = new Utility();

describe('multi-level map use cases', () => {
      
    it('can read and write multiple levels in a map', () => {
        const map = {'hello': 'world'};
        const mm = new MultiLevelMap(map);
        mm.setElement('test.boolean', false);
        mm.setElement('x.y.z', 100);
        mm.setElement('a.b.c', [1,2,3]);
        mm.setElement('a.b.c[4].hello', 'world');
        // retrieve the elements
        const one = mm.getElement('a.b.c[0]')
        expect(one).toBe(1);
        const xy = mm.getElement('x.y');
        expect(xy).toBeInstanceOf(Object);
        expect(xy['z']).toBe(100);
        expect(mm.getElement('hello')).toBe('world');
        // flatten it into single level using dot-bracket composite key format
        const flat = mm.getFlatMap();    
        expect(flat['x.y.z']).toBe(100);
        expect(flat['a.b.c[0]']).toBe(1);
        expect(flat['a.b.c[2]']).toBe(3);
        expect(flat['a.b.c[4]']).toBeUndefined();
        expect(mm.getElement('a.b.c[0][invalid format')).toBeNull();
        // add 2 key-values to a.b.c[4]
        mm.setElement('a.b.c[4].test1', "message1");
        mm.setElement('a.b.c[4].test2', "message2");
        // a.b.c is automatically expanded when the 4 array element is added, therefore 3rd element is null.
        expect(mm.getElement('a.b.c[3]')).toBe(null);
        expect(mm.getElement('a.b.c[4]')).toBeInstanceOf(Object);
        expect(mm.getElement('a.b.c[4].hello')).toBe('world');
        expect(mm.getElement('a.b.c[4].test1')).toBe('message1');
        expect(mm.getElement('a.b.c[4].test2')).toBe('message2');    
        expect(mm.exists('test.boolean')).toBe(true);
        expect(mm.getElement('test.boolean')).toBe(false);
    }); 
    
    it('can detect path traversal', () => {
        expect(() => {
            util.getSafeFilePath('/tmp', '../hello');
        }).toThrow('Access denied because file path is outside the base directory'); 
    });  

});