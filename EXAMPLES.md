# Examples

## Building the project

Please build the system as follows:

```
npm install
npm run build
```

## Running application in standalone mode

```
cd target/examples
node standalone-rpc.js
```

Please try the standalone examples first

1. standalone-rpc: this demonstrates sending a RPC call to a function
2. standalone-callback: this sends a request to a function which returns the result to a callback function
3. standalone-drop-n-forget: this illustrates a simple case of sending drop-n-forget events to a function
4. standalone-simple-tracing: this shows you can programmatically enable distributed tracing
5. standalone-nested-tracing: this demonstrates how to propagate trace information to downstream services

You should now have a good idea of how the event system works.

## Using the language pack sidecar

Please clone the Mercury development toolkit from https://github.com/Accenture/mercury

Follow the README to build the dependencies and applications.
This is as simple as doing `mvn clean install`.

Note that you must have maven and OpenJDK installed. We have tested building and running Mercury toolkit
in Windows, Mac and Ubuntu operating systems with maven v3.6.3 and Java 1.8 to 17.

Once the Mercury toolkit is built, go to the 'language pack' folder and run the language-connector like this:

```
java -jar target/language-connector-2.3.5.jar
```

The language pack has a built-in REST automation engine listening to port 8300 and a language connector listening to port 8090.

## Your first hello world application

In the Mercury node.js project, go to the 'target/examples' folder and run the 'hello world' application.

```
node hello-world.js
```

You will see it started with one "Public" function called "hello.world" and then connect to the language connector at 8090.
This assumes you are running the language-connector and the hello-world node.js app in the same computer, virtual machine or kubernetes POD.

From your browser, visit http://127.0.0.1:8300/info/routes and you will see something like this:

```json
{
  "app": {
    "name": "language-connector",
    "description": "Language Connector for Python, Node.js and Go",
    "version": "2.3.5"
  },
  "routing": {
    "async.http.request": "2022-06-12T00:18:56.544Z",
    "hello.world": "2022-06-12T00:19:46.012Z",
    "notification.manager": "2022-06-12T00:18:57.825Z",
    "system.service.query": "2022-06-12T00:18:57.847Z"
  },
  "journal": []
}
```

You can see "hello.world" is already available there.

Now visit http://127.0.0.1:8300/api/hello/world and you will see your hello world service responds with this:

```json
{
  "headers": {
    "accept-language": "en-US,en;q=0.9",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36"
  },
  "method": "GET",
  "ip": "127.0.0.1",
  "https": false,
  "url": "/api/hello/world",
  "timeout": 10
}
```

The hello world application just echoes back the HTTP request in its event dataset format.

Well done. You have witnessed an end-to-end transaction from your browser thru the language connector to consume your hello world service.

## Distributed tracing

In the language-connector Java source repository, you will find a configuration file called "rest.yaml" in the "resources" folder.

Please copy this and save it to "/tmp/config/rest.yaml". Browse this README at https://github.com/Accenture/mercury/tree/master/extensions/rest-automation-app to see the example. The configuration should be self-explanatory.

The "/api/hello/world" endpoint has "tracing" turned ON. As a result, you are seeing distributed trace log in both the language-connector and hello world log output. You can correlate the log with the trace ID to make sense of how a transaction flows.

In a production system, the performance metrics in the distributed trace log are sent to a centralized log analytics system for visualization.

## Handling the HTTP request event object

Let's do something more advanced.

Please press "Control-C" in the hello-world.js application. It will immediate stop.

We will move on to the "http-echo.js" application.

```
node http-echo.js
```

The http-echo application is exactly the same as the hello-world service. The only difference is that it can inspect the incoming HTTP request event. In this demo, it prints out the HTTP method and URI.

You can also programmatically change the HTTP response's headers, status code and other information.
In this example, the demo app sets a custom HTTP response header 'X-Custom-Header'.

You may turn on "inspector" panel in the browser and select the "network" tab.

Reload the page at http://127.0.0.1:8300/api/hello/world and you will see the custom response header in the inspector panel.

## Monitor cloud connection status

The life-cycle-events.ts is an example to monitor cloud connection status.

## Event stream system

Sending real-time events are great. We can now write application with functions that are loosely coupled by events. The functions communicate with each other not only in the same application memory but also across application instances in the network. For the latter, you can select an event stream system that fits your use cases.

Mercury supports Kafka, Hazelcast, ActiveMQ and TIBCO out of the box. This platform abstraction means that your application does not need any library dependencies. You do not need to code according to specific event stream system API.

## Automatic payload segmentation

For best performance, an event usually contains a small payload. As a rule of thumb, we recommend a payload of less than 6,000 bytes.

What if you must send a larger payload?

While this is not recommended, the system can handle medium size payload in mega-bytes. It will automatically segmentize a large payload into 64 KB segments for efficient transport across Kafka and other event systems. Note that Kafka has a one MB payload limit. With automatic payload segmentation, you are no longer constrained.

## Streaming I/O

When we deal with large payload, the best practice is to use streaming I/O. Your application can create a stream for the transport of a large sequence of events.

Normally streaming I/O is short lived. For example, we use streaming I/O for file upload and download in the REST automation system.

However, for some very advanced use cases, you can create a stream that never closes provided that there are data flowing continuously.

To see this feature, please try the "stream-demo" application.

```
node stream-demo.js
```

## Service applications are usually running forever

You notice that when you enable the cloud connector to connect to the language connector sidecar, your application is running forever in the foreground. You can press Control-C to shutdown the application gracefully.

As a service, this allows you to deploy the application in the background in your CI/CD pipeline.

When you use the Mercury node.js toolkit, you can also write standalone application. In fact, you can combine your favorite application server such as Express.

Mercury has a built-in service mesh feature. This gives a lot of flexibility in designing the overall system architecture for your distributed applications. You can use the Mercury built-in event stream connectors for strong platform abstraction. Alternatively, you can also pick your own service mesh and run each application container in a self-contained manner.
