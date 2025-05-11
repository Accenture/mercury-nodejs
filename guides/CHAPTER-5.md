# Build, Test and Deploy

The first step in writing an application is to create an entry point for your application.

## Main application

A minimalist main application template is shown as follows:

```javascript
import { ComposableLoader } from './preload/preload.js'; 

async function main() {
    // Load composable functions into memory and automatically starts your application modules
    await ComposableLoader.initialize();
}
// run the application
main();
```

In your application.yml configuration file, you would configure autostart modules like this:

```yaml
modules.autostart:
  - 'main.app'
```

In the above example, the "main.app" is defined in the main-application.ts in the composable-example project.
It looks like this:

```javascript
export class MainApp implements Composable {

    @preload('main.app')
    initialize(): Composable {
        return this;
    }

    async handleEvent(evt: EventEnvelope) {
        // put your start up business logic here
        log.info("Application started");
        // release this function to guarantee that it is executed only once
        Platform.getInstance().release('main.app');      
        // return value is ignored because start up code runs asynchronously
        return true;
    }
}

```

You can also build and run the application from command line like this:

```shell
cd sandbox/composable-nodejs-example
npm install
npm run build
npm run test
```

Since all functions are connected using the in-memory event bus, you can test any function by sending events
from a unit test module.

## Writing your functions

Please follow the step-by-step learning guide in [Chapter-1](CHAPTER-1.md) to write your own functions. You can then
configure new REST endpoints to use your new functions.

## HTTP forwarding

In [Chapter-3](CHAPTER-3.md), we have presented the configuration syntax for the "rest.yaml" REST automation
definition file. Please review the sample rest.yaml file in the lambda-example project. You may notice that
it has an entry for HTTP forwarding. The following entry in the sample rest.yaml file illustrates an HTTP
forwarding endpoint. In HTTP forwarding, you can replace the "service" route name with a direct HTTP target host.
You can do "URL rewrite" to change the URL path to the target endpoint path. In the below example,
`/api/v1/*` will be mapped to `/api/*` in the target endpoint.

```yaml
  - service: "http://127.0.0.1:${rest.server.port}"
    trust_all_cert: true
    methods: ['GET', 'PUT', 'POST']
    url: "/api/v1/*"
    url_rewrite: ['/api/v1', '/api']
    timeout: 20
    cors: cors_1
    headers: header_1
    tracing: true
```

## Sending HTTP request event to more than one service

One feature in REST automation "rest.yaml" configuration is that you can configure more than one function in the
"service" section. In the following example, there are two function route names ("hello.world" and "hello.copy").
The first one "hello.world" is the primary service provider. The second one "hello.copy" will receive a copy of
the incoming event.

This feature allows you to write new version of a function without disruption to current functionality. Once you are
happy with the new version of function, you can route the endpoint directly to the new version by updating the
"rest.yaml" configuration file.

```yaml
  - service: ["hello.world", "hello.copy"]
```

## Writing a unit test

In unit tests, we want to tell the system to use the "test/resources" folder to override the "src/resources" folder
so that we can adjust the configuration to test different scenarios. 

This can be done by using the ComposableLoader's initialize method in the `BeforeAll` section like this:

```javascript
describe('End-to-end tests', () => {

    beforeAll(async () => {
        await ComposableLoader.initialize(8305, true);
    });
    
    // your unit test here
    afterAll(async () => {
        await Platform.getInstance().stop();
        // give console.log a moment to finish
        await util.sleep(2000);
        log.info("Service tests completed");
    });
    
    it('can do health check', async () => {
        const po = new PostOffice();
        const req = new EventEnvelope().setTo('demo.health').setHeader('type', 'health');
        const result = await po.request(req, 2000);
        expect(result).toBeTruthy();
        expect(result.getBody()).toEqual({"status": "demo.service is running fine"});
    });      
}
```

In the above example, we set the server port for REST automation to 8305 and set the "unit test" parameter to true.
Please refer to the e2e.test.ts and service.test.ts test suites as examples.

> *Note*: You must select a unique server port number for each test class because the test engine "vitest" will
          instantiate a new Javascript V8 engine for each test class.

### Convenient utility classes

The Utility and MultiLevelMap classes are convenient tools for unit tests.

The MultiLevelMap supports reading an element using the convenient "dot and bracket" format.

For example, given a map like this:
```json
{
  "body":
  {
    "time": "2023-03-27T18:10:34.234Z",
    "hello": [1, 2, 3]
  }
}
```

| Example | Command                         | Result                   |
|:-------:|:--------------------------------|:-------------------------|
|    1    | map.getElement("body.time")     | 2023-03-27T18:10:34.234Z |
|    2    | map.getElement("body.hello[2]") | 3                        |

## Event Flow mocking framework

We recommend using Event Script to write Composable application for highest level of decoupling.
Event Script supports sophisticated event choreography by configuration.

In Event Script, you have a event flow configuration and a few Composable functions in an application.
Composable functions are self-contained with zero dependencies with other composable functions.
You can invoke an event flow from an event flow adapter.

The most common flow adapter is the "HTTP flow adapter" and it is available as a built-in module in
the event-script-engine module in the system. You can associate many REST endpoints to the HTTP flow
adapter.

Since function routes for each composable function is defined in a event flow configuration and the same
function route may be used for more than one task in the flow, the system provides a mock helper class
called "EventScriptMock" to let your unit tests to override a task's function routes during test.

In the following unit test example for a "pipeline" test, we created a mock function "my.mock.function"
to override the "no.op" function that is associated with the first task "echo.one" in a pipeline.

The original "no.op" function is an echo function. The mocked function increments a counter
in addition to just echoing the input payload. In this fashion, the unit test can count the number
of iteration of a pipeline to validate the looping feature of a pipeline.

The unit test programmatically registers the mock function and override an existing function route with
the new route for the mock function.

```javascript
it('can do for-loop in pipeline', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET')
                    .setTargetHost(baseUrl).setUrl('/api/for-loop/test-user')
                    .setQueryParameter('seq', '100')
                    .setHeader('accept', 'application/json');
    // the iterationCount will be incremented by "my.mock.function"                                    
    iterationCount = 0;
    var mock = new EventScriptMock("for-loop-test");
    var previousRoute = mock.getFunctionRoute('echo.one');
    var currentRoute = mock.assignFunctionRoute('echo.one', 'my.mock.function').getFunctionRoute('echo.one');
    expect(previousRoute).toBe('no.op');
    expect(currentRoute).toBe('my.mock.function');
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(3);
    expect(iterationCount).toBe(3);
});
```

When the event flow finishes, you will see an "end-of-flow" log like this. It shows that the function
route for the "echo.one" task has been changed to "my.mock.function". This end-of-flow log is useful
during application development and tests so that the developer knows exactly which function has been
executed.

```text
Flow for-loop-test (0afcf555fc4141f4a16393422e468dc9) completed. Run 11 tasks in 28 ms. 
[ sequential.one, 
  echo.one(my.mock.function), 
  echo.two(no.op), 
  echo.three(no.op), 
  echo.one(my.mock.function), 
  echo.two(no.op), 
  echo.three(no.op), 
  echo.one(my.mock.function), 
  echo.two(no.op), 
  echo.three(no.op), 
  echo.four(no.op) ]
```

## Deployment

The `npm run build` command will generate an executable javascript bundle in the "dist" folder.
Your pipeline can deploy the bundle in a Docker instance accordingly.

Composable application is designed to be deployable using Kubernetes or serverless.

## Distributed tracing

The system has a built-in distributed tracing feature. You can enable tracing for any REST endpoint by adding
"tracing=true" in the endpoint definition in the "rest.yaml" configuration file.

You may also upload performance metrics from the distributed tracing data to your favorite telemetry system dashboard.

To do that, please implement a custom metrics function with the route name `distributed.trace.forwarder`.

The input to the function will be a JSON of key-values like this:

```shell
trace={path=/api/upload/demo, service=hello.upload, success=true, 
       origin=2023032731e2a5eeae8f4da09f3d9ac6b55fb0a4, 
       exec_time=77.462, start=2023-03-27T19:38:30.061Z, 
       from=http.request, id=12345, round_trip=132.296, status=200}
```

The system will detect if `distributed.trace.forwarder` is available. If yes, it will forward performance metrics
from distributed trace to your custom function.

## "npm" alias for mercury-composable core library

While you may use github as a repository to test drive your applications, you would need to build and publish the
mercury-composable library to your enterprise "npm" artifactory. Please consult your DevSecOps colleagues for
pipeline setup procedure. It would vary from one organization to another.

If you publish the mercury-composable to your own artifactory as another package name, you would add a "npm alias"
in the package.json of your application like this:

```shell
  "scripts": {
    "clean": "node clean.js && node placeholder.js",
    "pull": "npm uninstall actual-published-package-name && npm install actual-published-package-name",
    "preload": "node preloader.js",
    "prebuild": "npm run lint",
    "build": "npm run preload && tsc -p tsconfig.json && node copy-resource-files.js",
    "build:watch": "tsc -w -p tsconfig.json",
    "lint": "eslint . --fix",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "actual-published-package-name": "^4.2.37",
    "mercury-composable": "npm:actual-published-package-name"
  }
```

In the above example, it assumes the actual package name that is published from mercury-composable core library
is "actual-published-package-name", the package name "mercury-composable" becomes an alias so that you can keep
the import statements that point to "mercury-composable" unchanged.

You would need to update "scripts.pull" command and the "dependencies" section accordingly.
The "scripts.pull" command is used to pull the latest code from your enterprise artifactory and the
"mercury-composable" entry in the "dependencies" section is an alias to your published package.

Once you have updated the package.json file in the "examples" folder, you may run "npm run build". This verifies
that the example application can import from the newly published mercury-composable core library in your own
artifactory.

> *Note*: To publish the library to your enterprise npm artifactory, you may need to remove the package-lock.json
          and perform a `npm install` using your enterprise npm registry. This would ensure a new package-lock.json
          is generated based on your artifactory requirement.
          
<br/>

|              Chapter-4              |                   Home                    |            Chapter-6            |
|:-----------------------------------:|:-----------------------------------------:|:-------------------------------:|
| [Event Script Syntax](CHAPTER-4.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Event over HTTP](CHAPTER-6.md) |
