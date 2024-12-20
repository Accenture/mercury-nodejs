import { Logger } from '../src/util/logger.js';
import { Utility } from '../src/util/utility.js';
import { PostOffice } from '../src/system/post-office.js';
import { ObjectStreamIO, ObjectStreamWriter, ObjectStreamReader } from '../src/system/object-stream.js';

const log = Logger.getInstance();
const util = new Utility();
const po = new PostOffice();

describe('object stream I/O tests', () => {   
      
    it('can write and read string', async () => {
        const cycles = 5;
        const stream = new ObjectStreamIO(10);
        const outputId = stream.getOutputStreamId();
        const streamOut = new ObjectStreamWriter(outputId);
        // write a few blocks
        for (let i=1; i <= cycles; i++) {
            streamOut.write(`hello-${i}`);
        }
        // close output stream
        const outputStreamCloseStatus = await streamOut.close();
        expect(outputStreamCloseStatus).toBe(true);
        log.info(`Stream ${outputId} closed? ${outputStreamCloseStatus}`);
        // output stream service is still reachable but not serving requests
        expect(po.exists(outputId)).toBe(true);
        // open input stream
        const streamIn = new ObjectStreamReader(stream.getInputStreamId(), 2000);
        for (let i=1; i <= cycles; i++) {
            const result = await streamIn.read();
            expect(typeof result).toBe('string');
            const text = result as string;
            expect(text.startsWith('hello-')).toBe(true);
            log.info(`Block-${i}, data=${result}`);
        }
        // will get EOF signal after reading the last data block
        const result1 = await streamIn.read();
        expect(result1).toBe(null);
        // will get EOF signal when reading again after EOF
        const result2 = await streamIn.read();
        expect(result2).toBe(null);
        // input stream is automatically closed after reaching EOF
        expect(streamIn.closed()).toBe(true);
        // check if stream has been released
        expect(po.exists(stream.getInputStreamId())).toBe(false);
        expect(po.exists(stream.getOutputStreamId())).toBe(false);
    });  

    it('can write and read both string, bytes and json', async () => {
        const stream = new ObjectStreamIO(10);
        const outputId = stream.getOutputStreamId();
        const streamOut = new ObjectStreamWriter(outputId);
        // write a few blocks
        streamOut.write("text");
        streamOut.write(Buffer.from("bytes"));
        streamOut.write({'hello': 'world'});
        // close output stream
        const closeStatus = await streamOut.close();
        expect(closeStatus).toBe(true);
        log.info(`Stream ${outputId} closed? ${closeStatus}`);
        // output stream service is still reachable but not serving requests
        expect(po.exists(outputId)).toBe(true);
        // open input stream
        const streamIn = new ObjectStreamReader(stream.getInputStreamId(), 2000);
        const result1 = await streamIn.read();
        expect(result1).toBe('text');
        const result2 = await streamIn.read();
        expect(result2).toStrictEqual(Buffer.from('bytes'));
        const result3 = await streamIn.read();
        expect(result3).toStrictEqual({'hello':'world'});
        // close input stream
        const status = await streamIn.close();
        expect(status).toBe(true);
        // check if stream has been released
        expect(po.exists(stream.getInputStreamId())).toBe(false);
        expect(po.exists(stream.getOutputStreamId())).toBe(false);
    });     

    it('will expire a stream when idle', async () => {
        const stream = new ObjectStreamIO(1);
        const outputId = stream.getOutputStreamId();
        const streamOut = new ObjectStreamWriter(outputId);
        // write a few blocks
        streamOut.write("text");
        streamOut.write(Buffer.from("bytes"));
        streamOut.write({'hello': 'world'});
        // close output stream
        const closeStatus = await streamOut.close();
        expect(closeStatus).toBe(true);
        log.info(`Stream ${outputId} closed? ${closeStatus}`);
        // output stream service is still reachable but not serving requests
        expect(po.exists(outputId)).toBe(true);
        // open input stream
        const streamIn = new ObjectStreamReader(stream.getInputStreamId(), 2000);
        const result1 = await streamIn.read();
        expect(result1).toBe('text');
        await util.sleep(1500);
        // stream will close automatically when idle
        expect(po.exists(stream.getInputStreamId())).toBe(false);
        expect(po.exists(stream.getOutputStreamId())).toBe(false);
    });     

});