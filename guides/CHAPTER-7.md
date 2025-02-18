# API overview

## Main application

Each application has an entry point. You may implement the main entry point like this:

```javascript
import { Logger, Platform, RestAutomation } from 'mercury-composable';
import { ComposableLoader } from './preload/preload.js'; 

const log = Logger.getInstance();

async function main() {
    // Load composable functions into memory and initialize configuration management
    ComposableLoader.initialize();
    const platform = Platform.getInstance();
    platform.runForever();
    log.info('Composable application started');
}

// run the application
main();
```

In this example, the `ComposableLoader` will initialize the configuration management system, the REST
automation system, and register user composable functions into the event system. The default location
of the system files is the "src/resources" folder.

| File / bundle   | Purpose                                                                            |
|:----------------|:-----------------------------------------------------------------------------------|
| application.yml | Base configuration file is assumed to be under the "src/resources" folder          |
| rest.yaml       | REST endpoint configuration file is assumed to be under the "src/resources" folder |
| HTML bundle     | HTML/CSS/JS files, if any, can be placed under the "src/resources/public" folder   |

To tell the system to use a different application.yml, you can use this following statement before
running the `ComposableLoader.initialize()` command.

```javascript
// resourcePath should be a fully qualified file path to the application's "resources" folder.
const appConfig = AppConfig.getInstance(resourcePath);
log.info(`Base configuration ${appConfig.getId()}`); 
```

You may override the file path for REST endpoint configuration and HTML bundle with the following:

```yaml
yaml.rest.automation: 'classpath:/rest.yaml'
static.html.folder: 'classpath:/public'
```

The application can be stopped with Control-C in interactive mode or the Kill command at the kernel level
by a container management system such as Kubernetes.

## Event envelope

A composable application is a collection of functions that communicate with each other in events.
Each event is transported by an event envelope. Let's examine the envelope.

There are 3 elements in an event envelope:

| Element | Type     | Purpose                                                                                                           |
|:-------:|:---------|:------------------------------------------------------------------------------------------------------------------|
|    1    | metadata | Includes unique ID, target function name, reply address<br/> correlation ID, status, exception, trace ID and path |
|    2    | headers  | User defined key-value pairs                                                                                      |
|    3    | body     | Event payload (primitive or JSON object)                                                                          |

Headers and body are optional, but you must provide at least one of them.

## Custom exception using AppException

To reject an incoming request, you can throw an AppException like this:

```java
throw new AppException(400, "My custom error message");
```

As a best practice, we recommend using error codes that are compatible with HTTP status codes.

## Defining a user function in TypeScript

You can write a function like this:

```javascript
import { preload, Composable, EventEnvelope, AsyncHttpRequest, Logger } from 'mercury-composable';

const log = Logger.getInstance();

export class DemoAuth implements Composable {

    @preload('v1.api.auth', 5)
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

You can define route name, instances, isPublic and interceptor in the `preload` annotation.
The default values are instances=1, isPublic=false and interceptor=false. In the example, 
the number of instances is set to 5. You can set the number of instances from 1 to 500.

The above example is a demo "API authentication" function. The event body is an AsyncHttpRequest object
from the user because the "rest.yaml" routes the HTTP request to the function via its unique "route name".

## Inspect event metadata

There are some reserved metadata for route name ("my_route"), trace ID ("my_trace_id") and trace path ("my_trace_path")
in the event's headers. They do not exist in the incoming event envelope. The system automatically
insert them as read-only metadata.

You may inspect other event metadata such as the replyTo address and correlation ID.

Note that the "replyTo" address is optional. It only exists when the caller is making an RPC request or callback to
your function. If the caller sends an asynchronous drop-n-forget request, the "replyTo" value is null.

## Platform API

You can obtain a singleton instance of the Platform object like this:

```javascript
const platform = Platform.getInstance();
```

### Register a function

We recommend using the ComposableLoader to search and load your functions.

In some use cases where you want to create and destroy functions on demand, you can register them programmatically.
For example,

```javascript
platform.register(HELLO_BFF_SERVICE, new HelloBff());

```

### What is a public function?

A public function is visible by any application instances in the same network. When a function is declared as
"public", the function is reachable through the Event-over-HTTP API REST endpoint.

A private function is invisible outside the memory space of the application instance that it resides.
This allows application to encapsulate business logic according to domain boundary. You can assemble closely
related functions as a composable application that can be deployed independently.

### Release a function

In some use cases, you want to release a function on-demand when it is no longer required.

```javascript
platform.release("another.function");
```

The above API will unload the function from memory and release it from the "event loop".

### Obtain the unique application instance ID

When an application instance starts, a unique ID is generated.

```javascritp
const originId = po.getId();
```

## PostOffice API

You can obtain an instance of the PostOffice from the input "headers" parameters in the input
arguments of your function.

```javascript
const po = new PostOffice(evt.getHeaders());
```

The PostOffice is the event emitter that you can use to send asynchronous events or to make RPC requests.
The constructor uses the metadata in the "headers" argument to create a trackable instance of the event emitter.

For end-to-end traceability, please use the PostOffice instance to make requests to a composable library.
It maintains the same traceId and tracePath in the traceability graph. If your handleEvent method calls another
method in your class, you should pass this PostOffice instance so that any event calls from the other method
can propagate the tracing information.

For Unit Tests, since a test does not start with the handleEvent of a LambdaFunction, you can use the following
to create a PostOffice with your own traceId. The "myRoute" is the caller's route name. In this case, you can
set it to "unit.test".

```java
// create a PostOffice instance in a Unit Test
const po = new PostOffice(new Sender(myRoute, traceId, tracePath));
```

### Check if a function is available

You can check if a function with the named route has been deployed.

```javascript
if (po.exists("another.function")) {
    // do something
}
```

### Obtain the class instance of a function

Since a composable function is executed as an anonymous function, the `this` reference is `undefined` inside the
functional scope and thus no longer relevant to the class scope.

To invoke other methods in the same class holding the composable function, the "getMyClass()" API can be used.

```javascript
async handleEvent(evt: EventEnvelope) {
    const po = new PostOffice(evt.getHeaders());
    const self = po.getMyClass() as HelloWorldService;
    // business logic here
    const len = await self.downloadFile(request.getStreamRoute(), request.getFileName());
}
```

In the above example, `HelloWorldService` is the Composable class and the `downloadFile` is a non-static method
in the same class. Note that you must use the event headers to instantiate the PostOffice object.

### Retrieve routing metadata of my function

The following code segment demonstrates that you can retrieve the function's route name, worker number,
optional traceId and tracePath.

```javascript
async handleEvent(evt: EventEnvelope) {
    const po = new PostOffice(evt.getHeaders());
    const route = po.getMyRoute();
    const workerNumber = po.getMyInstance();
    const traceId = po.getMyTraceId();
    const tracePath = po.getMyTracePath();
    // processing logic here
}
```

### Send an asynchronous event to a function

You can send an asynchronous event like this.

```javascript
// example-1
const event = new EventEnvelope().setTo('hello.world').setBody('test message');
po.send(event);

// example-2
po.sendLater(event, 5000);
```

1. Example-1 sends the text string "test message" to the target service named "hello.world".
2. Example-2 schedules an event to be delivered 5 seconds later.

### Make a RPC call

You can make RPC call like this:

```javascript
// example-1
const event = new EventEnvelope().setTo('hello.world').setBody('test message');
// the response is a result event
const result = await po.request(event, 5000);

// example-2
const result = await po.remoteRequest(event, 'http://peer/api/event');

// API signatures
request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope>
remoteRequest(event: EventEnvelope, endpoint: string, 
              securityHeaders: object = {}, rpc=true, timeout = 60000): Promise<EventEnvelope>
```

1. Example-1 makes a RPC call with a 5-second timeout to "hello.world".
2. Example-2 makes an "event over HTTP" RPC call to "hello.world" in another application instance.

"Event over HTTP" is an important topic. Please refer to [Chapter 6](CHAPTER-6.md) for more details.

### Make a fork-n-join parallel RPC

You can make fork-n-join parallel request like this:

```javascript
// example
const event1 = new EventEnvelope().setTo('hello.world.1').setBody('test message one');
const event2 = new EventEnvelope().setTo('hello.world.2').setBody('test message two');
const events = [event1, event2];
// the response is a list of result events
const response = await po.parallelRequest(events, 5000);

// API signature
parallelRequest(events: Array<EventEnvelope>, timeout = 60000): Promise<Array<EventEnvelope>>
```

1. Example-1 makes a RPC call with a 5-second timeout to "hello.world".
2. Example-2 makes an "event over HTTP" RPC call to "hello.world" in another application instance.

"Event over HTTP" is an important topic. Please refer to [Chapter 6](CHAPTER-6.md) for more details.

### Retrieve trace ID and path

If you want to know the route name and optional trace ID and path, you can inspect the incoming
event headers.

```javascript
const po = new PostOffice(evt.getHeaders());
const myRoute = po.getMyRoute();
const traceId = po.getMyTraceId();
const tracePath = po.getMyTracePath();
const myInstance = po.getMyInstance();
```

## Trace annotation

You can add a *small number of annotations* if the event to your function has tracing enabled.
Annotated value can be a text string, a JSON object of key-values or a list of text strings.

```javascript
async handleEvent(evt: EventEnvelope) {
    // business logic to handle the incoming event
    // ...
    // annotate the event
    evt.annotate("hello", "world");
```

Annotations of key-values, if any, will be recorded in the trace and they are not accessible by
another function.

The annotated key-values will be shown in the trace like this:

```json
"annotations": {"hello": "world"}
```

> *Note*: Don't annotate sensitive information or secrets such as PII, PHI, PCI data because 
          the trace is visible in the application log. It may also be forwarded to a centralized
          telemetry dashboard for visualization and analytics.

## Configuration API

Your function can access the main application configuration management system like this:

```javascript
const config = AppConfig.getInstance();
// the value can be string, a primitive or a JSON object
const value = config.get('my.parameter');
// the value can be read as a string
const text = config.getProperty('my.parameter');
```

The system uses the standard dot-bracket format for a parameter name.

> e.g. "hello.world", "some.key[2]"

You can also override the main application configuration using the `set` method.

Additional configuration files can be added with the `ConfigReader` API like this:

```javascript
const myConfig = new ConfigReader(filePath);
```

where filePath can use the `classpath:/` or `file:/` prefix.

The configuration system supports environment variable or reference to the main application configuration
using the dollar-bracket syntax `${reference:default_value}`.

> e.g. "some.key=${MY_ENV_VARIABLE}", "some.key=${my.key}"

## Override configuration parameters at run-time

You can override any configuration parameter from the command line when starting your application.

```shell
node my-app.js -Dsome.key=some_value -Danother.key=another_value
```

You can point your application to use a different base configuration file like this:

```shell
node my-app.js -C/opt/config/application.yml
```

The `-C` command line argument tells the system to use the configuration file in "/opt/config/application.yml".

> Exercise: try this command "node hello-world.js -Dlog.format=json" to start the demo app

This will tell the Logger system to use JSON format instead of plain text output. The log output may
look like this:

```text
{
  "time": "2023-06-10 09:51:20.884",
  "level": "INFO",
  "message": "Event system started - 9f5c99c4d21a42cfb0115cfbaf533820",
  "module": "platform.js:441"
}
{
  "time": "2023-06-10 09:51:21.037",
  "level": "INFO",
  "message": "REST automation service started on port 8085",
  "module": "rest-automation.js:226"
}
```

## Logger

The system includes a built-in logger that can log in either text or json format.

The default log format is "text". You can override the value in the "src/resources/application.yml"
config file. The following example sets the log format to "json".

```yaml
log.format: json
```

Alternatively you can also override it at run-time using the "-D" parameter like this:

```shell
node my-app.js -Dlog.format=json
```

The logger supports line-numbering. When you run your executable javascript main program, the line number
for each log message is derived from the ".js" file compiled from the ".ts" files.

If you want to show the line number in the source ".ts" file for easy debug, you may test your application
using "nodemon".

For simplicity, the logger is implemented without any additional library dependencies.

## Minimalist API design

For configuration based Event Choreography, please refer to [Chapter-4](CHAPTER-4.md) for more details.

You can build powerful composable application without a lot of APIs. "Less" is always better in
composable methodology.

We do not recommend "event orchestration by code" because it would lead to tight coupling of software
modules.

## Co-existence with other development frameworks

Mercury libraries are designed to co-exist with your favorite frameworks and tools. Inside a class implementing
a composable function, you can use any coding style and frameworks as you like, including sequential, object-oriented
and reactive programming styles.

Mercury has a built-in lightweight non-blocking HTTP server based on Express, but you can also use other
application server framework with it.

## Template application for quick start

You can use the `composable-example` project as a template to start writing your own applications.

## Source code update frequency

This project is licensed under the Apache 2.0 open sources license. We will update the public codebase after
it passes regression tests and meets stability and performance benchmarks in our production systems.

Mercury Composable is developed as an engine for you to build the latest cloud native applications.

Composable technology is evolving rapidly. We would exercise best effort to keep the essential internals
and core APIs stable. Please browse the latest Developer Guide, release notes and Javadoc for any breaking
API changes.

## Technical support

For enterprise clients, technical support is available. Please contact your Accenture representative for details.
<br/>

|            Chapter-5            |                   Home                    |         Appendix-I          |
|:-------------------------------:|:-----------------------------------------:|:---------------------------:|
| [Event over HTTP](CHAPTER-5.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Appendix-I](APPENDIX-I.md) |
