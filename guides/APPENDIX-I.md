# Application configuration

The application base configuration can be defined in the application.yml file.

The following parameters are reserved by the system. You can add your application parameters
in the main application configuration file (`application.yml`) or apply additional configuration
files using the `ConfigReader` API.

| Key                       | Value (example)                                                 | Required |
|:--------------------------|:----------------------------------------------------------------|:---------|
| application.name          | Application name                                                | Yes      |
| info.app.version          | major.minor.build (e.g. 1.0.0)                                  | Yes      |
| info.app.description      | Something about your application                                | Yes      |
| server.port               | e.g. 8083                                                       | Yes      |
| static.html.folder        | e.g. classpath:/public or file:/tmp/html                        | Yes      |
| web.component.scan        | a comma separated list of composable library                    | Yes      |
| yaml.rest.automation      | Default value is classpath:/rest.yaml                           | Optional |
| yaml.custom.content.types | Optional config file                                            | Optional |
| custom.content.types      | List of content type mappings                                   | Optional |
| log.format                | text, compact or json. default=text                             | Optional |
| log.level                 | Default: 'info'                                                 | Optional |
| health.dependencies       | e.g. 'database.health'                                          | Optional |
| modules.autostart         | list of composable functions to start                           | Optional |
| max.model.array.size      | max size of a dynamic model variable as index<br>(Default 1000) | Optional |

## Configuration management

The application.yml config file must be placed in the "src/resources" folder in your project. For unit test,
it can be placed in the "test/resources" folder.

The configuration management system will discover configuration files with the following order of precedence:

```shell
dist/resources
test/resources
src/resources
(library-1)/dist/resources
(library-2)/dist/resources
(library-n)/dist/resources
```

For example, if a config file is not found in the test/resources folder in a unit test, it will search
the "src/resources" folder. If still not found, it will search the list of libraries for their resources
folders.

The resource file path must be prefixed with the keyword `classpath:`.
This discovery mechanism applies to all types of files including config files.

If your application needs to use a resource file, you can programmatically look up the file like this:

```javascript
const filePath = config.resolveResourceFilePath('classpath:/private/interesting.txt');
// filePath will be resolved as a fully qualified file path
// if not found, a null value will be returned
```

> *Note*: While the search order for libraries is defined by the web.component.scan parameter,
          it is always a good idea to use unique filenames for resource files in a library
          to avoid unintended configuration errors.

## Static HTML contents

You can place static HTML files (e.g. the HTML bundle for a UI program) in the "resources/public" folder or
in the local file system using the "static.html.folder" parameter.

Static HTML contents are served by the built-in Express static file handler.

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

|              Chapter-8              |                   Home                    |             Appendix-II             |
|:-----------------------------------:|:-----------------------------------------:|:-----------------------------------:|
| [Custom Flow Adapter](CHAPTER-8.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Async HTTP client](APPENDIX-II.md) |
