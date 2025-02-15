# Application configuration

The following parameters are reserved by the system. You can add your application parameters
in the main application configuration file (`application.yml`) or apply additional configuration
files using the `ConfigReader` API.

| Key                  | Value (example)                       | Required |
|:---------------------|:--------------------------------------|:---------|
| application.name     | Application name                      | Yes      |
| info.app.version     | major.minor.build (e.g. 1.0.0)        | Yes      |
| info.app.description | Something about your application      | Yes      |
| server.port          | e.g. 8083                             | Yes      |
| static.html.folder   | e.g. /tmp/html                        | Yes      |
| yaml.rest.automation | Default value is classpath:/rest.yaml | Optional |
| yaml.mime.types      | Optional config file                  | Optional |
| mime.types           | Map of file extensions to MIME types  | Optional |
| log.format           | text, compact or json. default=text   | Optional |
| log.level            | default 'info'                        | Optional |
| health.dependencies  | e.g. 'database.health'                | Optional |

## Static HTML contents

You can place static HTML files (e.g. the HTML bundle for a UI program) in the "resources/public" folder or
in the local file system using the "static.html.folder" parameter.

The system supports a bare minimal list of file extensions to MIME types. If your use case requires additional
MIME type mapping, you may define them in the `application.yml` configuration file under the `mime.types`
section like this:

```yaml
mime.types:
  pdf: 'application/pdf'
  doc: 'application/msword'
```

Alternatively, you can create a mime-types.yml file and point it using the "yaml.mime.types" parameter.

## Transient data store

The system uses a temp folder in "/tmp/composable/node/temp-streams" to hold temporary data blocks for streaming I/O.

## Reserved route names

The following route names are reserved by the system.

| Route                       | Purpose                             | Modules         |
|:----------------------------|:------------------------------------|:----------------|
| distributed.tracing         | Distributed tracing logger          | platform-core   |
| temporary.inbox             | Event listener for RPC              | platform-core   |
| event.api.service           | Event API handler                   | platform-core   |
| object.stream.manager       | Object stream event handler         | platform-core   |
| async.http.request          | HTTP request event handler          | REST automation |
| async.http.response         | HTTP response event handler         | REST automation |
| info.actuator.service       | admin endpoint for /info            | REST automation |
| routes.actuator.service     | admin endpoint for /info/routes     | REST automation |
| env.actuator.service        | admin endpoint for /env             | REST automation |
| health.actuator.service     | admin endpoint for /health          | REST automation |
| liveness.actuator.service   | admin endpoint for /livenessprobe   | REST automation |
| rest.automation.housekeeper | REST automation housekeeper         | REST automation |
| event.script.manager        | Instantiate new event flow instance | event-script    |
| task.executor               | Perform event choreography          | event-script    |
| http.flow.adapter           | Built-in flow adapter               | event-script    |
| no.op                       | no-operation placeholder function   | event-script    |

## Reserved HTTP header names

| Header                   | Purpose                                                              | 
|:-------------------------|:---------------------------------------------------------------------|
| X-Stream-Id              | Temporal route name for streaming content                            |
| X-TTL                    | Time to live in milliseconds for a streaming content                 |
| X-Async                  | This header, if set to true, indicates it is a drop-n-forget request |
| X-Trace-Id               | This allows the system to propagate trace ID                         |

<br/>

|          Chapter-7           |                   Home                    |             Appendix-II             |
|:----------------------------:|:-----------------------------------------:|:-----------------------------------:|
| [API overview](CHAPTER-7.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Async HTTP client](APPENDIX-II.md) |
