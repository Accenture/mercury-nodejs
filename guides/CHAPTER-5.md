# Event over HTTP

The in-memory event system allows functions to communicate with each other in the same application memory space.

In composable architecture, applications are modular components in a network. Some transactions may require
the services of more than one application. "Event over HTTP" extends the event system beyond a single application.

The Event API service (`event.api.service`) is a built-in function in the system.

## The Event API endpoint

To enable "Event over HTTP", you must first turn on the REST automation engine with the following parameters
in the application.properties file:

```properties
server.port=8086
```

and then check if the following entry is configured in the "rest.yaml" endpoint definition file.
If not, update "rest.yaml" accordingly. The "timeout" value is set to 60 seconds to fit common use cases.

```yaml
  - service: [ "event.api.service" ]
    methods: [ 'POST' ]
    url: "/api/event"
    timeout: 60s
    tracing: true
```

This will expose the Event API endpoint at port 8086 and URL "/api/event".

In kubernetes, The Event API endpoint of each application is reachable through internal DNS and there is no need
to create "ingress" for this purpose.

## Test drive Event API

You may now test drive the Event API service.

First, build and run the lambda-example application in port 8086.

```shell
cd examples/dist
node hello-world.js
```

Second, build and run the rpc-to-service application.

```shell
cd examples/dist/extra
node rpc-to-service.js
```

The rpc-to-service application will connect to the hello world application and make requests to the "hello.world"
service there.

```shell
$ node rpc-to-service.js
2023-06-09 17:45:37.621 INFO Event system started - ed28f069afc34647b7afc5e762522e9f (platform.js:441)
2023-06-09 17:45:37.625 INFO PRIVATE distributed.tracing registered (platform.js:215)
2023-06-09 17:45:37.626 INFO PRIVATE async.http.request registered with 200 instances (platform.js:218)
2023-06-09 17:45:37.627 INFO Platform ed28f069afc34647b7afc5e762522e9f ready (main:rpc-to-service.js:10)
2023-06-09 17:45:37.682 INFO Payload match? true (main:rpc-to-service.js:20)
2023-06-09 17:45:37.682 INFO Received 1 (main:rpc-to-service.js:21)
2023-06-09 17:45:37.691 INFO Payload match? true (main:rpc-to-service.js:20)
2023-06-09 17:45:37.692 INFO Received 2 (main:rpc-to-service.js:21)
2023-06-09 17:45:37.699 INFO Payload match? true (main:rpc-to-service.js:20)
2023-06-09 17:45:37.700 INFO Received 3 (main:rpc-to-service.js:21)
2023-06-09 17:45:37.700 INFO Demo application completed (main:rpc-to-service.js:29)
```

In the rpc-to-service application, it makes the requests using the "await po.remoteRequest()" API.

Since the rpc-to-service is not a service itself, it runs as a standalone command line application.
It provides the "tracing" metadata in the PostOffice like this:

```shell
const REMOTE_EVENT_ENDPOINT = 'http://127.0.0.1:8086/api/event';
const po = new PostOffice({ 'my_route': 'rpc.demo', 'my_trace_id': '200', 'my_trace_path': '/api/remote/rpc' });
...
const result = await po.remoteRequest(req, REMOTE_EVENT_ENDPOINT);
```

The illustrates that you can write both command line application or service application using the Mercury 3.0 toolkit.

## Advantages

The Event API exposes all public functions of an application instance to the network using a single REST endpoint.

The advantages of Event API includes:

1. Convenient - you do not need to write or configure individual endpoint for each public service
2. Efficient - events are transported in binary format from one application to another
3. Secure - you can protect the Event API endpoint with an authentication service

The following configuration adds authentication service to the Event API endpoint:
```yaml
  - service: [ "event.api.service" ]
    methods: [ 'POST' ]
    url: "/api/event"
    timeout: 60s
    authentication: "v1.api.auth"
    tracing: true
```

This enforces every incoming request to the Event API endpoint to be authenticated by the "v1.api.auth" service
before passing to the Event API service. You can plug in your own authentication service such as OAuth 2.0
"bearer token" validation.

Please refer to [Chapter-3 - REST automation](CHAPTER-3.md) for details.
<br/>

|              Chapter-4              |                   Home                    |          Chapter-6           |
|:-----------------------------------:|:-----------------------------------------:|:----------------------------:|
| [Event orchestration](CHAPTER-4.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [API overview](CHAPTER-6.md) |
