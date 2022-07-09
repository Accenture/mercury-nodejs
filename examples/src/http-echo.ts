import { Logger, Platform, Connector, EventEnvelope, AsyncHttpRequest, AppException } from 'mercury';

// Load system components
const log = new Logger().getInstance();
const platform = new Platform().getInstance();
const connector = new Connector().getInstance();

const MY_HELLO_WORLD = 'hello.world';

// Register and announce that 'hello.world' service is available as this function with EventEnvelope as input
//
// Since this function gets HTTP request event from the REST automation system, we use the AsyncHttpRequest
// as a wrapper for the HTTP event.
platform.register(MY_HELLO_WORLD, (evt: EventEnvelope) => {
    const request = new AsyncHttpRequest(evt.getBody());
    if (request.getMethod()) {
        log.info(`${request.getMethod()} ${request.getUrl()}`);
        return new EventEnvelope().setStatus(200).setHeader('X-Custom-Header', 'Demo').setBody(request.toMap());

    } else {
        throw new AppException(400, 'Input is not a HTTP request object');
    }
});

// Connect to the cloud via language connector
connector.connectToCloud();
