# API overview

## Main application

Each application has an entry point. You may implement the main entry point like this:

```javascript
import { Logger, Platform, RestAutomation } from 'mercury';
import { ComposableLoader } from './preload/preload.js'; 
import { fileURLToPath } from "url";

const log = new Logger();
const REST_AUTOMATION_YAML = "rest.automation.yaml";
const STATIC_HTML_FOLDER = "static.html.folder";

function getResourceFoler() {
    const folder = fileURLToPath(new URL("./resources/", import.meta.url));
    return folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
}

async function main() {
    const resources = getResourceFoler();
    // Start platform with user provided config file
    // IMPORTANT - this must be the first instantiation of the Platform object in your application
    const configFile = resources + 'application.yml';
    const platform = new Platform(configFile);
    // Locate the REST automation config file
    const restYaml = resources + 'rest.yaml';
    const appConfig = platform.getConfig();
    // Set configuration parameter before starting REST automation
    if (!appConfig.exists(REST_AUTOMATION_YAML)) {
        appConfig.set(REST_AUTOMATION_YAML, restYaml);
    }
    if (!appConfig.exists(STATIC_HTML_FOLDER)) {
        appConfig.set(STATIC_HTML_FOLDER, resources + 'public');
    }
    // Load composable functions into memory
    ComposableLoader.initialize();
    // start REST automation engine
    const server = new RestAutomation();
    server.start();
    platform.runForever();
    log.info('Hello world application started');
}

// run this application
main();
```

In this example, it tells the system where to find its configuration files for "application.yml" and
"rest.yaml". It also instructs the system about the location of the HTML static folder.

Note that the input to the "Platform" object is the config file location.

Then it performs the following:

1. Run the "ComposableLoader" to load user functions into memory
2. Start the REST automation engine
3. Tell the system to run as a service (`platform.runForever`)

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

const log = new Logger();

export class DemoAuth implements Composable {
    name: string = "v1.api.auth";

    @preload()
    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
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

The above example is a demo "API authentication" function. The event body is an AsyncHttpRequest object from the user
because the "rest.yaml" routes the HTTP request to the function via its unique "route name".

## Inspect event metadata

There are some reserved metadata for route name ("my_route"), trace ID ("my_trace_id") and trace path ("my_trace_path")
in the event's headers. They do not exist in the incoming event envelope. Instead, the system automatically
insert them as read-only metadata.

They are used when your code wants to obtain an instance of the PostOffice API.

You can also inspect other event metadata such as the replyTo address and correlation ID.

Note that the "replyTo" address is optional. It only exists when the caller is making an RPC call to your function.
If the caller sends an asynchronous request, the "replyTo" value is null.

## Platform API

You can obtain a singleton instance of the Platform object to do the following:

### Register a function

We recommend using the `preLoad` annotation in a class to declare the function.

In some use cases where you want to create and destroy functions on demand, you can register them programmatically.

### What is a public function?

A public function is visible by any application instances in the same network. When a function is declared as
"public", the function is reachable through the EventAPI REST endpoint.

A private function is invisible outside the memory space of the application instance that it resides.
This allows application to encapsulate business logic according to domain boundary. You can assemble closely
related functions as a composable application that can be deployed independently.

### Release a function

In some use cases, you want to release a function on-demand when it is no longer required.

```javascript
platform.release("another.function");
```

The above API will unload the function from memory and release it from the "event loop".

### Check if a function is available

You can check if a function with the named route has been deployed.

```java
if (po.exists("another.function")) {
    // do something
}
```

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

### Send an asynchronous event to a function

You can send an asynchronous event like this.

```java
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

```java
const myRoute = evt.getHeader('my_route');
const traceId = evt.getHeader('my_trace_id');
const tracePath = evt.getHeader('my_trace_path');
```

## Configuration API

Your function can access the main application configuration from the platform like this:

```javascript
const config = platform.getConfig();
// the value can be string or a primitive
const value = config.get('my.parameter');
// the return value will be converted to a string
const text = config.getProperty('my.parameter');
```

The system uses the standard dot-bracket format for a parameter name.

> e.g. `hello.world`, `some.key[2]`

You can also override the main application configuration using the `set` method.

Additional configuration files can be added with the `ConfigReader` API like this:

```javascript
const myConfig = new ConfigReader(filePath);
```

The configuration system supports environment variable or reference to the main application configuration
using the dollar-bracket syntax.

> e.g. `some.key=${MY_ENV_VARIABLE}` `some.key=${my.main.config}`
  Syntax: `${reference:default_value}`

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
It is available as an enterprise add-on module from Accenture.

## Co-existence with other development frameworks

Mercury libraries are designed to co-exist with your favorite frameworks and tools. Inside a class implementing
a composable function, you can use any coding style and frameworks as you like, including sequential, object-oriented
and reactive programming styles.

Mercury version 3 has a built-in lightweight non-blocking HTTP server based on Express, but you can also use other
application server framework with it.

## Template application for quick start

You can use the `hello world` project as a template to start writing your own applications.

## Source code update frequency

This project is licensed under the Apache 2.0 open sources license. We will update the public codebase after
it passes regression tests and meets stability and performance benchmarks in our production systems.

Mercury is developed as an engine for you to build the latest cloud native and composable applications.
While we are updating the technology frequently, the essential internals and the core APIs are stable.

## Technical support

For enterprise clients, optional technical support is available. Please contact your Accenture representative
for details.
<br/>

|            Chapter-5            |                   Home                    |                Chapter-7                |
|:-------------------------------:|:-----------------------------------------:|:---------------------------------------:|
| [Event over HTTP](CHAPTER-5.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Test Driven Development](CHAPTER-7.md) |
