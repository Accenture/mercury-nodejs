import { preload, Composable, EventEnvelope, AsyncHttpRequest, Logger } from 'mercury';

const log = new Logger();

export class DemoAuth implements Composable {
    name: string = "v1.api.auth";

    @preload()
    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
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
