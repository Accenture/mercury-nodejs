import { AppException, Composable, EventEnvelope, MultiLevelMap, preload, Utility, CryptoApi, PostOffice } from "mercury-composable";

const util = new Utility();
const crypto = new CryptoApi();

export class EncryptFields implements Composable {

    @preload('v1.encrypt.fields', 10)
    initialize(): Composable {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        const input = evt.getBody() as object;
        const protectedFields = input['protected_fields'];
        const key = input['key'];
        if (!protectedFields) {
            throw new AppException(400, "Missing protected_fields");
        }
        if (!key) {
            throw new AppException(400, "Missing key");
        }
        if (!(key instanceof Buffer)) {
            throw new AppException(400, "key must be byte array");
        }
        const dataset = input['dataset'];
        if (!dataset) {
            throw new AppException(400, "Missing dataset");
        } 
        // IMPORTANT:
        // Since composable function's handleEvent scope is isolated,
        // we must obtain the class instance to access private functions
        const po = new PostOffice(evt.getHeaders());
        const self = po.getMyClass() as EncryptFields;
        // select the fields to encrypt
        const multiLevels = new MultiLevelMap(dataset);
        const fields = util.split(input['protected_fields'], ", ");
        for (const f of fields) {
            if (multiLevels.exists(f)) {
                const clearText = Buffer.from(String(multiLevels.getElement(f)));
                multiLevels.setElement(f, self.encryptField(clearText, key));
            }
        }
        return multiLevels.getMap();
    }

    encryptField(clearText: Buffer, key: Buffer): string {
        const b = crypto.aesEncrypt(clearText, key);
        return util.bytesToBase64(b);
    }
}