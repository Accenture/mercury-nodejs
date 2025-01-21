import { AppException, Composable, EventEnvelope, preload, Utility, Logger, MultiLevelMap } from "mercury-composable";
import fs from 'fs';

const log = Logger.getInstance();
const util = new Utility();

const TEMP_DATA_STORE = "/tmp/store";
const JSON_EXT = ".json";

export class SaveProfile implements Composable {

    @preload('v1.save.profile', 10)
    initialize(): Composable {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        const input = evt.getBody() as object;
        const profileId = input['id'];
        if (!profileId) {
            throw new AppException(400, 'Missing id in profile');
        }
        const requiredFields = evt.getHeader('required_fields');
        if (!requiredFields) {
            throw new AppException(400, "Missing required_fields");
        }
        const dataset = new MultiLevelMap(input);
        const fields = util.split(requiredFields, ", ");
        for (const f of fields) {
            if (!dataset.exists(f)) {
                throw new AppException(400, "Missing " + f);
            }
        }
        // save only fields that are in the interface contract
        const filtered = new MultiLevelMap();
        for (const f of fields) {
            filtered.setElement(f, dataset.getElement(f));
        }
        const text = JSON.stringify(filtered.getMap(), null, 2);
        if (!fs.existsSync(TEMP_DATA_STORE)) {
            fs.mkdirSync(TEMP_DATA_STORE);
        }
        const file = `${TEMP_DATA_STORE}/${profileId}${JSON_EXT}`;
        await util.str2file(file, text);
        log.info(`Profile ${profileId} saved`);
        // this task does not have any output
        return null;
    }
}