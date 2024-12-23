# Introduction

Mercury version 4 is a toolkit for writing composable applications.

At the platform level, composable architecture refers to loosely coupled platform services, utilities, and
business applications. With modular design, you can assemble platform components and applications to create
new use cases or to adjust for ever-changing business environment and requirements. Domain driven design (DDD),
Command Query Responsibility Segregation (CQRS) and Microservices patterns are the popular tools that architects
use to build composable architecture. You may deploy application in container, serverless or other means.

At the application level, a composable application means that an application is assembled from modular software
components or functions that are self-contained and pluggable. You can mix-n-match functions to form new applications.
You can retire outdated functions without adverse side effect to a production system. Multiple versions of a function
can exist, and you can decide how to route user requests to different versions of a function. Applications would be
easier to design, develop, maintain, deploy, and scale.

## Composable application architecture

> Figure 1 - Composable application architecture

![architecture.png](diagrams/architecture.png)

As shown in Figure 1, a minimalist composable application consists of three user defined components:

1. Main modules that provides an entry point to your application
2. One or more business logic modules (shown as "function-1" to "function-3" in the diagram)
3. An event orchestration module to command the business logic modules to work together as an application

*Event choreography*: Instead of writing an orchestrator in code, you can deploy Event Script as an engine.
Please refer to the composable-application example in the 
[Mercury-Composable](https://accenture.github.io/mercury-composable/) project. You can configure an
Event-over-HTTP configuration file to connect the Java based Event Script engine to your Node.js application.
You can package the Event Script application and your Node.js application into a single container for
deployment. Alternatively, you can deploy your node.js application as serverless function in the cloud and
the Event Script application can execute the serverless functions according to an event flow configuration.

The foundation libary includes:

1. The REST automation system for rapid creation of REST endpoints by configuration
2. An in-memory event system (aka "event loop") using the Node's EventEmitter library.
3. An optional Local pub/sub system for multiple functions to listen to the same topic.

### Main module

Each application has an entry point. You may implement an entry point in a main application like this:

```typescript
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

For a command line use case, your main application module would get command line arguments and
send the request as an event to a business logic function for processing.

For a backend application, the main application is usually used to do some "initialization" or
setup steps for your services.

The `ComposableLoader.initialize()` statement will register your user functions into the event loop.
There is no need to directly import each module in your application code.

### Business logic modules

Your user function module may look like this:

```typescript
export class HelloWorldService implements Composable {
    name = "hello.world";

    @preload(10)
    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
    }
    
    async handleEvent(event: EventEnvelope) {
        // your business logic here
        return someResult;
    }
}
```

Each function in a composable application should be implemented in the first principle of "input-process-output".
It should be stateless and self-contained. i.e. it has no direct dependencies with any other functions in the
composable application. Each function is addressable by a unique "route name". Input and output can be
primitive value or JSON objects to be transported using standard event envelopes.

In the above example, the unique "route name" of the function is "hello.world".

You can define instances, isPublic and isInterceptor in the `preload` annotation. The default values are
instances=1, isPublic=false and isInterceptor=false. In the example, the number of instances is set to 10.
You can set the number of instances from 1 to 500.

> Writing code in the first principle of "input-process-output" promotes Test Driven Development (TDD) because
  interface contact is clearly defined. Self-containment means code is more readable.

### Loading composable functions from a library

You can publish a set of composable functions as a library. To import your composable functions from a library,
you may add the following in the application.yml configuration file. In this example, it tells the system
to search for composable functions in the package called "mercury".

```yaml
#
# To scan libraries for composable functions, use a comma separated text string
# for a list of library dependencies.
#
web.component.scan: 'mercury'
```

The "mercury" package is actually the composable core library. To illustate this feature, we have added a sample
composable function called "no.op" in the NoOp.ts class. When you build the example app using "npm run build",
the "preload" step will execute the "generate-preloader.js" script to generate the `preload.ts` class in the
"src/preload" folder. The "no.op" composable function will simply echo input as output.

A worked example of application.yml file is available in the examples/src/resources folder.

### Event orchestration

A transaction can pass through one or more user functions. In this case, you can write a user function to receive
request from a user, make requests to some user functions, and consolidate the responses before responding to the
user.

Note that event orchestration is optional. For example, you can create a BackEnd for FrontEnd (BFF) application
simply by writing a composable function and link it with the built-in REST automation system.

### REST automation

REST automation creates REST endpoints by configuration rather than code. You can define a REST endpoint like this:

```yaml
  - service: "hello.world"
    methods: ['GET']
    url: "/api/hello/world"
    timeout: 10s
```

In this example, when a HTTP request is received at the URL path "/api/hello/world", the REST automation system
will convert the HTTP request into an event for onward delivery to the user defined function "hello.world". 
Your function will receive the HTTP request as input and return a result set that will be sent as a HTTP response
to the user.

For more sophisticated business logic, we recommend the use of Event Script for event choreography discussed
earlier.

### In-memory event system

The composable engine encapsulates the standard Node.js EventEmitter library for event routing. It exposes the
"PostOffice" API for you to write your own event orchestration function to send async or RPC events.

### Local pub/sub system

The in-memory event system is designed for point-to-point delivery. In some use cases, you may like to have
a broadcast channel so that more than one function can receive the same event. For example, sending notification
events to multiple functions. The optional local pub/sub system provides this multicast capability.

### Other user facing channels

While REST is the most popular user facing interface, there are other communication means such as event triggers
in a serverless environment. You can write a function to listen to these external event triggers and send the events
to your user defined functions. This custom "adapter" pattern is illustrated as the dotted line path in Figure 1.

### Test drive a sample application

To visualize what is a Composable application, let's try out the "Hello World" application in Chapter 2.

<br/>

|                   Home                    |                Chapter-2                |
|:-----------------------------------------:|:---------------------------------------:|
| [Table of Contents](TABLE-OF-CONTENTS.md) | [Hello World application](CHAPTER-2.md) |
