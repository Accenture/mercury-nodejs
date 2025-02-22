# Actuators and HTTP client

## Actuator endpoints

The following are actuator endpoints:

```
GET /info
GET /info/routes
GET /env
GET /health
GET /livenessprobe
```

| Endpoint       | Purpose                                                        | 
|:---------------|:---------------------------------------------------------------|
| /info          | Describe the application                                       |
| /info/routes   | List all private and public function route names               |
| /env           | Show selected environment variables and application parameters |
| /health        | Application health check endpoint                              |
| /livenessprobe | Check if application is running normally                       |

## System provided REST endpoints

When REST automation is turned on, the following essential REST endpoints will be provided if they are
not configured in rest.yaml. The "POST /api/event" is used for Event-Over-HTTP protocol and the others
are actuator endpoints.

To override the default parameters such as timeout, tracing and authentication, you can configure them
in rest.yaml.

```yaml
rest:
  - service: "event.api.service"
    methods: ['POST']
    url: "/api/event"
    timeout: 60s
    tracing: true

  - service: "info.actuator.service"
    methods: ['GET']
    url: "/info"
    timeout: 10s

  - service: "routes.actuator.service"
    methods: ['GET']
    url: "/info/routes"
    timeout: 10s    

  - service: "health.actuator.service"
    methods: ['GET']
    url: "/health"
    timeout: 10s

  - service: "liveness.actuator.service"
    methods: ['GET']
    url: "/livenessprobe"
    timeout: 10s

  - service: "env.actuator.service"
    methods: ['GET']
    url: "/env"
    timeout: 10s
```

## Custom health services

You can extend the "/health" endpoint by implementing a composable functions to be added to the 
"health check" dependencies.

```properties
health.dependencies=database.health, cache.health
```

Your custom health service must respond to the following requests:

1. Info request (type=info) - it should return a map that includes service name and href (protocol, hostname and port)
2. Health check (type=health) - it should return a text string of the health check. e.g. read/write test result. 
   It can throw AppException with status code and error message if health check fails.

> *Note*: The "href" entry in the health service's response should tell the operator about the target URL
          if the dependency connects to a cloud platform service such as Kafka, Redis, etc.   

A sample health service is available in the `health-check.ts` class of the hello world project as follows:

```javascript
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
```

## AsyncHttpClient API

The "async.http.request" function can be used as a non-blocking HTTP client.

To make an HTTP request to an external REST endpoint, you can create an HTTP request object using the
`AsyncHttpRequest` class and make an async RPC call to the "async.http.request" function like this:

```javascript
const po = new PostOffice(evt.getHeaders());
const req = new AsyncHttpRequest();
req.setMethod("GET");
req.setHeader("accept", "application/json");
req.setUrl("/api/hello/world?hello world=abc");
req.setQueryParameter("x1", "y");
const list = new Array<string>();
list.push("a");
list.push("b");
req.setQueryParameter("x2", list);
req.setTargetHost("http://127.0.0.1:8083");
const event = new EventEnvelope().setTo("async.http.request").setBody(req);
const result = po.request(event, 5000).get();
// the response is a Java Future and the result is an EventEnvelope
```

### Send HTTP request body for HTTP PUT, POST and PATCH methods

For most cases, you can just set a JSON object into the request body and specify content-type as JSON.

Example code may look like this:

```javascript
const req = new AsyncHttpRequest();
req.setMethod("POST");
req.setHeader("accept", "application/json");
req.setHeader("content-type", "application/json");
req.setUrl("/api/book");
req.setTargetHost("https://service_provider_host");
req.setBody(jsonKeyValues);
```

## Send HTTP request body as a stream

For larger payload, you may use the streaming method. See sample code below:

```javascript
const stream = new ObjectStreamIO(timeoutInSeconds);
const out = stream.getOutputStream();
out.write(blockOne);
out.write(blockTwo);
// closing the output stream would send a EOF signal to the stream
out.close();
// tell the HTTP client to read the input stream
req.setStreamRoute(stream.getInputStreamId());
```

The AsyncHttpClient service (route name `async.http.request`) uses native Node.js streams to integrate
with the underlying Axios HTTP client. It uses the temporary local file system (folder `/tmp/composable/node/temp-streams`)
to reduce memory footprint. This makes the producer and consumer of a stream asynchronous. i.e. The producer
can write data blocks into a stream before a consumer is available.

## Read HTTP response body stream

If content length is not given, the response body will be received as a stream.

Your application should check if the HTTP response header "stream" exists. Its value is the input "stream ID".

Sample code to read a stream may look like this:

```javascript
static async downloadFile(streamId: string, filename: string) {
   let n = 0;
   let len = 0;
   const stream = new ObjectStreamReader(streamId, 5000);
   while (true) {
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
            break;
         }
      } catch (e) {
         const status = e instanceof AppException? e.getStatus() : 500;
         log.error(`Exception - rc=${status}, message=${e.message}`);
         break;
      }

   }
   return len;
} 
```

## Content length for HTTP request

*IMPORTANT*: Do not set the "content-length" HTTP header because the system will automatically compute the
correct content-length for small payload. For large payload, it will use the chunking method.

## Application log format

The system supports 3 types of log formats. You can set "log.format" parameter in application.yml to
change the log format or override it at runtime using the `-D` argument. e.g.

```shell
node myapp.js -Dlog.format=json
```

| Format  | Description                                                                   | 
|:--------|:------------------------------------------------------------------------------|
| text    | this is the default log format                                                |
| json    | application log will be printed in JSON format with line feed and indentation |
| compact | JSON format without line feed and indentation                                 |

text and json formats are for human readers and compact format is designed for log analytics system.

## Externalize the application.yml

If you want to externalize the application.yml configuration file, please keep a default application.yml
in the "src/resources" folder. You can use command line to ask the system to reload a new base configuration
file like this:

```shell
node myapp.js -Dlog.format=json -C/tmp/config/application.yml
```

> *Note*: The `-C` command argument should point to a fully qualified file path. Use relative path
  if you know exactly the resolved path in a deployed container. You can have multiple "-D" parameters
  but you can only configure a single "-C" argument.
<br/>

|             Appendix-I              |                   Home                    | 
|:-----------------------------------:|:-----------------------------------------:|
| [Application config](APPENDIX-I.md) | [Table of Contents](TABLE-OF-CONTENTS.md) |
