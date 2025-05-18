import fs from 'fs';
import { Logger } from '../src/util/logger';
import { PostOffice, Sender } from '../src/system/post-office';
import { Platform } from '../src/system/platform';
import { RestAutomation } from '../src/system/rest-automation';
import { EventScriptEngine } from '../src/automation/event-script-manager';
import { AppConfig } from '../src/util/config-reader';
import { Utility } from '../src/util/utility';
import { MultiLevelMap } from '../src/util/multi-level-map';
import { EventEnvelope } from '../src/models/event-envelope';
import { AsyncHttpRequest } from '../src/models/async-http-request';
import { Composable } from '../src/models/composable';
import { NoOp } from '../src/services/no-op';
import { AppException } from '../src/models/app-exception';
import { EventScriptMock } from '../src/mock/event-script-mock';
import { fileURLToPath } from "url";
import { FlowExecutor } from '../src/adapters/flow-executor';
import { ResilienceHandler } from '../src/services/resilience-handler';

const ASYNC_HTTP_CLIENT = 'async.http.request';
const API_AUTH_SERVICE = 'event.api.auth';
const TYPE = "type";
const PUT = "put";
const GET = "get";
const REMOVE = "remove";
const KEY = "key";
const USER = "user";
const SEQ = "sequence";
const GREETING = "greeting";
const MESSAGE = "message";
const TIME = "time";
const EXCEPTION = "exception";
const ORIGINAL = "original";
const TIMEOUT = "timeout";
const CUSTOM = "custom";
const DEMO = "demo";
const STATUS = 'status';
const ERROR = 'error';
const X_FLOW_ID = "x-flow-id";
const DECISION = "decision";
const BREAK = "break";
const CONTINUE = "continue";
const JUMP = "jump";
const INCREMENT = "increment";

const log = Logger.getInstance();
const util = new Utility();
const store = {};
let iterationCount = 0;
let parallelCounter = 2; 
let platform: Platform;
let server: RestAutomation;
let eventManager: EventScriptEngine;
let resourcePath: string;
let baseUrl: string;

function getRootFolder() {
    const folder = fileURLToPath(new URL("..", import.meta.url));
    // for windows OS, convert backslash to regular slash and drop drive letter from path
    const path = folder.includes('\\')? folder.replaceAll('\\', '/') : folder;
    const colon = path.indexOf(':');
    return colon == 1? path.substring(colon+1) : path;
}

class SimpleAuth implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const req = new AsyncHttpRequest(evt.getBody() as object);
    const authorized = "demo" == req.getHeader("authorization");
    const method = req.getMethod();
    const url = req.getUrl();
    log.info(`Perform API authentication for ${method} ${url}`);
    //
    // This is a test. When authorization=demo, it will approve the request.
    // When function returns false, the system will send "HTTP-401 Unauthorized"
    // to the caller.
    // 
    // Setting a special header to demonstrate that an authentication
    // function can add user information.
    //
    return new EventEnvelope().setBody(authorized).setHeader('x-user-profile', 'demo-user-profile');
  }
}

class ExtStateMachine implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    if (!evt.getHeader(KEY)) {
      throw new Error("Missing key in headers");
    }
    const type = evt.getHeader(TYPE);
    const key = evt.getHeader(KEY);
    const input = evt.getBody();
    if (PUT == type && input instanceof Object && 'data' in input) {
      var data = input['data'];
      if (data) {
          log.info(`Saving ${key} to store`);
          store[key] = data;
          return true;
      }
    }
    if (GET == type) {
        const v = store[key];
        if (v) {
            log.info(`Retrieve ${key} from store`);
            return v;
        } else {
            return null;
        }
    }
    if (REMOVE == type) {
        if (key in store) {
            delete store[key];
            log.info(`Removed ${key} from store`);
            return true;
        } else {
            return false;
        }
    }
    return false;
  }  
}

class FileVault implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody();
    if (input instanceof Object) {
      const text = input["text"];
      const binary = input["binary"];
      const result = {};
      if (typeof text == 'string' && binary instanceof Buffer) {
          if (String(binary) == text) {
              result["text"] = text;
              result["matched"] = true;
          } else {
              result["matched"] = false;
              result["text"] = "Input text and binary values do not match";
          }
          // set a test field with binary value
          result["binary"] = Buffer.from('binary');
      } else {
          result["error"] = "Input must be a map of text and binary key values";
      }
      const textRes = input["text_resource"];
      const binaryRes = input["binary_resource"];
      if (typeof textRes == 'string' && binaryRes instanceof Buffer) {
          if (String(binaryRes) == textRes) {
              result["text_resource"] = textRes;
              result["matched"] = true;
          } else {
              result["matched"] = false;
              result["text_resource"] = "Input text and binary values do not match";
          }
      } else {
          result["error"] = "Input must be a map of text and binary key values";
      }
      return result;
    } else {
      return null;
    }
  }
}

class ExceptionSimulator implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const exception = evt.getHeader('exception');
    if (exception) {
      const code = util.str2int(exception);
      throw new AppException(code == -1? 400 : code, "Simulated Exception");
    }
    const input = evt.getBody() as object;
    if ('accept' in input) {
      const accept = util.str2int(String(input['accept']));
      const attempt = util.str2int('attempt' in input? String(input['attempt']) : '0');
      if (attempt == accept) {
          return {'attempt': attempt, 'message': 'Task completed successfully'};
      } else {
          throw new AppException(400, "Demo Exception");
      }
    }
    // just echo input when there is no need to throw exception
    return input;
  }
}

class BreakableFunction implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    const accept = util.str2int('accept' in input? String(input['accept']) : '0');
    const attempt = util.str2int('attempt' in input? String(input['attempt']) : '0');
    if (attempt == accept) {
        return {'attempt': attempt, 'message': 'Task completed successfully'};
    }
    throw new AppException(400, "Just a demo exception for circuit breaker to handle");
  }  
}

class CircuitBreaker implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    const maxAttempts = util.str2int('max_attempts' in input? String(input['max_attempts']) : '1');
    const attempt = util.str2int('attempt' in input? String(input['attempt']) : '0');
    const status = util.str2int('status' in input? String(input['status']) : '200');
    const message = 'message' in input? String(input['message']) : 'unknown';
    // retry when attempt < maxAttempts
    const retry = attempt < maxAttempts;
    const attempted = attempt + 1;
    const result = {};
    result["decision"] = retry;
    result["attempt"] = attempted;
    result["status"] = status;
    result["message"] = message;
    if (retry) {
        log.info(`Retry ${attempted}`);
    } else {
        log.info("Abort");
    }
    return result;
  }  
}

class AbortRequest implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    log.info(`Abort ${JSON.stringify(evt.getBody())}`);
    return evt;
  }  
}

class Greetings implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    const exceptionTag = input[EXCEPTION];
    if (exceptionTag) {
        if (TIMEOUT == exceptionTag) {
            await util.sleep(2000);
        } else if (CUSTOM == exceptionTag) {
          return new EventEnvelope().setStatus(400).setBody({'error': 'non-standard-format'});
        } else {
            throw new AppException(403, "just a test");
        }
    }
    if (USER in input && GREETING in input) {
        const greeting = String(input[GREETING]);
        const user = String(input[USER]);
        const result = {};
        result[USER] = user;
        result[GREETING] = greeting;
        result[MESSAGE] = "I got your greeting message - "+greeting;
        result[TIME] = new Date().toISOString();
        result[ORIGINAL] = input;
        if (evt.getHeader(DEMO)) {
            result[DEMO+1] = evt.getHeader(DEMO);
        }
        if (evt.getHeader(USER)) {
            result[DEMO+2] = evt.getHeader(USER);
        }
        if (evt.getHeader(X_FLOW_ID)) {
            result[DEMO+3] = evt.getHeader(X_FLOW_ID);
        }
        if (evt.getHeader(X_FLOW_ID)) {
          result[DEMO+4] = evt.getHeader('x-user-profile');
        }
        return new EventEnvelope().setBody(result).setHeader(DEMO, "test-header").setStatus(201);
    } else {
        // the easiest way for error handling is just throwing an exception
        throw new Error("Missing user or greeting");
    }
  }  
}

class HelloException implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    log.info(`User defined exception handler got ${JSON.stringify(evt.getHeaders())} ${JSON.stringify(evt.getBody())}`);
    const input = evt.getBody() as object;
    if (STATUS in input && MESSAGE in input) {
        const error = {};
        error[STATUS] = input[STATUS];
        error[MESSAGE] = input[MESSAGE];
        error[TYPE] = ERROR;
        return error;
    } else {
        return {};
    }
  }  
}

class SimpleDecision implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    if (DECISION in input) {
        return "true" == String(input[DECISION]);
    } else {
        throw new Error("Missing decision");
    }
  }  
}

class NumericDecision implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    if (DECISION in input) {
        return util.str2int(String(input[DECISION]));
    } else {
        throw new Error("Missing decision");
    }
  }  
}

class DecisionCase implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    if (EXCEPTION in input) {
      throw new AppException(400, String(input[EXCEPTION]));
    }
    let n = util.str2int(String(input["n"]));
    if (INCREMENT in input) {
      n++;
      input["n"] = n;
    }
    if (CONTINUE in input) {
      const skip = util.str2int(String(input[CONTINUE]));
      if (n == skip) {
          input["continue"] = true;
      }
    }
    // 'break' or 'jump' from unit test will set different condition (model.quit or model.jump)
    // Either of the condition would result in a "break" action.
    if (BREAK in input) {
      const breakAt = util.str2int(String(input[BREAK]));
      if (n == breakAt) {
          input["quit"] = true;
      }      
    }
    if (JUMP in input) {
      const skip = util.str2int(String(input[JUMP]));
      if (n == skip) {
        input["jump"] = true;            
      }
    }
    return input;
  }  
}

class SequenceOne implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    if (USER in input && SEQ in input) {
        const result = {};
        result[USER] = input['user'];
        result[SEQ] = util.str2int(String(input[SEQ]));
        return result;
    } else {
        throw new Error("Missing user or sequence");
    }
  }  
}

class PrepareParallelTest implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    const input = evt.getBody() as object;
    const n = input['count'];
    log.info(`There are ${n} parallel tasks`);
    parallelCounter = 0;
    return null;
  }
}

class ParallelTask implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    parallelCounter++;
    const done = parallelCounter == 2;
    const input = evt.getBody() as object;
    const result = {'decision' : done};
    log.info(`${JSON.stringify(input)}, counter=${parallelCounter}`);
    for (const k in input) {
      result[k] = input[k];
    }
    if (done) {
      log.info('I am the second task so I will sleep briefly to let the first task to complete');
      await util.sleep(200);
      log.info("I have waked up");
    } else {
      log.info('I am the first task');
    }
    return result;
  }
}

class MockFunction implements Composable {
  initialize(): Composable {
    return this;
  }
  async handleEvent(evt: EventEnvelope) {
    iterationCount++;
    return evt;
  }
}

function getByteArrayFromEncodedIntegers(integers: object): Buffer {
  if ('data' in integers && 'Buffer' == integers['type']) {
    const items = integers['data'];
    if (Array.isArray(items)) {
      return Buffer.from(items);
    }
  }
  return Buffer.from('');
}

/**
 * We will override server port so Flow tests can co-exist with PostOffice unit tests.
 * 
 * Since Jest would start a batch of unit tests in a different Node's V8 instance,
 * unit tests in different batches are independent from each others.
 * 
 * However, REST automation is using a network port that may not have closed
 * when another REST automation engine is started.
 * 
 * Therefore, we will update the base configuration in application.yml
 * to use different port here.
 */
describe('event flow use cases', () => {
  
  beforeAll(async () => {
    resourcePath = getRootFolder() + 'test/resources';
    // AppConfig should be initialized with base configuration parameter before everything else
    const appConfig = AppConfig.getInstance(resourcePath);
    // You can programmatically change a configuration parameter.
    // This emulates Java's System.setProperty behavior.
    appConfig.set('server.port', 8301);
    const port = appConfig.getProperty("server.port");
    // print out the port number to confirm that it is using a different one.
    baseUrl = `http://127.0.0.1:${port}`;
    log.info(`Flow tests will use ${baseUrl}`);
    platform = Platform.getInstance();
    await platform.getReady();
    // register some composable functions
    platform.register(API_AUTH_SERVICE, new SimpleAuth());
    platform.register('no.op', new NoOp());
    platform.register('v1.ext.state.machine', new ExtStateMachine());
    platform.register("file.vault", new FileVault());
    platform.register("breakable.function", new BreakableFunction());
    platform.register("exception.simulator", new ExceptionSimulator());
    platform.register("v1.circuit.breaker", new CircuitBreaker());
    platform.register("abort.request", new AbortRequest());
    platform.register("greeting.test", new Greetings(), 5, false);
    platform.register('v1.hello.exception', new HelloException());
    platform.register('simple.decision', new SimpleDecision());
    platform.register('numeric.decision', new NumericDecision());
    platform.register('decision.case', new DecisionCase());
    platform.register('sequential.one', new SequenceOne());
    platform.register('begin.parallel.test', new PrepareParallelTest());
    platform.register('parallel.task', new ParallelTask());
    platform.register('my.mock.function', new MockFunction());
    platform.register('resilience.handler', new ResilienceHandler(), 10, true, true);
    // start the Event API HTTP server
    server = RestAutomation.getInstance();
    server.start();
    eventManager = new EventScriptEngine();
    eventManager.start();
    platform.runForever();
  });
  
  afterAll(async () => {
    if (server) {
      // This is redundant because the server will be automatically stopped by the platform
      await server.stop();
    } 
    // This will release all outstanding streams, stop REST automation and then stop the platform
    await platform.stop();
    // Give console.log a moment to finish
    await util.sleep(1000);
  });

  it('will reject request when flow-id does not exist', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/no-such-flow');
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(result.getStatus()).toBe(500);
    expect(result.getBody() instanceof Object).toBeTruthy();
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement('type')).toBe('error');
    expect(map.getElement('status')).toBe(500);
    expect(map.getElement('message')).toBe("Flow no-such-flow not found");
  }); 

  
  it('can use external state machine function', async () => {
    const testUser = 'test-user';
    const payload = {'hello': 'world'};
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('PUT').setTargetHost(baseUrl).setUrl(`/api/ext/state/${testUser}`)
                                        .setHeader('accept', 'application/json')
                                        .setHeader('content-type', 'application/json').setBody(payload);
    const reqEvent1 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result1 = await po.request(reqEvent1);
    expect(result1.getBody() instanceof Object);
    const map1 = new MultiLevelMap(result1.getBody() as object);
    expect(map1.getElement('hello')).toBe('world');
    /*
      * We must assume that external state machine is eventual consistent.
      * Therefore, result may not be immediately available.
      *
      * However, for unit test, we set the external state machine function to have a single worker instance
      * so that the GET request will wait until the PUT request is done, thus returning result correctly.
      */
    const req2 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl(`/api/ext/state/${testUser}`)
                                        .setHeader('accept', 'application/json');
    const reqEvent2 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req2.toMap());
    const result2 = await po.request(reqEvent2);
    expect(result2.getBody() instanceof Object);
    const map2 = new MultiLevelMap(result2.getBody() as object);
    expect(map2.getElement('user')).toBe(testUser);
    expect(map2.getElement('payload')).toEqual(payload);
  }); 

  it('can use external state machine flow', async () => {
    const testUser = 'test-user';
    const payload = {'hello': 'world'};
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('PUT').setTargetHost(baseUrl).setUrl(`/api/ext/state/flow/${testUser}`)
                                        .setHeader('accept', 'application/json')
                                        .setHeader('content-type', 'application/json').setBody(payload);
    const reqEvent1 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result1 = await po.request(reqEvent1);
    expect(result1.getBody() instanceof Object);
    const map1 = new MultiLevelMap(result1.getBody() as object);
    expect(map1.getElement('hello')).toBe('world');
    /*
      * We must assume that external state machine is eventual consistent.
      * Therefore, result may not be immediately available.
      *
      * However, for unit test, we set the external state machine function to have a single worker instance
      * so that the GET request will wait until the PUT request is done, thus returning result correctly.
      */
    const req2 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl(`/api/ext/state/${testUser}`)
                                        .setHeader('accept', 'application/json');
    const reqEvent2 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req2.toMap());
    const result2 = await po.request(reqEvent2);
    expect(result2.getBody() instanceof Object);
    const map2 = new MultiLevelMap(result2.getBody() as object);
    expect(map2.getElement('user')).toBe(testUser);
    expect(map2.getElement('payload')).toEqual(payload);
  }); 

  it('can do type matching', async () => {
    const helloWorld = 'hello world';
    const hello = 'hello';
    const world = 'world';
    const helloWorldBytes = Buffer.from(helloWorld);
    const b64Text =  util.bytesToBase64(helloWorldBytes);
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('api/type/matching')
                                        .setHeader('accept', 'application/json');                                    
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement('b64')).toBe(b64Text);
    const m1 = {'b64': b64Text, 'text': helloWorld};
    expect(JSON.parse(map.getElement('json'))).toEqual(m1);
    expect(map.getElement('substring')).toBe(hello);
    const bson = getByteArrayFromEncodedIntegers(map.getElement('bson'));
    expect(JSON.parse(String(bson))).toEqual(m1);
    expect(getByteArrayFromEncodedIntegers(map.getElement('binary'))).toEqual(helloWorldBytes);
    expect(map.getElement("source.substring")).toBe(hello);
    expect(map.getElement("source.substring-2")).toBe(world);
    expect(getByteArrayFromEncodedIntegers(map.getElement("source.keep-as-binary"))).toEqual(helloWorldBytes);
    expect(map.getElement('source.no-change')).toBe(helloWorld);
    expect(getByteArrayFromEncodedIntegers(map.getElement("source.binary"))).toEqual(helloWorldBytes);
    expect(getByteArrayFromEncodedIntegers(map.getElement("source.bytes"))).toEqual(helloWorldBytes);
    expect(map.getElement("source.out-of-bound")).toBe(helloWorld);
    expect(map.getElement("source.invalid-substring")).toBe(helloWorld);
    expect(map.getElement("source.text")).toBe(helloWorld);
    expect(map.getElement("positive")).toBe(true);
    expect(map.getElement("negative")).toBe(false);
    expect(map.getElement("boolean-text")).toBe(false);
    expect(map.getElement("boolean-text-true")).toBe(true);
    expect(map.getElement("is-null")).toBe(true);
    expect(map.getElement("null")).toBe(true);
    expect(map.getElement("has-file")).toBe(false);
    expect(map.getElement("integer")).toBe(100);
    expect(map.getElement("long")).toBe(101);
    expect(map.getElement("float")).toBe(100.01);
    expect(map.getElement("double")).toBe(101.01);
    /*
      * test boolean and/or feature
      *
      * true and false = false
      * true or false = true
      */
    expect(map.getElement("and")).toBe(false);
    expect(map.getElement("or")).toBe(true);
    /*
      * test failed boolean mapping
      *
      * The following will return true because "nothing" does not belong to the state machine:
      * 'model.positive:and(nothing) -> output.body.nothing'
      */
    expect(map.getElement("nothing")).toBe(true);
    // type matching to get size of a list
    expect(map.getElement("source.list_size")).toBe(3);
    // type matching to get length of the number 1000
    expect(map.getElement("source.number_length")).toBe(4);
  });

  it('can do body test', async () => {
    const today = new Date().toISOString();
    const hello = 'hello world';
    const valueA = "A";
    const valueB = "B";
    const seq = 1;
    const pojo = {};
    pojo["user"] = hello;
    pojo["sequence"] = seq;
    pojo["date"] = today;
    pojo["key1"] = valueA;
    pojo["key2"] = valueB;
    const holder = {'pojoHolder': pojo}
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('POST').setTargetHost(baseUrl).setUrl('api/body/test')
                                        .setHeader('accept', 'application/json')
                                        .setHeader("content-type", "application/json")
                                        .setBody(holder);                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("user")).toBe(hello);
    expect(map.getElement("sequence")).toBe(seq);
    expect(map.getElement("key1")).toBe(valueA);
    expect(map.getElement("key2")).toBe(valueB);
    expect(result.getHeader('x-sequence')).toBe(String(seq));
    expect(result.getHeader('X-Tag')).toBe("AAA");
    expect(result.getHeader('X-agent')).toBe("async-http-client");    
  });  

  it('can do header test', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('api/header/test')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("x-flow-id")).toBe("header-test");
    expect(map.getElement("user-agent")).toBe("async-http-client");
    expect(map.getElement("accept")).toBe("application/json");
  });

  it('can do file vault test', async () => {
    const hello = 'hello world';
    const f1 = '/tmp/temp-test-input.txt';
    util.str2file(f1, hello);
    const resourceText = await util.file2str(resourcePath + '/files/hello.txt');
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('api/file/vault')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(typeof result.getBody()).toBe('string');
    expect(result.getBody()).toBe(resourceText);
    const f2 = '/tmp/temp-test-output.txt';
    expect(fs.existsSync(f2)).toBe(true);
    const f3 = '/tmp/temp-test-match.txt';
    expect(fs.existsSync(f3)).toBe(true);
    const f4 = '/tmp/temp-test-binary.txt';
    expect(fs.existsSync(f4)).toBe(true);
    expect(await util.file2str(f2)).toBe(hello);
    expect(await util.file2str(f3)).toBe("true");
    expect(await util.file2str(f4)).toBe("binary");
    // f1 will be deleted by the output data mapping 'model.none -> file(/tmp/temp-test-input.txt)'
    fs.rmSync(f2);
    fs.rmSync(f3);
    fs.rmSync(f4);
  });  

  it('will retry with a circuit breaker', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/circuit/breaker/2')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("attempt")).toBe(2);
  });

  it('will abort with max attempts with a circuit breaker', async () => {
    const po = new PostOffice(new Sender('unit.test', '101000', 'TEST /circuit/break'));
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/circuit/breaker/3')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(400);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("type")).toBe("error");
    expect(map.getElement("status")).toBe(400);
    expect(map.getElement("message")).toBe("Just a demo exception for circuit breaker to handle");
  });

  it('will retry with a circuit breaker', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/circuit/breaker/2')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("attempt")).toBe(2);
  });

  it('will handle backoff, retry and abort in resilience handler', async () => {
    // remove control files before running test
    const f1 = '/tmp/resilience/cumulative';
    const f2 = '/tmp/resilience/backoff';
    if (fs.existsSync(f1)) {
      fs.rmSync(f1);
    }
    if (fs.existsSync(f2)) {
      fs.rmSync(f2);
    }
    // run test
    const po = new PostOffice(new Sender('unit.test', '101000', 'TEST /resilience'));
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/resilience')
                            .setQueryParameter('exception', '400').setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const first = await po.request(reqEvent);
    // after 3 attempts, it aborts and returns error 400
    expect(first.getStatus()).toBe(400);
    const result = await po.request(reqEvent);
    // the system will enter into backoff mode when the cumulative attempt reaches 5
    expect(result.getStatus()).toBe(503);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("type")).toBe("error");
    expect(map.getElement("status")).toBe(503);
    expect(map.getElement("message")).toBe("Service temporarily not available - please try again in 2 seconds");
    // Let the backoff period expires
    log.info("Making request during backoff period will throw exception 503");
    const requestDuringBackoff = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/resilience')
                                    .setQueryParameter('exception', '400').setHeader('accept', 'application/json');                                                             
    const reqBo = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(requestDuringBackoff.toMap());
    const resultBo = await po.request(reqBo);
    expect(resultBo.getStatus()).toBe(503);
    expect(resultBo.getBody() instanceof Object);
    const mapBo = new MultiLevelMap(resultBo.getBody() as object);
    expect(mapBo.getElement("type")).toBe("error");
    expect(mapBo.getElement("status")).toBe(503);
    const msg = String(mapBo.getElement("message"));
    expect(msg.startsWith('Service temporarily not available')).toBeTruthy();
    log.info("Waiting for backoff period to expire");
    await util.sleep(2000);
    // Test alternative path using 'text(401, 403-404) -> reroute'
    // Let exception simulator to throw HTTP-401
    const request1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/resilience')
                                    .setQueryParameter('exception', '401').setHeader('accept', 'application/json');   
    const reqEvent1 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request1.toMap());
    const result1 = await po.request(reqEvent1);
    expect(result1.getStatus()).toBe(200);
    expect(result1.getBody() instanceof Object);
    expect(result1.getBody()).toEqual({'path': 'alternative'});
    const request2 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/resilience')
                                    .setQueryParameter('exception', '404').setHeader('accept', 'application/json');   
    const reqEvent2 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(request2.toMap());
    const result2 = await po.request(reqEvent2);
    expect(result2.getStatus()).toBe(200);
    expect(result2.getBody() instanceof Object);
    expect(result2.getBody()).toEqual({'path': 'alternative'});
  });  

  it('can do greeting test', async () => {
    const testUser = '24680';
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl(`/api/greetings/${testUser}`);
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(201);
    expect(result.getHeader('x-demo')).toBe('test-header');
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement('user')).toBe(testUser);
    expect(map.getElement('greeting')).toBe('hello world');
    expect(map.getElement('positive')).toBe(true);
    expect(map.getElement('original')).toBeTruthy();
    expect(map.getElement('original.user_number')).toBe(24680);
    expect(map.getElement('original.long_number')).toBe(12345);
    expect(map.getElement('original.float_number')).toBe(12.345);
    expect(map.getElement('original.double_number')).toBe(12.345);
    expect(map.getElement('original.double_number')).toBe(12.345);
    expect(map.getElement('original.boolean_value')).toBe(true);
    expect(map.getElement('original.negate_value')).toBe(false);
    expect(map.getElement('original.double_negate_value')).toBe(true);
    expect(map.getElement('original.none_is_true')).toBe(true);
    expect(map.getElement('original.none_is_false')).toBe(false);
    expect(map.getElement('original.unique_id1')).not.toEqual(map.getElement('original.unique_id2'));
    expect(map.getElement('original.unique_id2')).toEqual(map.getElement('original.unique_id3'));
    // demonstrate string concatenation
    expect(map.getElement('original.concat_string')).toBe('a b,c');
    expect(map.getElement('demo1')).toBe("ok");
    expect(map.getElement('demo2')).toBe(testUser);
    expect(map.getElement('demo3')).toBe("greetings");
    expect(map.getElement('demo4')).toBe("demo-user-profile");
    expect(map.getElement('name')).toBe(Platform.getInstance().getName());
    expect(map.getElement('map1.hello')).toBe('world');
    expect(map.getElement('map1.nice')).toBe('day');
    expect(map.getElement('map2.direction')).toBe('right');
    expect(map.getElement('map2.test')).toBe('message');
    expect(map.getElement('map3.wonderful')).toBe('story');
    expect(map.getElement('map3.world')).toBe('class');
  });

  it('can do parent greeting test', async () => {
    const testUser = 'test-user';
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl(`/api/parent-greeting/${testUser}`);
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(201);
    expect(result.getHeader('demo')).toBe('test-header');
    expect(result.getHeader('x-demo')).toBe('test-header');
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement('user')).toBe(testUser);
    expect(map.getElement('name')).toBe(platform.getName());
    expect(map.getElement('greeting')).toBe('hello world');
    expect(map.getElement('original')).toBeTruthy();
    expect(map.getElement('original.long_number')).toBe(12345);
    expect(map.getElement('original.float_number')).toBe(12.345);
    expect(map.getElement('original.double_number')).toBe(12.345);
    expect(map.getElement('original.double_number')).toBe(12.345);
    expect(map.getElement('original.boolean_value')).toBe(true);
    expect(map.getElement('demo1')).toBe("ok");
    expect(map.getElement('demo2')).toBe(testUser);
    expect(map.getElement('demo3')).toBe("parent-greetings");
  });  
  
  it('will reject when sub-flow is missing', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/missing-flow/test-user')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(500);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("message")).toBe("flow://flow-not-found not defined");
  });
  
  it('can throw exception from user function', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/greetings/test-user')
                                        .setQueryParameter('ex', 'true')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(403);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("message")).toBe("just a test");
    expect(map.getElement("status")).toBe(403);
    expect(map.getElement("type")).toBe("error");
  });

  it('can throw exception with custom error message', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/greetings/test-user')
                                        .setQueryParameter('ex', 'custom')
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(400);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    // demonstrate that custom error message object can be transported
    expect(map.getElement("message")).toEqual({"error": "non-standard-format"});
    expect(map.getElement("status")).toBe(400);
    expect(map.getElement("type")).toBe("error");
  });  

  it('can timeout from a flow', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/timeout/test-user')
                                        .setQueryParameter('ex', "timeout")
                                        .setHeader('accept', 'application/json');                                                             
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(408);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("message")).toBe("Flow timeout for 1000 ms");
  });

  it('can make simple decision', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/decision')
                                        .setQueryParameter('decision', "false")
                                        .setHeader('accept', 'application/json');                                                                                                   
    // setting decision to false will trigger decision.case.two     
    const reqEvent1 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result1 = await po.request(reqEvent1);
    expect(result1.getStatus()).toBe(200);
    expect(result1.getBody() instanceof Object);
    const map = new MultiLevelMap(result1.getBody() as object);
    expect(map.getElement("from")).toBe("two");
    expect(map.getElement("decision")).toBe(false);
    // try it again with a different decision
    const req2 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/decision')
                                        .setQueryParameter('decision', "true")
                                        .setHeader('accept', 'application/json');   
    const reqEvent2 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req2.toMap());
    const result2 = await po.request(reqEvent2);
    expect(result2.getStatus()).toBe(200);
    expect(result2.getBody() instanceof Object);
    const map2 = new MultiLevelMap(result2.getBody() as object);
    expect(map2.getElement("from")).toBe("one");
    expect(map2.getElement("decision")).toBe(true);
  });

  it('can make decision using no-op', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/noop/decision')
                                        .setQueryParameter('decision', 'something-else')
                                        .setHeader('accept', 'application/json'); 
    // when decision not equals to 'hello', it will be turned to false to trigger decision.case.two                                                            
    const reqEvent1 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result1 = await po.request(reqEvent1);
    expect(result1.getStatus()).toBe(200);
    expect(result1.getBody() instanceof Object);
    const map = new MultiLevelMap(result1.getBody() as object);
    expect(map.getElement("from")).toBe("two");
    expect(map.getElement("decision")).toBe(false);
    // setting decision to true will trigger decision.case.one
    // "hello" is mapped to true in decision-with-no-op.yml
    const req2 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/noop/decision')
                                        .setQueryParameter('decision', 'hello')
                                        .setHeader('accept', 'application/json');   
    const reqEvent2 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req2.toMap());
    const result2 = await po.request(reqEvent2);
    expect(result2.getStatus()).toBe(200);
    expect(result2.getBody() instanceof Object);
    const map2 = new MultiLevelMap(result2.getBody() as object);
    expect(map2.getElement("from")).toBe("one");
    expect(map2.getElement("decision")).toBe(true);
  });  

  it('can make decision using a number', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/numeric-decision')
                                        .setQueryParameter('decision', '3')
                                        .setHeader('accept', 'application/json'); 
    // numeric decision of 2 refers to the second item in the "next tasks"
    // the task index starts from 1                                                    
    const reqEvent1 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result1 = await po.request(reqEvent1);
    expect(result1.getStatus()).toBe(200);
    expect(result1.getBody() instanceof Object);
    const map = new MultiLevelMap(result1.getBody() as object);
    expect(map.getElement("from")).toBe("three");
    expect(map.getElement("decision")).toBe(3);
    // numeric decision of 1 refers to the first item in the "next tasks"
    const req2 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/numeric-decision')
                                        .setQueryParameter('decision', '1')
                                        .setHeader('accept', 'application/json');   
    const reqEvent2 = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req2.toMap());
    const result2 = await po.request(reqEvent2);
    expect(result2.getStatus()).toBe(200);
    expect(result2.getBody() instanceof Object);
    const map2 = new MultiLevelMap(result2.getBody() as object);
    expect(map2.getElement("from")).toBe("one");
    expect(map2.getElement("decision")).toBe(1);
  }); 

  it('will reject invalid decision value', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/numeric-decision')
                                        .setQueryParameter('decision', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(500);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("message")).toBe("Task numeric.decision returned invalid decision (100)");
    expect(map.getElement("status")).toBe(500);
    expect(map.getElement("type")).toBe("error");
  }); 

  it('can do sequential tasks', async () => {
    const po = new PostOffice();
    const req = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/sequential/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(map.getElement("pojo.sequence")).toBe(100);
    expect(map.getElement("pojo.user")).toBe('test-user');
  }); 
  
  it('can run response task', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/response/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    // This is the result from the "response" task and not the "end" task
    // where the end task return content type as "text/plain".
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("sequence")).toBe(100);
    expect(map.getElement("user")).toBe('test-user');
  }); 
  
  it('can do a delayed response task', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/delayed-response/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("sequence")).toBe(100);
    expect(map.getElement("user")).toBe('test-user');
  }); 

  it('can do fork-n-join', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/fork-n-join/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("sequence")).toBe(100);
    expect(map.getElement("user")).toBe('test-user');
    expect(map.getElement("key1")).toBe("hello-world-one");
    expect(map.getElement("key2")).toBe("hello-world-two");
  });

  it('can do fork-n-join-flows', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/fork-n-join-flows/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("sequence")).toBe(100);
    expect(map.getElement("user")).toBe('test-user');
    expect(map.getElement("key1")).toBe("hello-world-one");
    expect(map.getElement("key2")).toBe("hello-world-two");
  });  

  it('can do fork-n-join with exception', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/fork-n-join/test-user')
                                        .setQueryParameter('seq', '100').setQueryParameter('exception', '401')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(401);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("message")).toBe('Simulated Exception');
    expect(map.getElement("type")).toBe("error");
    expect(map.getElement("status")).toBe(401);
  });  

  it('can do fork-n-join-flows with exception', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/fork-n-join-flows/test-user')
                                        .setQueryParameter('seq', '100').setQueryParameter('exception', '401')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(401);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("message")).toBe('Simulated Exception');
    expect(map.getElement("type")).toBe("error");
    expect(map.getElement("status")).toBe(401);
  });  
  
  it('can do pipeline tasks', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/pipeline/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
  });    

  it('can do for-loop in pipeline', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/for-loop/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // the iterationCount will be incremented by "my.mock.function"                                    
    iterationCount = 0;
    var mock = new EventScriptMock("for-loop-test");
    var previousRoute = mock.getFunctionRoute('echo.one');
    var currentRoute = mock.assignFunctionRoute('echo.one', 'my.mock.function').getFunctionRoute('echo.one');
    expect(previousRoute).toBe('no.op');
    expect(currentRoute).toBe('my.mock.function');
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(3);
    expect(iterationCount).toBe(3);
  });

  it('can do for-loop with single task in pipeline', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/for-loop-single/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // the iterationCount will be incremented by "my.mock.function"                                    
    iterationCount = 0;
    var mock = new EventScriptMock("for-loop-test-single-task");
    var previousRoute = mock.getFunctionRoute('item.picker');
    var currentRoute = mock.assignFunctionRoute('item.picker', 'my.mock.function').getFunctionRoute('item.picker');
    expect(previousRoute).toBe('no.op');
    expect(currentRoute).toBe('my.mock.function');
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(3);
    expect(iterationCount).toBe(3);
    expect(map.getElement("items")).toEqual(['a', 'b', 'c', 'item3']);
    expect(map.getElement("latest[0]")).toBe('x');
    expect(map.getElement("latest[1]")).toBe('y');
    expect(map.getElement("latest[2]")).toBe('z');
    expect(map.getElement("latest[3].item")).toBe('item3');
  });
  
  it('can do for-loop with break in pipeline - case 1', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/for-loop-break/test-user')
                                        .setQueryParameter('seq', '100').setQueryParameter('break', '2')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(2);
  });

  it('can do for-loop with break in pipeline - case 2', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/for-loop-break/test-user')
                                        .setQueryParameter('seq', '100').setQueryParameter('jump', '2')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(2);
  });

  it('can do for-loop with break in pipeline that has a single task - case 3', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/for-loop-break-single/test-user')
                                        .setQueryParameter('seq', '100').setQueryParameter('none', '2')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(0);
  });

  it('can do for-loop with continue in pipeline', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/for-loop-continue/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(4);
  });
  
  it('can handle pipeline exception', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/pipeline-exception/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(400);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("status")).toBe(400);
    expect(map.getElement("message")).toBe('just a test');
  });
  
  it('can do while-loop in pipeline', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/while-loop/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(3);
  });  

  it('can do while-loop with break in pipeline', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/while-loop-break/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(2);
  });   
  
  it('can do while-loop with continue in pipeline', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/while-loop-continue/test-user')
                                        .setQueryParameter('seq', '100')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    const map = new MultiLevelMap(result.getBody() as object);
    expect(result.getHeader('content-type')).toBe('application/json');
    expect(map.getElement("data.sequence")).toBe(100);
    expect(map.getElement("data.user")).toBe('test-user');
    expect(map.getElement("n")).toBe(3);
  });   
  
  it('can do parallel tasks', async () => {
    const po = new PostOffice();
    const req1 = new AsyncHttpRequest().setMethod('GET').setTargetHost(baseUrl).setUrl('/api/parallel')
                                        .setHeader('accept', 'application/json'); 
    // Since there are only 3 items in the next tasks, a decision value of 100 is invalid                                                 
    const reqEvent = new EventEnvelope().setTo(ASYNC_HTTP_CLIENT).setBody(req1.toMap());
    const result = await po.request(reqEvent);
    expect(result.getStatus()).toBe(200);
    expect(result.getBody() instanceof Object);
    expect(result.getBody()).toEqual({'key1': 'hello-world-one', 'key2': 'hello-world-two'});
  });  
  
  it('can launch internal flow', async () => {    
    const po = new PostOffice();
    const flowId = 'header-test';
    const headers = {};
    headers["user-agent"] = "internal-flow";
    headers["accept"] = "application/json";
    headers["x-flow-id"] = flowId;
    const dataset = {};
    dataset['header'] = headers;
    dataset["body"] = {"hello": "world"};
    const executor = FlowExecutor.getInstance();
    const response = await executor.request(po, flowId, dataset, util.getUuid(), 5000);
    expect(response.getStatus()).toBe(200);
    expect(response.getBody() instanceof Object);
    const result = response.getBody() as object;
    expect(result).toEqual(headers);    
  }); 
  
  it('will throw exception with incorrect mock', async () => {
    const empty = '';
    const noSuchFlow = 'no-such-flow';
    const noSuchTask = 'no-such-task';
    expect(() => {
      new EventScriptMock(noSuchFlow);
    }).toThrow(`Flow ${noSuchFlow} does not exist`);
    expect(() => {      
      new EventScriptMock(empty);
    }).toThrow('Missing flow ID');
    expect(() => {
      const mock = new EventScriptMock('parallel-test');
      mock.getFunctionRoute(noSuchTask);
    }).toThrow(`Task ${noSuchTask} does not exist`);
    expect(() => {
      const mock = new EventScriptMock('parallel-test');
      mock.getFunctionRoute(empty);
    }).toThrow('Missing task name');
    expect(() => {
      const mock = new EventScriptMock('parallel-test');
      mock.assignFunctionRoute('echo.one', '');
    }).toThrow('Missing mock function route');
    expect(() => {
      const mock = new EventScriptMock('parallel-test');
      mock.assignFunctionRoute('', 'my.mock.function');
    }).toThrow('Missing task name');
    expect(() => {
      const mock = new EventScriptMock('parallel-test');
      mock.assignFunctionRoute(noSuchTask, 'my.mock.function');
    }).toThrow(`Task ${noSuchTask} does not exist`);
  });    

}); 