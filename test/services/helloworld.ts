import { AppException } from "../../src/models/app-exception";
import { AsyncHttpRequest } from "../../src/models/async-http-request";
import { Composable } from "../../src/models/composable";
import { EventEnvelope } from "../../src/models/event-envelope";
import { Utility } from '../../src/util/utility';
import { PostOffice } from '../../src/system/post-office';

const util = new Utility();

const TYPE = 'type';
const ERROR = 'error';
const METADATA = 'metadata';
const TIMEOUT = 'timeout';
const HELLO_INSTANCE = 'x-hello-instance';
const DEMO_EXCEPTION = 'demo exception';

export class HelloWorld implements Composable {

    name = "demo.library.function";

    initialize(): void {
        throw new Error("Method not implemented.");
    }
    getName(): string {
        return this.name;
    }
    async handleEvent(evt: EventEnvelope) {
        const po = new PostOffice(evt.getHeaders());
        if (METADATA == evt.getHeader(TYPE)) {
            return {'route': po.getMyRoute(), 'trace_id': po.getMyTraceId(), 'trace_path': po.getMyTracePath()};
        } else if (TIMEOUT == evt.getHeader(TYPE)) {
            // simulate artificial delay to keep the worker instance busy,
            // thus leaving remaining workers to serve additional requests.
            await util.sleep(500);
            return TIMEOUT;
        } else if (ERROR == evt.getHeader(TYPE)) {
            throw new AppException(400, DEMO_EXCEPTION);
        } else {
            if ('my_instance' in evt.getHeaders()) {
                evt.setHeader(HELLO_INSTANCE, evt.getHeader('my_instance'));
            }
            const body = evt.getBody();
            if (typeof body == 'object') {
                const request = new AsyncHttpRequest(evt.getBody() as object);
                if ('PUT' == request.getMethod()) {
                const reqBody = request.getBody();
                if (reqBody instanceof Buffer) {
                    // convert byte array into base64 before returning to user
                    request.setBody(reqBody.toString('base64'));
                    const result = new EventEnvelope(evt);
                    result.setBody(request.toMap());
                    return result;
                }
                }
            }
            return new EventEnvelope(evt);
        } 
    }
}

// Since this is a service inside the "test" folder, it requires at least one test. It is a placeholder.
describe('initiation tests', () => {   
      
    it('can instantiate a new Composable', async () => {
        const hello = new HelloWorld();
        expect(hello).toBeTruthy();
        expect(hello.getName()).toBe("demo.library.function");
    });     

}); 

