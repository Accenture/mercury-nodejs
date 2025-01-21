export declare class CryptoApi {
    /**
     * Generate an AES symmetric key
     *
     * @returns random key of 32 bytes
     */
    generateAesKey(): Buffer;
    /**
     * Encrypt data using AES-256-GCM algorithm
     *
     * @param clearText in bytes
     * @param key as a 32-byte AES key
     * @returns encrypted bytes
     */
    aesEncrypt(clearText: Buffer, key: Buffer): Buffer;
    /**
     * Decrypt data using AES-256-GCM algorithm
     *
     * @param cipherText in bytes
     * @param key as a 32-byte AES key
     * @returns decrypted bytes
     */
    aesDecrypt(cipherText: Buffer, key: Buffer): Buffer;
}
