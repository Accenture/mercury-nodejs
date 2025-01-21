# REST automation

The foundation library contains a built-in non-blocking HTTP server that you can use to create REST
endpoints. Behind the curtain, it is using the Express server library, and we extend it to support dynamic creation
of REST endpoints.

The REST automation system is not a code generator. The REST endpoints in the rest.yaml file are handled by
the system directly - "Config is the code".

We will use the "rest.yaml" sample configuration file in the "composable-example" app to elaborate the configuration
approach.

The rest.yaml configuration has three sections:

1. REST endpoint definition
2. CORS header processing
3. HTTP header transformation

## Turn on the REST automation engine

REST automation is optional. To turn on REST automation, add the REST automation start up script in your main app:

```javascript
import { Logger, Platform, RestAutomation } from 'mercury-composable';
import { ComposableLoader } from '../preload/preload.js'; 
...
async function main() {
    // Load composable functions into memory and initialize configuration management
    ComposableLoader.initialize();  
    // keep the server running
    const platform = Platform.getInstance();
    platform.runForever();
    log.info('Composable application started');
}
main();
```

> *Note*: The class "preload.ts" is automatically generated when you do "npm run preload" or "npm run build".
  The compiled file is located in the "dist/preload/preload.js". Therefore, you must use an import statement for
  '../preload/preload.js'.

Please review the "composable-example.ts" for more details.

The `yaml.rest.automation` parameter in the application.yml file tells the system the location of the rest.yaml 
configuration file. The default value is "classpath:/rest.yaml". The `classpath:/` prefix means that the config
file is available under the "src/resources" folder in your project. If you want the rest.yaml configuration
file to be externalized to the local file system, you can use the `file:/` prefix. e.g. "file:/tmp/config/rest.yaml".

```yaml
yaml.rest.automation: 'classpath:/rest.yaml'
```

## Defining a REST endpoint

The "rest" section of the rest.yaml configuration file may contain one or more REST endpoints.

A REST endpoint may look like this:

```yaml
  - service: ["hello.world"]
    methods: ['GET', 'PUT', 'POST', 'HEAD', 'PATCH', 'DELETE']
    url: "/api/hello/world"
    timeout: 10s
    cors: cors_1
    headers: header_1
    authentication: 'v1.api.auth'
    tracing: true
```

In this example, the URL for the REST endpoint is "/api/hello/world" and it accepts a list of HTTP methods.
When an HTTP request is sent to the URL, the HTTP event will be sent to the function declared with service
route name "hello.world". The input event "body" will be an "AsyncHttpRequest" object. You can retrieve HTTP
metadata such as method, url path, HTTP request headers from the object.

The "timeout" value is the maximum time that REST endpoint will wait for a response from your function.
If there is no response within the specified time interval, the user will receive an HTTP-408 timeout exception.

The "authentication" tag is optional. If configured, the route name given in the authentication tag will be used.
The input event will be delivered to a function with the authentication route name. In this example, it is
"v1.api.auth".

Your custom authentication function may look like this:

```javascript
export class DemoAuth implements Composable {

    @preload('v1.api.auth')
    initialize(): Composable {
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
```

Your authentication function can return a boolean value to indicate if the request should be accepted or rejected.
Optionally, you can also return an EventEnvelope containing a boolean body and a set of key-values in the headers.

If true, the system will send the HTTP request to the service. In this example, it is the "hello.world" function.
If false, the user will receive an "HTTP-401 Unauthorized" exception.

Optionally, you can use the authentication function to return some session information after authentication.
For example, your authentication can forward the "Authorization" header of the incoming HTTP request to your
organization's OAuth 2.0 Identity Provider for authentication.

To return session information to the next function, the authentication function can return an EventEnvelope.
It can set the session information as key-values in the response event headers.

You can test this by visiting http://127.0.0.1:8086/api/hello/world to invoke the "hello.world" function.

The console will print:
```shell
INFO {"trace":{"origin":"11efb0d8fcff4924b90aaf738deabed0",
      "id":"4dd5db2e64b54eef8746ab5fbb4489a3","path":"GET /api/hello/world",
      "service":"v1.api.auth","start":"2023-06-10T00:01:07.492Z","success":true,
      "exec_time":0.525,"round_trip":0.8,"from":"http.request"}} (handleEvent:tracer.js:27)
INFO {"trace":{"origin":"11efb0d8fcff4924b90aaf738deabed0",
      "id":"4dd5db2e64b54eef8746ab5fbb4489a3","path":"GET /api/hello/world",
      "service":"hello.world","start":"2023-06-10T00:01:07.495Z","success":true,
      "exec_time":0.478,"round_trip":1.238,"from":"http.request"}} (handleEvent:tracer.js:27)                              
```

This illustrates that the HTTP request has been processed by the "v1.api.auth" function.

The `tracing` parameter tells the system to turn on "distributed tracing". In the console log shown above, you see
two lines of log from "distributed trace" showing that the HTTP request is processed by "v1.api.auth" and
"hello.world" before returning result to the browser.

The optional `cors` and `headers` sections point to the specific CORS and HEADERS sections respectively.

## CORS section

For ease of development, you can define CORS headers using the CORS section like this.

This is a convenient feature for development. For cloud native production system, it is most likely that
CORS processing is done at the API gateway level.

You can define different sets of CORS headers using different IDs.

```yaml
cors:
  - id: cors_1
    options:
      - "Access-Control-Allow-Origin: ${api.origin:*}"
      - "Access-Control-Allow-Methods: GET, DELETE, PUT, POST, PATCH, OPTIONS"
      - "Access-Control-Allow-Headers: Origin, Authorization, X-Session-Id, X-Correlation-Id,
                                       Accept, Content-Type, X-Requested-With"
      - "Access-Control-Max-Age: 86400"
    headers:
      - "Access-Control-Allow-Origin: ${api.origin:*}"
      - "Access-Control-Allow-Methods: GET, DELETE, PUT, POST, PATCH, OPTIONS"
      - "Access-Control-Allow-Headers: Origin, Authorization, X-Session-Id, X-Correlation-Id, 
                                       Accept, Content-Type, X-Requested-With"
      - "Access-Control-Allow-Credentials: true"
```

## HEADERS section

The HEADERS section is used to do some simple transformation for HTTP request and response headers.

You can add, keep or drop headers for HTTP request and response. Sample HEADERS section is shown below.

```yaml
headers:
  - id: header_1
    request:
      #
      # headers to be inserted
      #    add: ["hello-world: nice"]
      #
      # keep and drop are mutually exclusive where keep has precedent over drop
      # i.e. when keep is not empty, it will drop all headers except those to be kept
      # when keep is empty and drop is not, it will drop only the headers in the drop list
      # e.g.
      # keep: ['x-session-id', 'user-agent']
      # drop: ['Upgrade-Insecure-Requests', 'cache-control', 'accept-encoding', 'host', 'connection']
      #
      drop: ['Upgrade-Insecure-Requests', 'cache-control', 'accept-encoding', 'host', 'connection']

    response:
      #
      # the system can filter the response headers set by a target service,
      # but it cannot remove any response headers set by the underlying servlet container.
      # However, you may override non-essential headers using the "add" directive.
      # i.e. don't touch essential headers such as content-length.
      #
      #     keep: ['only_this_header_and_drop_all']
      #     drop: ['drop_only_these_headers', 'another_drop_header']
      #
      #      add: ["server: mercury"]
      #
      # You may want to add cache-control to disable browser and CDN caching.
      # add: ["Cache-Control: no-cache, no-store", "Pragma: no-cache", 
      #       "Expires: Thu, 01 Jan 1970 00:00:00 GMT"]
      #
      add:
        - "Strict-Transport-Security: max-age=31536000"
        - "Cache-Control: no-cache, no-store"
        - "Pragma: no-cache"
        - "Expires: Thu, 01 Jan 1970 00:00:00 GMT"
```

## Feature variation from the Java version

To support multipart upload, a REST endpoint entry must have the parameter `upload: true`. The is not required
in the Java version because automatic switching to multipart rendering is supported in the underlying Netty
HTTP server.

In the Node.js version, the underlying HTTP server is Express. We have configured the bodyParser to render
HTTP request body in this order:

1. URL encoded parameters
2. JSON text
3. "application/xml" or content type starts with "text/"
4. "multipart/form-data" for file upload
5. all other types of content will be rendered as byte array (Buffer) with a payload limit of 2 MB
<br/>

|                   Chapter-2                   |                   Home                    |              Chapter-4              |
|:---------------------------------------------:|:-----------------------------------------:|:-----------------------------------:|
| [Function Execution Strategies](CHAPTER-2.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Event Script Syntax](CHAPTER-4.md) |