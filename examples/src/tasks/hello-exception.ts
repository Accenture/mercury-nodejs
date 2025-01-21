import { Composable, EventEnvelope, preload, Logger } from "mercury-composable";

const log = Logger.getInstance();

export class HelloException implements Composable {

    @preload('v1.hello.exception', 10)
    initialize(): Composable {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        const input = evt.getBody() as object;        
        if ('stack' in input) {
            const stack = String(input['stack']).split('\n').map(v => v.trim()).filter(v => v);
            log.info({'stack': stack});
        }            
        if ('status' in input && 'message' in input) {
            log.info(`User defined exception handler - status=${input['status']} error=${input['message']}`);
            const error = {};
            error['type'] = 'error';
            error['status'] = input['status'];
            error['message'] = input['message'];
            return error;
        } else {
            return {};
        }
    }
}