# Hello World app

## Clone the Mercury for Node.js project

You can clone the project like this:

```shell
cd sandbox
git clone https://github.com/Accenture/mercury-nodejs.git
cd mercury-nodejs
cd examples
```

## Pre-requisites

Mercury 3.0 for Node.js is written in TypeScript. You may need to install the following first:

```shell
npm install -g eslint-cli
npm install
```

## Installing the Mercury 3.0 library

The Mercury library dependency is shown in the package.json file.

```shell
"dependencies": {
   "mercury": "github:accenture/mercury-nodejs"
}
```

When you enter `npm install`, it will fetch the Mercury 3.0 library from github.

To obtain the latest update, you can do this:

```shell
cd examples
npm uninstall mercury
npm install https://github.com/Accenture/mercury-nodejs
```

Alternatively, you may build the Mercury 3.0 for Node.js library and publish it to your corporate artifactory.

## Building the hello world application

```shell
npm run build
```

The "build" command will generate the "dist" folder containing the executable "javascript" files.

## Running the hello world application

You can run the application using `node dist/hello-world.js`. You will see log messages like this:

```shell
$ node dist/hello-world.js
2023-06-09 15:49:35.078 INFO Loading base configuration from /sandbox/mercury-nodejs/examples/dist/resources/application.yml (config-reader.js:52)
2023-06-09 15:49:35.104 INFO Event system started - 2f2d6abd7b9c4d9d9694b3b900254f7a (platform.js:441)
2023-06-09 15:49:35.106 INFO PRIVATE distributed.tracing registered (platform.js:215)
2023-06-09 15:49:35.108 INFO PRIVATE async.http.request registered with 200 instances (platform.js:218)
2023-06-09 15:49:35.108 INFO Loading HelloWorldService as hello.world (descriptor.value:composable.js:11)
2023-06-09 15:49:35.109 INFO Loading DemoHealthCheck as demo.health (descriptor.value:composable.js:11)
2023-06-09 15:49:35.124 INFO PUBLIC hello.world registered with 10 instances (platform.js:218)
2023-06-09 15:49:35.124 INFO PRIVATE demo.health registered with 5 instances (platform.js:218)
2023-06-09 15:49:35.125 INFO PRIVATE actuator.services registered with 10 instances (platform.js:218)
2023-06-09 15:49:35.128 INFO PRIVATE event.api.service registered with 200 instances (platform.js:218)
2023-06-09 15:49:35.129 INFO PRIVATE rest.automation.manager registered (platform.js:215)
2023-06-09 15:49:35.152 INFO Loaded header_1, request headers, add=0, drop=5, keep=0 (RestEntry.loadHeaderEntry:routing.js:263)
2023-06-09 15:49:35.153 INFO Loaded header_1, response headers, add=4, drop=0, keep=0 (RestEntry.loadHeaderEntry:routing.js:263)
2023-06-09 15:49:35.154 INFO Loaded cors_1 cors headers (*) (RestEntry.loadCors:routing.js:280)
2023-06-09 15:49:35.155 INFO POST /api/event -> event.api.service, timeout=60s, tracing=true (routing.js:521)
2023-06-09 15:49:35.155 INFO OPTIONS /api/event -> event.api.service, timeout=60s (routing.js:515)
2023-06-09 15:49:35.156 INFO GET /api/hello/world -> hello.world, timeout=10s, tracing=true (routing.js:521)
2023-06-09 15:49:35.156 INFO PUT /api/hello/world -> hello.world, timeout=10s, tracing=true (routing.js:521)
2023-06-09 15:49:35.156 INFO POST /api/hello/world -> hello.world, timeout=10s, tracing=true (routing.js:521)
2023-06-09 15:49:35.157 INFO HEAD /api/hello/world -> hello.world, timeout=10s, tracing=true (routing.js:521)
2023-06-09 15:49:35.157 INFO PATCH /api/hello/world -> hello.world, timeout=10s, tracing=true (routing.js:521)
2023-06-09 15:49:35.157 INFO DELETE /api/hello/world -> hello.world, timeout=10s, tracing=true (routing.js:521)
2023-06-09 15:49:35.158 INFO OPTIONS /api/hello/world -> hello.world, timeout=10s (routing.js:515)
2023-06-09 15:49:35.158 INFO POST /api/hello/upload -> hello.world, timeout=15s, tracing=false (routing.js:521)
2023-06-09 15:49:35.158 INFO OPTIONS /api/hello/upload -> hello.world, timeout=15s (routing.js:515)
2023-06-09 15:49:35.159 INFO POST /api/hello/list -> hello.list, timeout=15s, tracing=false (routing.js:521)
2023-06-09 15:49:35.159 INFO OPTIONS /api/hello/list -> hello.list, timeout=15s (routing.js:515)
2023-06-09 15:49:35.160 INFO GET /api/simple/{task}/* -> hello.world, timeout=12s, tracing=false (routing.js:521)
2023-06-09 15:49:35.160 INFO PUT /api/simple/{task}/* -> hello.world, timeout=12s, tracing=false (routing.js:521)
2023-06-09 15:49:35.161 INFO POST /api/simple/{task}/* -> hello.world, timeout=12s, tracing=false (routing.js:521)
2023-06-09 15:49:35.161 INFO OPTIONS /api/simple/{task}/* -> hello.world, timeout=12s (routing.js:515)
2023-06-09 15:49:35.162 WARN trust_all_cert=true for http://127.0.0.1:8086 is not relevant - Do you meant https? (RestEntry.loadRestEntry:routing.js:484)
2023-06-09 15:49:35.162 INFO GET /api/v1/* -> http://127.0.0.1:8086, timeout=20s, tracing=true (routing.js:521)
2023-06-09 15:49:35.162 INFO PUT /api/v1/* -> http://127.0.0.1:8086, timeout=20s, tracing=true (routing.js:521)
2023-06-09 15:49:35.162 INFO POST /api/v1/* -> http://127.0.0.1:8086, timeout=20s, tracing=true (routing.js:521)
2023-06-09 15:49:35.163 INFO OPTIONS /api/v1/* -> http://127.0.0.1:8086, timeout=20s (routing.js:515)
2023-06-09 15:49:35.163 INFO GET /api/hello/download -> hello.download, timeout=20s, tracing=false (routing.js:521)
2023-06-09 15:49:35.164 INFO OPTIONS /api/hello/download -> hello.download, timeout=20s (routing.js:515)
2023-06-09 15:49:35.164 INFO Exact API path [/api/event, /api/hello/download, /api/hello/list, /api/hello/upload, /api/hello/world] (RestEntry.load:routing.js:175)
2023-06-09 15:49:35.165 INFO Wildcard API path [/api/simple/{task}/*, /api/v1/*] (RestEntry.load:routing.js:194)
2023-06-09 15:49:35.165 INFO Static HTML folder: /sandbox/mercury-nodejs/examples/dist/resources/public (RestEngine.startHttpServer:rest-automation.js:135)
2023-06-09 15:49:35.241 INFO To stop application, press Control-C (EventSystem.runForever:platform.js:523)
2023-06-09 15:49:35.242 INFO Hello world application started (main:hello-world.js:33)
2023-06-09 15:49:35.246 INFO REST automation service started on port 8086 (rest-automation.js:226)
```

Now please open your browser to "http://127.0.0.1:8086". You will see the application home page:

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
    "version": "3.0.0",
    "description": "Composable application example"
  },
  "memory": {
    "max": "34,093,076,480",
    "free": "17,068,216,320",
    "used": "12,988,104"
  },
  "node": {
    "version": "v18.12.1"
  },
  "origin": "2f2d6abd7b9c4d9d9694b3b900254f7a",
  "time": {
    "current": "2023-06-09 15:54:04.992",
    "start": "2023-06-09 15:49:35.108"
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
  "upstream": [
    {
      "route": "demo.health",
      "service": "demo.service",
      "href": "http://127.0.0.1",
      "status_code": 200,
      "message": "demo.service is running fine"
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

The "hello.world" function is available in "services/hello-world-service.ts".

The statement echoing the HTTP request is `return new EventEnvelope(evt)`

## Define a function

A function can be defined in a class with this template:

```javascript
export class HelloWorldService implements Composable {

    name = "hello.world";

    @preload()
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

Optionally, you can put additional setup code in the "initialize" method. 

If your function has a constructor, please do not use any input arguments.

## Distributed trace

When you browse the endpoint "http://127.0.0.1:8086/api/hello/world", you will see a log message like this:

```text
2023-06-09 16:13:23.266 INFO {"trace":{"origin":"2f2d6abd7b9c4d9d9694b3b900254f7a",
                        "id":"5bf3cc1aab7647878d7ba91565d4ef9b","path":"GET /api/hello/world",
                        "service":"hello.world","start":"2023-06-09T23:13:23.263Z","success":true,
                        "exec_time":0.538,"round_trip":1.016,"from":"http.request"}}
                          (handleEvent:tracer.js:27)
```

Mercury 3.0 has built-in distributed tracing ability. Composable application is by definition event driven.
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

The minimal set of parameters required by the system is shown above. You can add application specific parameters.

The application.name, info.app.version, info.app.description, server.port, log.format, log.level
and health.dependencies are required.

Let's review REST automation in Chapter 3.

<br/>

|          Chapter-1           |                   Home                    |            Chapter-3            |
|:----------------------------:|:-----------------------------------------:|:-------------------------------:|
| [Introduction](CHAPTER-1.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [REST automation](CHAPTER-3.md) |



