# Application configuration

The following parameters are reserved by the system. You can add your application parameters
in the main application configuration file (`application.yml`) or apply additional configuration
files using the `ConfigReader` API.

| Key                       | Value (example)                       | Required |
|:--------------------------|:--------------------------------------|:---------|
| application.name          | Application name                      | Yes      |
| info.app.version          | major.minor.build (e.g. 1.0.0)        | Yes      |
| info.app.description      | Something about your application      | Yes      |
| server.port               | e.g. 8083                             | Yes      |
| static.html.folder        | e.g. /tmp/html                        | Yes      |
| yaml.rest.automation      | Default value is classpath:/rest.yaml | Optional |
| yaml.mime.types           | Optional config file                  | Optional |
| mime.types                | Map of file extensions to MIME types  | Optional |
| yaml.custom.content.types | Optional config file                  | Optional |
| custom.content.types      | List of content type mappings         | Optional |
| log.format                | text, compact or json. default=text   | Optional |
| log.level                 | default 'info'                        | Optional |
| health.dependencies       | e.g. 'database.health'                | Optional |

## Static HTML contents

You can place static HTML files (e.g. the HTML bundle for a UI program) in the "resources/public" folder or
in the local file system using the "static.html.folder" parameter.

## MIME types

The system supports a bare minimal list of file extensions to MIME types in the `mime-types.yml` configuration
file in the composable foundation library's resources folder. If your use case requires additional MIME type
mapping, you may define them in the `application.yml` configuration file under the `mime.types` section like this:

```yaml
mime.types:
  pdf: 'application/pdf'
  doc: 'application/msword'
```

You may also provide a mime.types section in the `mime-types.yml` configuration under the resources folder
to override the default configuration in the composable foundation library. To tell the system to load
the new configuration file, add this entry in application.yml:

```yaml
yaml.mime.types: 'classpath:/mime-types.yml'
```

## Custom content types

If you use custom content types in your application, you may add the following section in the application.yml
configuration file. For example,

```yaml
custom.content.types:
  - 'application/vnd.my.org-v2.0+json -> application/json'
  - 'application/vnd.my.org-v2.1+xml -> application/xml'
```

In the "custom.content.types" section, you can configure a list of content-type mappings.
The left-hand-side is the custom content-type and the right-hand-side is a standard content-type.

The content-type mapping tells the system to treat the custom content type as if it is the standard content
type.

In the above example, the HTTP payload with the custom content type "application/vnd.my.org-v2.0+json" is
treated as a regular JSON content.

If you want to put the custom content types in a separate configuration file, please put them in a file named
`custom-content-types.yml` under the `resources` folder and add this entry in application.yml:

```yaml
yaml.custom.content.types: 'classpath:/custom-content-types.yml'
```

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
