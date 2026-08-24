/**
 * Demo polyglot functions.
 *
 * Run:  node dist/src/cli.js examples/demo-app.mjs
 *
 * Configuration comes from examples/resources/application.yml (the engines'
 * "resources" convention - port 8087, the demo.health dependency, log format);
 * override any key with -Dkey=value, e.g. -Drest.server.port=8090.
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
  if (typeof body !== 'object' || body === null
      || !('text' in body) || typeof body.text !== 'string') {
    throw new AppException(400, "missing 'text'");
  }
  annotateTrace('language', 'node.js');
  log.info(`Transforming text of length ${body.text.length}`);
  return { text: body.text.toUpperCase(), language: 'node.js' };
});

preload('hello.declarative', { instances: 10 }, async (headers, body) => {
  return { body, headers, language: 'node.js' };
});

// Private helper - callable in-app only (the HTTP host answers 403 for it).
preload('demo.suffix.helper', { instances: 10, isPrivate: true }, async (_headers, body) => {
  const text = typeof body?.text === 'string' ? body.text : '';
  return { text: `${text}!`, language: 'node.js' };
});

// Local composition: a public function calls a private sibling through the bus.
preload('hello.chain', { instances: 10 }, async (_headers, body) => {
  const { PostOffice } = await import('../dist/src/index.js');
  const reply = await new PostOffice().request('demo.suffix.helper', body, { timeoutMs: 5000 });
  return reply.body;
});

// Health check speaking the engines' interface contract (type=info / type=health).
// Activated for the /health actuator endpoint by mandatory.health.dependencies
// in examples/resources/application.yml (or a -D override).
preload('demo.health', { instances: 5, isPrivate: true }, async (headers, _body) => {
  if (headers.type === 'info') {
    return { service: 'demo.service', href: 'http://127.0.0.1' };
  }
  return 'demo.service is running fine';
});
