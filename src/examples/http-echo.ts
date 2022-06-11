import { Logger } from "../util/logger.js";
import { Platform } from "../system/platform.js";
import { EventEnvelope } from '../models/event-envelope.js';
import { AsyncHttpRequest } from "../models/async-http-request.js";
import { AppException } from "../models/app-exception.js";
// import and start worker thread in the background
import { Connector } from '../cloud/connector.js';

const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();

platform.register('hello.world', (evt: EventEnvelope) => {
    const request = new AsyncHttpRequest(evt.getBody());
    if (request.getMethod()) {
        log.info(request.getMethod()+' '+request.getUrl());
        return new EventEnvelope().setStatus(200).setHeader('X-Custom-Header', 'Demo').setBody(request.toMap());

    } else {
        throw new AppException(400, 'Input is not a HTTP request object');
    }
});

connector.connectToCloud();
