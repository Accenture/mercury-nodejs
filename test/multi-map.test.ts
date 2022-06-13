import { MultiLevelMap } from '../src/util/multi-level-map';

describe('multi-level map use cases', () => {
      
    it('can read and write multiple levels in a map', () => {
        const map = {'hello': 'world'};
        const mm = new MultiLevelMap(map);
        mm.setElement('x.y.z', 100);
        mm.setElement('a.b.c', [1,2,3]);
        // retrieve the elements
        const one = mm.getElement('a.b.c[0]')
        expect(one).toBe(1);
        const xy = mm.getElement('x.y');
        console.log(xy);
        expect(xy).toBeInstanceOf(Object);
        expect(xy['z']).toBe(100);
        expect(mm.getElement('hello')).toBe('world');
        // flatten it into single level using dot-bracket composite key format
        const flat = mm.getFlatMap();
        expect(flat['x.y.z']).toBe(100);
        expect(flat['a.b.c[2]']).toBe(3);
        expect(flat['a.b.c[4]']).toBeUndefined();
        const none = mm.getElement('a.b.c[0][invalid format')
        expect(none).toBeNull();
    });      

});