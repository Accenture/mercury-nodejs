/**
 * Demo polyglot functions.
 *
 * Run:  node dist/src/cli.js examples/demo-app.mjs --port 8087
 *
 * Then map a route from a Mercury engine application (event-over-http.yaml):
 *
 *   event.http:
 *     - route: 'hello.node'
 *       target: 'http://127.0.0.1:8087/api/event'
 */
import { AppException, annotateTrace, getLogger, preload } from '../dist/src/index.js';

const log = getLogger('demo-app');

preload('hello.node', { instances: 10 }, async (headers, body) => {
  if (typeof body !== 'object' || body === null || !('text' in body)) {
    throw new AppException(400, "missing 'text'");
  }
  annotateTrace('language', 'node.js');
  log.info(`Transforming text of length ${String(body.text).length}`);
  return { text: String(body.text).toUpperCase(), language: 'node.js' };
});

preload('hello.declarative', { instances: 10 }, async (headers, body) => {
  return { body, headers, language: 'node.js' };
});
