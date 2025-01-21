import { Logger } from '../src/util/logger';
import { CryptoApi } from '../src/util/crypto-api';

const log = Logger.getInstance();
const crypto = new CryptoApi();

describe('crypto tests', () => {

    beforeAll(() => {
        log.info('Crypto API test begins');
    });

    it('can encrypt and decrypt', () => {
        const key = crypto.generateAesKey();
        const clearText = "hello world 1234567890";
        const clearBytes = Buffer.from(clearText);
        const encrypted = crypto.aesEncrypt(clearBytes, key);
        const restoredBytes = crypto.aesDecrypt(encrypted, key);
        expect(restoredBytes).toEqual(clearBytes);
        const restoredText = restoredBytes.toString();
        expect(restoredText).toBe(clearText);
        // verify encrypted text will be randomized using IV
        const encrypted2 = crypto.aesEncrypt(clearBytes, key);
        expect(encrypted2).not.toEqual(encrypted);
        const restoredBytes2 = crypto.aesDecrypt(encrypted2, key);
        expect(restoredBytes2).toEqual(clearBytes);
        const restoredText2 = restoredBytes2.toString();
        expect(restoredText2).toBe(clearText);        
    }); 

    it("should throw an error when cipher text is too small", () => {
        expect(() => {
            const key = crypto.generateAesKey();
            crypto.aesDecrypt(Buffer.from('hello'), key);
        }).toThrow('Invalid cipher text'); 
    });
});
