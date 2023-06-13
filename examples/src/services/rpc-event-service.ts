import { preload, Composable, EventEnvelope, AppException, Platform, PostOffice, Logger } from 'mercury';
const log = new Logger();
const REMOTE_EVENT_ENDPOINT = 'http://127.0.0.1:8085/api/event';
const REMOTE_NAME = 'hello.world';
export class RpcEvent implements Composable {
    name = "rpc.event";

    @preload()
    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
    }

    // Your service should be declared as an async function with input as EventEnvelope
    async handleEvent(evt: EventEnvelope) {
        log.info(evt);
        const returnObj = {'service': 'rpc.service', 'href': 'http://127.0.0.1:8086/api/', received: []};
        let exception: AppException = null;
         // po.remoteRequest API requires AsyncHttpClient in the platform core
        const platform = new Platform();
       
        log.info(`Platform ${platform.getOriginId()} ready`)
        // Obtain a trackable PostOffice instance to enable distributed tracing
        const po = new PostOffice({'my_route': 'rpc.demo', 'my_trace_id': '2000', 'my_trace_path': '/api/remote/java'});
        // Make multiple RPC calls to the service
        for (let i=1; i <= 3; i++) {
            const msg = "Calling Remote from Node Mercury ID: " + i;
            // the default timeout is one minute if you do not provide the "timeout" value for RPC
            const req = new EventEnvelope().setTo(REMOTE_NAME).setHeader('n', String(i)).setBody(msg);
            const result = await po.remoteRequest(req, REMOTE_EVENT_ENDPOINT);
            if (result.getStatus() == 200) {
                if (result.getBody()) {
                    returnObj.received.push(result.getBody());
                }
            } else {
                const errStr = `Unable to connect to ${REMOTE_EVENT_ENDPOINT} - HTTP-${result.getStatus()} - ${result.getBody()}`;
                log.error(errStr);
                exception = new AppException(500, errStr);
                break;
            }
        }
        return exception ? exception : returnObj;
    }
}