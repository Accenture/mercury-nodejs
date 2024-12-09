# Functional tests

The example project is pre-configured with "esLint" for TypeScript syntax validation and Jest testing framework.

Composable application is designed to be Test Driven Development (TDD) friendly.

There are two test suites under the "examples/test" folder. One for unit tests and one for end-to-end tests.

## Running tests

Before running the tests, please build your application first. The E2E tests run against the build from the
dist folder. Also make sure no apps are running on the configured port already.

```sh
npm run build # if you have not run yet
npm test
```

## Unit tests

Since each user function is written in the first principle "input-process-output", you can write unit tests
to validate the interface contract of each function directly.

For the unit tests, the setup and tear down steps are as follows:

```javascript
beforeAll(async () => {
    log.info('Begin service tests');
    // locate the src/resources folder
    resourceFolder = fileURLToPath(new URL('../src/resources', import.meta.url));
    const appConfigPath = util.normalizeFilePath(resourceFolder + '/application.yml');
    platform = new Platform(appConfigPath);
    ComposableLoader.initialize();
    platform.runForever();
});

afterAll(async () => {
    await platform.stop();
    // Give console.log a moment to finish
    await util.sleep(1000);
    log.info("Service tests completed");
});
```

In the setup step, it points the system to use the base configuration from "src/resources/application.yml" file and
tells the system to load the user functions into the event loop using `ComposableLoader.initialize()`.

In the tear down step, it instructs the system to stop gracefully.

A typical example for unit test is to use RPC method to send a request to a route served by a specific user function.

```javascript
it('can do health check', async () => {
    const po = new PostOffice();
    const req = new EventEnvelope().setTo('demo.health').setHeader('type', 'health');
    const result = await po.request(req, 2000);
    expect(result).toBeTruthy();
    expect(result.getBody()).toEqual({"status": "demo.service is running fine"});
});
```

## End-to-end tests

For end-to-end test, you can import and start your main application in the unit test like this:

```javascript
import '../src/hello-world.js';
```

The setup and tear down steps are shown below:

```javascript
beforeAll(async () => {
    const platform = new Platform();
    const config = platform.getConfig();
    const port = config.get('server.port');
    targetHost = `http://127.0.0.1:${port}`;
    log.info('Begin end-to-end tests');
}); 

afterAll(async () => {
    const platform = new Platform();
    await platform.stop();
    // Give console.log a moment to finish
    await util.sleep(1000);
    log.info("End-to-end tests completed");
});
```

Since your main application ("hello world") has been loaded into the same memory space, it is served by the
platform singleton object. You can obtain the parameter "server.port" from the base configuration so that 
your tests can make HTTP calls to the REST endpoints of the hello world application.

Let's examine the following test to make a HTTP GET request to the "/api/hello/world" REST endpoint.

```javascript
it('can do HTTP-GET to /api/hello/world', async () => {
    const po = new PostOffice();
    const httpRequest = new AsyncHttpRequest().setMethod('GET');
    httpRequest.setTargetHost(targetHost).setUrl('/api/hello/world');
    httpRequest.setQueryParameter('x', 'y');
    const req = new EventEnvelope().setTo('async.http.request').setBody(httpRequest.toMap());
    const result = await po.request(req, 2000);   
    expect(result).toBeTruthy();
    expect(result.getBody()).toBeInstanceOf(Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement('headers.user-agent')).toBe('async-http-client');
    expect(map.getElement('method')).toBe('GET');
    expect(map.getElement('ip')).toBe('127.0.0.1');
    expect(map.getElement('url')).toBe('/api/hello/world');
    expect(map.getElement('parameters.query.x')).toBe('y');
}); 
```

The system has a built-in AsyncHttpClient with the route name "async.http.request".

The above example code creates an AsyncHttpRequest object and passes it to the AsyncHttpClient that
will in turn submit the HTTP GET request to the "/api/hello/world" endpoint.

The MultiLevelMap is a convenient utility to retrieve key-values using the dot-bracket format.

## User facing vs internal services

The "hello world" application is a user facing application. It exposes the user functions through REST endpoints
defined in the "rest.yaml" configuration file. When a function receives input from a REST endpoint, the payload
in the incoming "event envelope" is an AsyncHttpRequest object. The user function can examine HTTP headers, 
cookies, method, URL and request body, if any.

A user function can also be internal. For example, it may be an algorithm doing calculation for a sales order.
The function would receive its input from a user facing function like this:

> REST endpoint -> user facing function -> internal functions -> database function

Please refer to [Chapter 4](CHAPTER-4.md) for some typical event patterns.

1. RPC `“Request-response”, best for interactivity`
2. Asynchronous `e.g. Drop-n-forget`
3. Callback `e.g. Progressive rendering`
4. Pipeline `e.g. Work-flow application`
5. Streaming `e.g. File transfer`

## Mocking

In a composable application, user functions are written in a self-contained manner without dependencies to other
user functions.

You can imagine that a transaction may pass through multiple functions (aka `services`) because of event
driven design. You can mock any user function by re-registering the "route name" with a mock function that you
provide in a unit test.

We advocate encapsulation of external dependencies. For example, database connection and query language 
should be fully encapsulated within a data adapter function and other user functions should communicate with the 
data adapter function using an agreed interface contract. This removes the tight coupling of user functions
with the underlying infrastructure, allowing us to upgrade infrastructure technology without heavy refactoring 
at the application level.

For a user function that encapsulates a database or an external system, you may mock the underlying dependencies
in the same fashion as you mock traditional code.

## Standalone command line application examples

You can apply the "Composable" methodology to write standalone command line applications. Please refer to the
"extra" folder for some simple examples.

| Example | Name                     | Purpose                                                  |
|:-------:|:-------------------------|:---------------------------------------------------------|
|    1    | rpc.ts                   | Demonstrate making RPC calls to a function               |
|    2    | rpc-to-service.ts        | Demo program to make "event over HTTP" call to a service |
|    3    | async.ts                 | Drop-n-forget async calls                                |
|    4    | callback.ts              | Make async call and ask the service to callback          |
|    5    | nested-rpc.ts            | Making nested RPC calls chaining 2 functions             |
|    6    | nested-rpc-with-trace.ts | Same as (5) with distributed tracing turned on           |

The command line applications are test programs. They are not covered by unit tests in the example project.

<br/>


|          Chapter-6           |                   Home                    |             Appendix-I              |
|:----------------------------:|:-----------------------------------------:|:-----------------------------------:|
| [API overview](CHAPTER-6.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Application config](APPENDIX-I.md) |