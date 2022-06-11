import { Logger } from "../util/logger.js";
import { Platform } from "../system/platform.js";
import { EventEnvelope } from '../models/event-envelope.js';
// import and start worker thread in the background
import { Connector } from '../cloud/connector.js';

const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();

platform.register('hello.world', (evt: EventEnvelope) => {
    log.info('GOT headers='+JSON.stringify(evt.getHeaders())+", body="+JSON.stringify(evt.getBody()));
    return evt.getBody();
});

connector.connectToCloud();
