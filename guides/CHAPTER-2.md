# Hello World application

Getting started with the "hello world" application in the example sub-project.

## Clone the Mercury for Node.js project

You can clone the project like this:

```shell
cd sandbox
git clone https://github.com/Accenture/mercury-nodejs.git
cd mercury-nodejs
cd examples
```

## Pre-requisites

Mercury for Node.js is written in TypeScript. Please install library dependencies using npm first:

```shell
npm install
```

## Installing the Mercury library

When you enter `npm install`, it will fetch the configured Mercury library from github using
package-lock.json.

To obtain the latest update, you can do `npm run pull`.

```shell
cd examples
npm run pull
```

If you want to use an earlier release, you can specify the release branch with a hash sign
like this:

```shell
npm install https://github.com/Accenture/mercury-nodejs#release/v4.1.1
```

If you are using mercury-nodejs in your organization, we recommend publishing the mercury-nodejs
core library to your corporate artifactory.

## Building the hello world application

```shell
npm run build
```

When you build the example app using "npm run build", the "preload" step will execute the
"generate-preloader.js" script to generate the `preload.ts` class in the "src/preload" folder.
Then it will generate the "dist" folder containing the executable "javascript" files.

## Running the hello world application

You can run the application using `node hello-world.js`. You will see log messages like this:

```shell
% npm run build
> examples@4.1.1 prebuild
> npm run lint
> examples@4.1.1 lint
> eslint . --fix
> examples@4.1.1 build
> npm run preload && tsc -p tsconfig.json && node copy-static-files.js
> examples@4.1.1 preload
> node generate-preloader.js
INFO Loading base configuration from /examples/src/resources/application.yml (config-reader.js:98)
INFO Scanning /examples/node_modules/mercury/dist (scanPackage:generate-preloader.js:19)
INFO Class NoOp (scanPackageJs:generate-preloader.js:71)
INFO Scanning /examples/src (main:generate-preloader.js:193)
INFO Class DemoAuth (scanSourceFolder:generate-preloader.js:95)
INFO Class DemoHealthCheck (scanSourceFolder:generate-preloader.js:95)
INFO Class HelloWorldService (scanSourceFolder:generate-preloader.js:95)
INFO Composable class loader (/preload/preload.ts) generated (generatePreLoader:generate-preloader.js:169)
% cd dist 
% node hello-world.js 
INFO Loading base configuration from /Users/eric.law/sandbox/mercury-nodejs/examples/dist/resources/application.yml (config-reader.js:98)
INFO Base configuration 2609990e76414441af65af27b65f2cdd (ComposableLoader.initialize:preload.js:40)
INFO Loading NoOp as no.op (descriptor.value:composable.js:18)
INFO Loading DemoAuth as v1.api.auth (descriptor.value:composable.js:18)
INFO Loading DemoHealthCheck as demo.health (descriptor.value:composable.js:18)
INFO Loading HelloWorldService as hello.world (descriptor.value:composable.js:18)
INFO Event system started - 9f2fa4a008534f19a1cb1a3dfe1e3af0 (platform.js:437)
INFO PRIVATE distributed.tracing registered (platform.js:213)
INFO PRIVATE async.http.request registered with 200 instances (platform.js:216)
INFO PRIVATE no.op registered (platform.js:213)
INFO PRIVATE v1.api.auth registered (platform.js:213)
INFO PRIVATE demo.health registered (platform.js:213)
INFO PUBLIC hello.world registered with 10 instances (platform.js:216)
INFO PRIVATE actuator.services registered with 10 instances (platform.js:216)
INFO PRIVATE event.api.service registered with 200 instances (platform.js:216)
INFO PRIVATE rest.automation.manager registered (platform.js:213)
INFO Loaded header_1, request headers, add=0, drop=5, keep=0 (RestEntry.loadHeaderEntry:routing.js:259)
INFO Loaded header_1, response headers, add=4, drop=0, keep=0 (RestEntry.loadHeaderEntry:routing.js:259)
INFO Loaded cors_1 cors headers (*) (RestEntry.loadCors:routing.js:276)
INFO POST /api/event -> event.api.service, timeout=60s, tracing=true (routing.js:513)
INFO OPTIONS /api/event -> event.api.service, timeout=60s (routing.js:507)
INFO GET /api/hello/world -> v1.api.auth -> hello.world, timeout=10s, tracing=true (routing.js:510)
INFO PUT /api/hello/world -> v1.api.auth -> hello.world, timeout=10s, tracing=true (routing.js:510)
INFO POST /api/hello/world -> v1.api.auth -> hello.world, timeout=10s, tracing=true (routing.js:510)
INFO HEAD /api/hello/world -> v1.api.auth -> hello.world, timeout=10s, tracing=true (routing.js:510)
INFO PATCH /api/hello/world -> v1.api.auth -> hello.world, timeout=10s, tracing=true (routing.js:510)
INFO DELETE /api/hello/world -> v1.api.auth -> hello.world, timeout=10s, tracing=true (routing.js:510)
INFO OPTIONS /api/hello/world -> hello.world, timeout=10s (routing.js:507)
INFO POST /api/hello/upload -> hello.world, timeout=15s, tracing=false (routing.js:513)
INFO OPTIONS /api/hello/upload -> hello.world, timeout=15s (routing.js:507)
INFO POST /api/hello/list -> hello.list, timeout=15s, tracing=false (routing.js:513)
INFO OPTIONS /api/hello/list -> hello.list, timeout=15s (routing.js:507)
INFO GET /api/simple/{task}/* -> hello.world, timeout=12s, tracing=false (routing.js:513)
INFO PUT /api/simple/{task}/* -> hello.world, timeout=12s, tracing=false (routing.js:513)
INFO POST /api/simple/{task}/* -> hello.world, timeout=12s, tracing=false (routing.js:513)
INFO OPTIONS /api/simple/{task}/* -> hello.world, timeout=12s (routing.js:507)
WARN trust_all_cert=true for http://127.0.0.1:8086 is not relevant - Do you meant https? (RestEntry.loadRestEntry:routing.js:476)
INFO GET /api/v1/* -> http://127.0.0.1:8086, timeout=20s, tracing=true (routing.js:513)
INFO PUT /api/v1/* -> http://127.0.0.1:8086, timeout=20s, tracing=true (routing.js:513)
INFO POST /api/v1/* -> http://127.0.0.1:8086, timeout=20s, tracing=true (routing.js:513)
INFO OPTIONS /api/v1/* -> http://127.0.0.1:8086, timeout=20s (routing.js:507)
INFO GET /api/hello/download -> hello.download, timeout=20s, tracing=false (routing.js:513)
INFO OPTIONS /api/hello/download -> hello.download, timeout=20s (routing.js:507)
INFO Exact API path [/api/event, /api/hello/download, /api/hello/list, /api/hello/upload, /api/hello/world] (RestEntry.load:routing.js:171)
INFO Wildcard API path [/api/simple/{task}/*, /api/v1/*] (RestEntry.load:routing.js:190)
INFO Static HTML folder: /Users/eric.law/sandbox/mercury-nodejs/examples/dist/resources/public (RestEngine.startHttpServer:rest-automation.js:154)
INFO Loaded 18 mime types (RestEngine.startHttpServer:rest-automation.js:172)
INFO To stop application, press Control-C (EventSystem.runForever:platform.js:517)
INFO Hello world application started (main:hello-world.js:13)
INFO REST automation service started on port 8086 (rest-automation.js:289)
```

Open your browser to visit "http://127.0.0.1:8086". You will see the example application home page
like this:

```text
Hello World
INFO endpoint
Health endpoint
Demo endpoint
```

## INFO endpoint

When you click the INFO hyperlink, you will see a page like this:

```json
{
  "app": {
    "name": "example-app",
    "version": "4.1.1",
    "description": "Composable application example"
  },
  "memory": {
    "max": "34,093,076,480",
    "free": "17,068,216,320",
    "used": "12,988,104"
  },
  "node": {
    "version": "v22.12.0"
  },
  "origin": "2f2d6abd7b9c4d9d9694b3b900254f7a",
  "time": {
    "current": "2023-12-23 15:54:03.002",
    "start": "2023-12-23 15:49:35.102"
  },
  "uptime": "4 minutes 33 seconds"
}
```

## Health endpoint

The health endpoint may look like this:

```json
{
  "up": true,
  "origin": "2f2d6abd7b9c4d9d9694b3b900254f7a",
  "name": "example-app",
  "dependency": [
    {
      "route": "demo.health",
      "service": "demo.service",
      "href": "http://127.0.0.1",
      "status_code": 200,
      "message": {
        "status": "demo.service is running fine"
      }
    }
  ]
}
```

## Hello World demo endpoint

When you enter "http://127.0.0.1:8086/api/hello/world" in the browser, you will see this page:

```json
{
  "headers": {
    "upgrade-insecure-requests": "1",
    "dnt": "1",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "navigate",
    "sec-fetch-user": "?1",
    "sec-fetch-dest": "document",
    "referer": "http://127.0.0.1:8086/",
    "accept-language": "en-US,en;q=0.9",
    "x-flow-id": "hello-world"
  },
  "method": "GET",
  "ip": "127.0.0.1",
  "url": "/api/hello/world",
  "timeout": 10,
  "https": false
}
```

When you start the hello world application, you will find this "GET /api/hello/world -> hello.world" in the log,
indicating that REST automation has rendered the endpoint.

This instructs the REST automation system to route the URI "/api/hello/world" to the function with the route name
"hello.world".

The function simply echoes back the incoming HTTP request object showing HTTP method, path and headers, etc.

The "hello.world" function is available as "services/hello-world-service.ts" in the `examples/src` folder.

The statement echoing the HTTP request is `return new EventEnvelope(evt)`

## Define a function

A function can be defined in a class with this template:

```javascript
export class HelloWorldService implements Composable {

    name = "hello.world";

    @preload(10)
    initialize(): void {
        // no-op
    }

    getName(): string {
        return this.name;
    }
    
    async handleEvent(evt: EventEnvelope) {
        // your business logic here
        return someResult;
    }
}
```

The "Composable" interface enforces the 3 methods (initialize, getName and handleEvent). 
The "preload" annotation tells the system to load the function into memory so that it can be used
anywhere in your application without tight coupling.

You can define instances, isPublic and isInterceptor in the `preload` annotation. The default values are
instances=1, isPublic=false and isInterceptor=false. In the example, the number of instances is set to 10.
You can set the number of instances from 1 to 500.

Optionally, you can put additional setup code in the "initialize" method. 

If your function has a constructor, please do not use any input arguments.

## Distributed trace

When you browse the endpoint "http://127.0.0.1:8086/api/hello/world", you will see a log message like this:

```json
INFO {"trace":{ "origin":"2f2d6abd7b9c4d9d9694b3b900254f7a",
                "id":"5bf3cc1aab7647878d7ba91565d4ef9b","path":"GET /api/hello/world",
                "service":"hello.world","start":"2023-06-09T23:13:23.263Z","success":true,
                "exec_time":0.538,"round_trip":1.016,"from":"http.request"}
              }
```

Mercury has built-in distributed tracing ability. Composable application is by definition event driven.
Since a transaction may pass through multiple services, distributed tracing helps to visualize the event flows.

This can pinpoint to performance bottleneck or design flaws early in the development cycle. This contributes to
higher product quality because the developer can make adjustment sooner.

## Actuator endpoints

The system comes with the standard "/info", "/health" and "/livenessprobe" admin endpoints.

Please browse the "health-check.ts" as an example to write your own health checks. You can have more than one
health check services.

## Resources folder

Composable application is usually deployed as a containerized microservice or a serverless application.

The resources folder contains the following:

1. application.yml - you can put application specific configuration parameters
2. rest.yaml - you can define REST endpoints by configuration
3. preload.yaml - this instructs the system how to load your user functions into the event loop.

### application.yaml

```yaml
application.name: 'example-app'
info.app:
  version: '3.0.0'
  description: 'Composable application example'
  
# server port for Event API REST endpoint
server.port: 8086

# log.format can be 'text' or 'json'
log:
  format: 'text'
  level: INFO

# You can add optional health checks that point to your custom health check functions
# (the dependency list is a comma separated list) 
health.dependencies: 'demo.health'
```

Note that you can use "environment variables" in the configuration using the standard dollar-bracket format.
e.g.

```yaml
some.key=${MY_ENV_VAR:defaultValue}
```

The minimal set of parameters required by the system is shown above. You can add application specific parameters.

The application.name, info.app.version, info.app.description, server.port, log.format, log.level
and health.dependencies are required.

Let's review REST automation in Chapter 3.

<br/>

|          Chapter-1           |                   Home                    |            Chapter-3            |
|:----------------------------:|:-----------------------------------------:|:-------------------------------:|
| [Introduction](CHAPTER-1.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [REST automation](CHAPTER-3.md) |



