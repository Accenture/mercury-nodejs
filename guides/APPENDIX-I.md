# application.yml

The following parameters are reserved by the system. You can add your application parameters
in the main application configuration file (application.yml) or apply additional configuration
files using the `ConfigReader` API.

| Key                  | Value (example)                  | Required |
|:---------------------|:---------------------------------|:---------|
| application.name     | Application name                 | Yes      |
| info.app.version     | major.minor.build (e.g. 1.0.0)   | Yes      |
| info.app.description | Something about your application | Yes      |
| server.port          | e.g. 8083                        | Yes      |
| static.html.folder   | e.g. /tmp/html                   | Yes      |
| log.format           | text or json                     | Optional |
| log.level            | default 'info'                   | Optional |
| static.html.folder   | e.g. /tmp/html                   | Yes      |
| health.dependencies  | e.g. 'database.health'           | Optional |

# Transient data store

The system uses a temp folder in "/tmp/node/streams" to hold temporary data blocks for streaming I/O.

# Reserved route names

The following route names are reserved by the system.

| Route               | Purpose                                          | Modules         |
|:--------------------|:-------------------------------------------------|:----------------|
| distributed.tracing | Distributed tracing logger                       | core engine     |
| async.http.request  | HTTP response event handler                      | core engine     |
| event.api.service   | Event API handler                                | REST automation |
| actuator.services   | admin endpoints (/info, /health, /livenessprobe) | REST automation |

<br/>

|          Chapter-6           |                   Home                    |             Appendix-I              |
|:----------------------------:|:-----------------------------------------:|:-----------------------------------:|
| [API overview](CHAPTER-6.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Async HTTP client](APPENDIX-II.md) |

