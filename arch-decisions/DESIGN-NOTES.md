# Design notes

## Composable application

Modern applications are sophisticated. Navigating multiple layers of application logic, utilities and libraries
make code complex and difficult to read.

To make code readable and module, we advocate the composable application design pattern.

Each function in a composable application is a building block of functionality. It is self-contained, stateless
and independent of the rest of the application. You can write code using the first principle of "input-process-output".

## Fully event driven

Mercury is both a development methodology and a toolkit. It articulates the use of events between functions
instead of tight coupling using direct method calls.

In Node.js, this is particular important because it ensures that each function yields to the event loop without
blocking the rest of the application, resulting in higher performance and throughout.

## Reactive design

The system encapsulates the standard Node.js EventEmitter with a "manager and worker" pattern. Each worker of 
a function will process incoming event orderly. This allows the developer the flexibility to implement singleton
pattern and parallel processing easily.

## Native Node.js stream and ObjectStream I/O

It integrates natively with the standard Node.js stream library. For higher digital decoupling, the system
provides a set of ObjectStream I/O API so that producer can write to a stream before a consumer is ready.

To reduce memory footprint, the system uses the temporary local file system at "/tmp/composable/node/temp-streams" to hold
data blocks of a stream. The temporary data blocks are cleared automatically when a stream is read or closed.

## Configuration management

The system supports a base configuration (application.yml) and the developer can use additional configuration files
with the "ConfigReader" API. It follows a structured configuration approach similar to Java's Spring Boot.

## Compatibility with browsers

The core engine does not have dependency on the local file system. This provides a path to support Composable design
in a browser application in future iterations.
