import { MultiLevelMap } from '../src/util/multi-level-map';

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
        expect(mm.keyExists('a.b.c[4]')).toBeTruthy();
        expect(mm.getElement('a.b.c[0][invalid format')).toBeNull();
        expect(mm.keyExists('a.b.c[0][invalid format')).toBeFalsy();
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

    it('can append to an array in a multi level map', () => {
        const map = new MultiLevelMap();
        // setElement supports the syntax of "[]" to append a list element
        map.setElement("hello.world[]", "test1");
        map.setElement("hello.world[]", "test2");
        map.setElement("hello.world[]", "test3");
        map.setElement("hello.world[]", "test4");
        map.setElement("hello.world[]", "test5");
        expect(map.keyExists("hello.world[4]")).toBeTruthy();
        expect(map.keyExists("hello.world[5]")).toBeFalsy();
        expect(map.getElement("hello.world[0]")).toBe("test1");
        expect(map.getElement("hello.world[1]")).toBe("test2");
        expect(map.getElement("hello.world[2]")).toBe("test3");
        expect(map.getElement("hello.world[3]")).toBe("test4");
        expect(map.getElement("hello.world[4]")).toBe("test5");
        expect(() => {      
            map.setElement("[]hello.world[]", "invalid");
        }).toThrow('Invalid composite path - missing first element');
    });
});