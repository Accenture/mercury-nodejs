import { preload, Composable, EventEnvelope, AppException } from 'mercury-composable';

const TYPE = 'type';
const INFO = 'info';
const HEALTH = 'health';

export class DemoHealthCheck implements Composable {

    @preload('demo.health')
    initialize(): Composable {
        return this;
    }

    // Your service should be declared as an async function with input as EventEnvelope
    async handleEvent(evt: EventEnvelope) {
        const command = evt.getHeader(TYPE);
        if (command == INFO) {
          return {'service': 'demo.service', 'href': 'http://127.0.0.1'};
        }
        if (command == HEALTH) {
          // this is a dummy health check
          return {'status': 'demo.service is running fine'};
        }
        throw new AppException(400, 'Request type must be info or health');
    }
}