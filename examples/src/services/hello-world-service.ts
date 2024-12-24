import { preload, Composable, EventEnvelope, Logger, 
        AsyncHttpRequest, ObjectStreamReader, AppException, 
        ObjectStreamIO, ObjectStreamWriter, PostOffice } from 'mercury';

const log = Logger.getInstance();

export class HelloWorldService implements Composable {
    static name = 'hello.world'

    @preload(HelloWorldService.name, 10, true) // define as a public function so it can be reached by event-over-http
    initialize(): HelloWorldService {
        return this;
    }

    // Your service should be declared as an async function with input as EventEnvelope
    async handleEvent(evt: EventEnvelope) {
        // Composable function is executed as an anonymous function
        // You can use the PostOffice's getMyClass() method to get its class instance
        const po = new PostOffice(evt.getHeaders());
        const self = po.getMyClass() as HelloWorldService;
        // headers contain tracing metadata and body is the incoming HTTP request
        log.info({'headers': evt.getHeaders(), 'body': evt.getBody()});
        const payload = evt.getBody();
        if (payload && payload instanceof Object) {
            // interpret the incoming HTTP request
            const request = new AsyncHttpRequest(payload);
            if (request) {
                // illustrate multipart upload from a user
                if ('POST' == request.getMethod() && request.getFileName() && request.getStreamRoute()) {
                    const contentType = request.getHeader('content-type');
                    if (contentType && contentType.startsWith('multipart/form-data')) {
                        const len = await self.renderMultiPartFileStream(request.getStreamRoute(), request.getFileName());
                        log.info(`Received ${request.getFileName()} - ${len} bytes`);    
                        return {'filename': request.getFileName(), 'x-stream-id': request.getStreamRoute(), 
                                'service': HelloWorldService.name,
                                'type': contentType, 'size': len};
                    } else {
                        throw new AppException(400, 'Not a multipart file upload');
                    }
                }
                // demonstrate streaming a file to a user
                if ('GET' == request.getMethod() && request.getQueryParameter('download')) {
                    const filename = 'hello.txt';
                    // create a stream and emulate a file for download
                    const stream = new ObjectStreamIO();
                    const streamOut = new ObjectStreamWriter(stream.getOutputStreamId());
                    streamOut.write('Congratulations! If you see this file, this means you have successfully download it from this app.\n\n');
                    streamOut.write('hello world\n');
                    streamOut.write('end of file');
                    streamOut.close();
                    return new EventEnvelope().setHeader('x-stream-id', stream.getInputStreamId())
                                                .setHeader('Content-Type', 'application/octet-stream')
                                                .setHeader('Content-Disposition', `attachment; filename=${filename}`);
                }
                // this is how your app responds with an exception
                if ('GET' == request.getMethod() && request.getQueryParameter('exception')) {
                    throw new AppException(400, 'Just a demo exception');
                }
            }
        }
        // just echo the request as a response
        return new EventEnvelope(evt);
    } 

    async renderMultiPartFileStream(streamId: string, filename: string) {
        let n = 0;
        let len = 0;
        let eof = false;
        const stream = new ObjectStreamReader(streamId, 5000);
        while (!eof) {
            try {
                const block = await stream.read();
                if (block) {
                    n++;
                    if (block instanceof Buffer) {
                        len += block.length;
                        log.info(`Received ${filename}, block-${n} - ${block.length} bytes`)
                    }
                } else {
                    log.info("EOF reached");
                    eof = true;
                }
            } catch (e) {
                const status = e instanceof AppException? e.getStatus() : 500;
                log.error(`Exception - rc=${status}, message=${e.message}`);
                break;
            }
        }
        return len;
    }    
}
