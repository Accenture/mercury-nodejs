# Event over HTTP

The in-memory event system allows functions to communicate with each other in the same application memory space.

In composable architecture, applications are modular components in a network. Some transactions may require
the services of more than one application. "Event over HTTP" extends the event system beyond a single application.

The Event API service (`event.api.service`) is a built-in function in the system.

## The Event API endpoint

To enable "Event over HTTP", you must first turn on the REST automation engine with the following parameters
in the application.properties file:

```yaml
server.port: 8085
rest.automation: true
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

This will expose the Event API endpoint at port 8085 and URL "/api/event".

In kubernetes, The Event API endpoint of each application is reachable through internal DNS and there is no need
to create "ingress" for this purpose.

## Event-over-HTTP configuration

You can enable Event-over-HTTP configuration by adding this parameter in application.yml:

```yaml
#
# Optional event-over-http target maps
#
yaml.event.over.http: classpath:/event-over-http.yaml
```

and then create the configuration file "event-over-http.yaml" like this:

```yaml
event:
  http:
  - route: 'hello.world'
    target: 'http://127.0.0.1:${another.app.port}/api/event'
    # optional security headers
    headers:
      authorization: 'demo'
```

In the above example, the route `hello.world` will be rerouted to the target URLs. If additional authentication
is required for the peer's "/api/event" endpoint, you may add a set of security headers in each route.

When you send asynchronous event or make a RPC call to "hello.world" service, it will be forwarded to the
peer's "event-over-HTTP" endpoint (`/api/event`) accordingly. If "hello.world" is a task in an event flow,
the event manager will make the "Event over HTTP" to the target service.

You may also add environment variable or base configuration references to the application.yaml file, such as
"another.app.port" in this example.

> *Note*: The target function must declare itself as PUBLIC in the preload annotation. Otherwise, you will get
  a HTTP-403 exception.

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

|               Chapter-5                |                   Home                    |          Chapter-7           |
|:--------------------------------------:|:-----------------------------------------:|:----------------------------:|
| [Build, test and deploy](CHAPTER-5.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [API overview](CHAPTER-7.md) |
