import crypto from 'crypto';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const AES_KEY_LENGTH = 32;
const MIN_CIPHERTEXT = IV_LENGTH + AUTH_TAG_LENGTH;
const AES_256_GCM = "aes-256-gcm";
export class CryptoApi {
    /**
     * Generate an AES symmetric key
     *
     * @returns random key of 32 bytes
     */
    generateAesKey() {
        return crypto.randomBytes(AES_KEY_LENGTH);
    }
    /**
     * Encrypt data using AES-256-GCM algorithm
     *
     * @param clearText in bytes
     * @param key as a 32-byte AES key
     * @returns encrypted bytes
     */
    aesEncrypt(clearText, key) {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(AES_256_GCM, key, iv);
        const first = cipher.update(clearText);
        const last = cipher.final();
        const encrypted = Buffer.concat([first, last]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, encrypted, tag]);
    }
    /**
     * Decrypt data using AES-256-GCM algorithm
     *
     * @param cipherText in bytes
     * @param key as a 32-byte AES key
     * @returns decrypted bytes
     */
    aesDecrypt(cipherText, key) {
        if (cipherText && cipherText.length > MIN_CIPHERTEXT) {
            const iv = cipherText.subarray(0, IV_LENGTH);
            const offset = cipherText.length - AUTH_TAG_LENGTH;
            const data = cipherText.subarray(IV_LENGTH, offset);
            const tag = cipherText.subarray(offset);
            const decipher = crypto.createDecipheriv(AES_256_GCM, key, iv);
            decipher.setAuthTag(tag);
            const first = decipher.update(data);
            const last = decipher.final();
            return Buffer.concat([first, last]);
        }
        else {
            throw new Error('Invalid cipher text');
        }
    }
}
//# sourceMappingURL=crypto-api.js.map