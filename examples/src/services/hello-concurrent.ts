import { preload, Composable, EventEnvelope, Logger, AppException, PostOffice } from 'mercury-composable';

const log = Logger.getInstance();

export class HelloConcurrent implements Composable {
    static routeName = 'hello.concurrent'

    @preload(HelloConcurrent.routeName, 10)
    initialize(): Composable {
        return this;
    }

    // Your service should be declared as an async function with input as EventEnvelope
    async handleEvent(evt: EventEnvelope) {
        const po = new PostOffice(evt.getHeaders());
        const myInstance = po.getMyInstance();
        // headers contain tracing metadata and body is the incoming HTTP request
        log.info(`request received by instance #${myInstance}`);
        // just echo the request using the no.op function
        if (po.exists('no.op')) {
            // create a list of 10 events
            const req = evt.setTo('no.op');
            const events = [req, req, req, req, req, req, req, req, req, req];
            const response = await po.parallelRequest(events);
            let n = 0;
            const consolidated = {};
            for (const res of response) {
                n++;
                const result = {};
                result['event'] = res.getBody();
                result['exec_time'] = res.getExecTime();
                result['round_trip'] = res.getRoundTrip();
                consolidated[`result-${n}`] = result;
            }
            return consolidated;
        } else {
            throw new AppException(503, 'no.op service is not reachable');
        }        
    }    
}
