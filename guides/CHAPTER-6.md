# API overview

## Main application

Each application has an entry point. You may implement the main entry point like this:

```javascript
import { Logger, Platform, RestAutomation } from 'mercury';
import { ComposableLoader } from './preload/preload.js'; 

const log = Logger.getInstance();

async function main() {
    // Load composable functions into memory and initialize configuration management
    ComposableLoader.initialize();
    // start REST automation engine
    const server = new RestAutomation();
    server.start();
    // keep the server running
    const platform = Platform.getInstance();
    platform.runForever();
    log.info('Hello world application started');
}

// run the application
main();
```

In this example, the `ComposableLoader` will initialize the configuration management system, 
search and register available user functions into the event system. The default location
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

To enable the REST automation engine, you must use the server.start() command.

To run the application as a service, use the platform.runForever() command. The application can be
stopped with Control-C in interactive mode or the Kill command at the kernel level by a container
management system such as Kubernetes.

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
import { preload, Composable, EventEnvelope, AsyncHttpRequest, Logger } from 'mercury';

const log = Logger.getInstance();

export class DemoAuth implements Composable {

    @preload('v1.api.auth', 5)
    initialize(): DemoAuth {
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

You can define route name, instances, isPublic and isInterceptor in the `preload` annotation.
The default values are instances=1, isPublic=false and isInterceptor=false. In the example, 
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

You can obtain a singleton instance of the Platform object to do the following:

### Register a function

We recommend using the ComposableLoader to search and load your functions.

In some use cases where you want to create and destroy functions on demand, you can register them programmatically.

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

When an application instance starts, a unique ID is generated. We call this the "Origin ID".

```java
const originId = po.getOrigin();
```

## PostOffice API

You can obtain an instance of the PostOffice from the input "headers" parameters in the input
arguments of your function.

```javascript
const po = new PostOffice(evt.getHeaders());
```

The PostOffice is the event manager that you can use to send asynchronous events or to make RPC requests.
The constructor uses the READ only metadata in the "headers" argument in the "handleEvent" method of your function.

### Check if a function is available

You can check if a function with the named route has been deployed.

```javascript
if (po.exists("another.function")) {
    // do something
}
```

### Obtain the class instance of a function

Since a composable function is executed as an anonymous function, the `this` reference is protected inside the
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
2. Example-2 schedules an event to be sent 5 seconds later.

### Make a RPC call

You can make RPC call like this:

```javascript
// example-1
const event = new EventEnvelope().setTo('hello.world').setBody('test message');
const result = await po.request(event, 5000);

// example-2
const result = await po.remoteRequest(event, 'http://peer/api/event');

// API signatures
request(event: EventEnvelope, timeout = 60000): Promise<EventEnvelope>
remoteRequest(event: EventEnvelope, endpoint: string, 
              securityHeaders: object = {}, rpc=true, timeout = 60000): Promise<EventEnvelope>
```

1. Example-1 makes a RPC call with a 5-second timeout to "hello.world".
2. Example-2 makes an "event over HTTP" RPC call to "hello.world" in another application instance called "peer".

"Event over HTTP" is an important topic. Please refer to [Chapter 5](CHAPTER-5.md) for more details.

### Retrieve trace ID and path

If you want to know the route name and optional trace ID and path, you can inspect the incoming event headers.

```javascript
const po = new PostOffice(evt.getHeaders());
const myRoute = po.getMyRoute();
const traceId = po.getMyTraceId();
const tracePath = po.getMyTracePath();
const myInstance = po.getMyInstance();
```

## Configuration API

Your function can access the main application configuration management system like this:

```javascript
const config = AppConfig.getInstance().getReader();
// the value can be string or a primitive
const value = config.get('my.parameter');
// the return value will be converted to a string
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

This will tell the Logger system to use JSON format instead of plain text output. The log output may look like this:

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

The default log format is "text". You can override the value in the "src/resources/application.yml" config file.
The following example sets the log format to "json".

```yaml
log.format: json
```

Alternatively you can also override it at run-time using the "-D" parameter like this:

```shell
node my-app.js -Dlog.format=json
```

The logger supports line-numbering. When you run your executable javascript main program, the line number for each
log message is derived from the ".js" file.

If you want to show the line number in the source ".ts" file for easy debug, you can run your application using
"nodemon". This is illustrated in the "npm start" command in the package.json file.

For simplicity, the logger is implemented without any additional library dependencies.

## Minimalist API design for event orchestration

As a best practice, we advocate a minimalist approach in API integration.
To build powerful composable applications, the above set of APIs is sufficient to perform
"event orchestration" where you write code to coordinate how the various functions work together as a
single "executable". Please refer to [Chapter-4](CHAPTER-4.md) for more details about event orchestration.

Since Mercury is used in production installations, we will exercise the best effort to keep the core API stable.

Other APIs in the toolkits are used internally to build the engine itself, and they may change from time to time.
They are mostly convenient methods and utilities. The engine is fully encapsulated and any internal API changes
are not likely to impact your applications.

## Optional Event Scripting

To further reduce coding effort, you can perform "event orchestration" by configuration using "Event Script".

## Co-existence with other development frameworks

Mercury libraries are designed to co-exist with your favorite frameworks and tools. Inside a class implementing
a composable function, you can use any coding style and frameworks as you like, including sequential, object-oriented
and reactive programming styles.

Mercury has a built-in lightweight non-blocking HTTP server based on Express, but you can also use other
application server framework with it.

## Template application for quick start

You can use the `hello world` project as a template to start writing your own applications.

## Source code update frequency

This project is licensed under the Apache 2.0 open sources license. We will update the public codebase after
it passes regression tests and meets stability and performance benchmarks in our production systems.

The source code is provided as is, meaning that breaking API changes may be introduced from time to time.

## Technical support

For enterprise clients, technical support is available. Please contact your Accenture representative
for details.

<br/>

|            Chapter-5            |                   Home                    |                Chapter-7                |
|:-------------------------------:|:-----------------------------------------:|:---------------------------------------:|
| [Event over HTTP](CHAPTER-5.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Test Driven Development](CHAPTER-7.md) |
