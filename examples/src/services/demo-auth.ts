import { preload, Composable, EventEnvelope, AsyncHttpRequest, Logger } from 'mercury';

const log = Logger.getInstance();

export class DemoAuth implements Composable {

    @preload('v1.api.auth')
    initialize(): DemoAuth {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        const req = new AsyncHttpRequest(evt.getBody() as object);
        const method = req.getMethod();
        const url = req.getUrl();
        log.info(`${method} ${url} authenticated`);
        // this is a demo so we approve all requests
        return true;
    }
}
