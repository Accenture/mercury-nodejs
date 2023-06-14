# Event orchestration

In traditional programming, we can write modular software components and wire them together as a single application.
There are many ways to do that. You can rely on a "dependency injection" framework. In many cases, you would need
to write orchestration logic to coordinate how the various components talk to each other to process a transaction.

In a composable application, you write modular functions using the first principle of "input-process-output".

Functions communicate with each other using events and each function has a "handleEvent" method to process "input"
and return result as "output". Writing software component in the first principle makes Test Driven Development (TDD)
straight forward. You can write mock function and unit tests before you put in actual business logic.

Mocking an event-driven function in a composable application is as simple as overriding the function's route name
with a mock function.

## Register a function with the in-memory event system

There are two ways to register a function:

1. Programmatic registration
2. Declarative registration

In programmatic registration, you can register a function like this:

```shell
const platform = new Platform();
...
platform.register('my.function', helloWorld, true, 10);
```

In the above example, You obtain a singleton instance of the Platform API class and use it to register a private
function `helloWorld` with a route name "my.function" and up to 10 concurrent worker instances.

In declarative approach, you use the `preLoad` annotation to register a class with an event handler like this:

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

To tell the system where to find the functions, you can configure the "preload.yaml" file like this:

```yaml
preload:
  - name: 'hello.world'
    private: false
    instances: 10
    interceptor: false
  - name: 'demo.health'
    private: true
    instances: 5
    interceptor: false
  - name: 'v1.api.auth'
    private: true
    instances: 5
    interceptor: false
```

In the above configuration example, the "preload" section tells the system to load the functions
into the event loop.

Once a function is created using the declarative method, you can override it with a mock function by using the
programmatic registration method in a unit test.

## Private vs public functions

A private function is visible by other functions in the same application memory space.

A public function is accessible by other function from another application instance using the
"Event over HTTP" method. We will discuss inter-container communication in [Chapter-5](CHAPTER-5.md).

## Post Office API

To send an asynchronous event or an event RPC call from one function to another, you can use the `PostOffice` APIs.

For example,

```javascript
async handleEvent(evt: EventEnvelope) {
    const po = new PostOffice(evt.headers());
    const req = new EventEnvelope().setTo(HELLO_WORLD_SERVICE).setBody(TEST_MESSAGE);
    const result = await po.request(req, 3000);
    ...
```

Note that the input to the PostOffice is the incoming event's headers. The PostOffice API detects if tracing
is enabled in the incoming request. If yes, it will propagate tracing information to "downstream" functions.

## Event patterns

1. RPC `“Request-response”, best for interactivity`
2. Asynchronous `e.g. Drop-n-forget`
3. Callback `e.g. Progressive rendering`
4. Pipeline `e.g. Work-flow application`
5. Streaming `e.g. File transfer`

### Request-response (RPC)

In enterprise application, RPC is the most common pattern in making call from one function to another.

The "calling" function makes a request and waits for the response from the "called" function.
There are 2 code patterns for RPC.

#### async/await pattern

To wait for a response, you can use the "await" keyboard since your function has been declared as "async".

```javascript
const result = await po.request(req, 3000);
```

#### Promise pattern

```javascript
po.request(req, 3000)
    .then(event => {
        // handle the response
    })
    .catch(e => {
        // handle exception
    });
```

### Callback

You can declare another function as a "callback". When you send a request to another function, you can set the
"replyTo" address in the request event. When a response is received, your callback function will be invoked to
handle the response event.

```javascript
const request = new EventEnvelope().setTo('hello.world')
                                   .setBody('test message').setReplyTo('my.callback');
po.send(request);
```

In the above example, you have a callback function with route name "my.callback". You send the request event
with a JSON object as payload to the "hello.world" function. When a response is received, the "my.callback"
function will get the response as input.

### Pipeline

Pipeline is a linked list of event calls. There are many ways to do pipeline. One way is to keep the pipeline plan
in an event's header and pass the event across multiple functions where you can set the "replyTo" address from the
pipeline plan. You should handle exception cases when a pipeline breaks in the middle of a transaction.

An example of the pipeline header key-value may look like this:

```properties
pipeline=service.1, service.2, service.3, service.4, service.5
```

In the above example, when the pipeline event is received by a function, the function can check its position
in the pipeline by comparing its own route name with the pipeline plan.

In a function, you can retrieve its own route name like this:

```javascript
const myRoute = evt.getHeader('my_route');
```

The "my_route" header is a metadata inserted by the system.

Suppose myRoute is "service.2", the function can send the response event to "service.3".
When "service.3" receives the event, it can send its response event to the next one. i.e. "service.4".

When the event reaches the last service ("service.5"), the processing will complete.

### Streaming

If you set a function as singleton (i.e. one worker instance), it will receive event in an orderly fashion.
This way you can "stream" events to the function, and it will process the events one by one.

Another means to do streaming is to create an "ObjectStreamIO" event stream like this:

```javascript
const stream = new ObjectStreamIO(60);
const out = new ObjectStreamWriter(stream.getOutputStreamId());
out.write(messageOne);
out.write(messageTwo);
out.close();

const streamId = stream.getInputStreamId();
// pass the streamId to another function
```

In the code segment above, your function creates an object event stream and writes 2 messages into the stream
It obtains the streamId of the event stream and sends it to another function. The other function can read the
data blocks orderly.

You must declare "end of stream" by closing the output stream. If you do not close an output stream,
it remains open and idle. If a function is trying to read an input stream using the stream ID and the
next data block is not available, it will time out.

A stream will be automatically closed when the idle inactivity timer is reached. In the above example,
ObjectStreamIO(60) means an idle inactivity timer of 60 seconds.

In another function, it may read the input stream like this:

```javascript
const stream = new ObjectStreamReader(streamId, 5000);
while (someCondition) {
    const b = await stream.read();
    if (b instanceof Buffer) {
        // process the data block
    }
    if (b == null) {
        // this means EOF - the stream will be closed automatically
        break
    }
}
```

You can browse the "hello-world-service.ts" for the file upload and download statements to examine the
streaming code patterns.

Mercury 3.0 streams use the temporary folder at "/tmp/node/streams" folder to hold data blocks.
The temporary data blocks are cleaned once they are read by a function.

In your functions, you can send/receive JSON object, bytes (`Buffer`) and text (`string`) with the object stream system.

For REST automation, it uses only Buffer and string.

## Orchestration layer

Once you have implemented modular functions in a self-contained manner, the best practice is to write one or more
functions to do "event orchestration".

Think of the orchestration function as a music conductor who guides the whole team to perform.

For event orchestration, your function can be the "conductor" that sends events to the individual functions so that
they operate together as a single application. To simplify design, the best practice is to apply event orchestration
for each transaction or use case. The event orchestration function also serves as a living documentation about how
your application works. It makes your code more readable.

## Event Script

To automate event orchestration, there is an enterprise add-on module called "Event Script".
This is the idea of "config over code" or "declarative programming". The primary purpose of "Event Script"
is to reduce coding effort so that the team can focus in improving application design and code quality.
Please contact your Accenture representative if you would like to evaluate the additional tool.

In the next chapter, we will discuss the build, test and deploy process.
<br/>

|            Chapter-3            |                   Home                    |            Chapter-5            |
|:-------------------------------:|:-----------------------------------------:|:-------------------------------:|
| [REST automation](CHAPTER-3.md) | [Table of Contents](TABLE-OF-CONTENTS.md) | [Event over HTTP](CHAPTER-5.md) |
