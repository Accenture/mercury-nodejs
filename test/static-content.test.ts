/**
 * Static content pins: the engines' static.html.folder, served by the host for the paths nothing
 * else claims - the folder's index.html at /, the types, the ETag, what is never found, and what
 * wins over a file.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { AppConfig, appConfig, loadConfig } from '../src/config.js';
import { FunctionRegistry } from '../src/registry.js';
import { EventApiServer, RouteMounter } from '../src/server.js';
import { contentType, OCTET_STREAM, resolveFolder, StaticContent } from '../src/static-content.js';

const NOT_FOUND = { status: 404, message: 'Resource not found', type: 'error' };

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A web bundle the way a build deploys one, plus the entries that must never be served. */
function bundle(publicDir: string, outside: string): void {
  write(path.join(publicDir, 'index.html'), '<h1>bundle</h1>');
  write(path.join(publicDir, 'app.js'), "console.log('bundle')");
  write(path.join(publicDir, 'style.css'), 'body { margin: 0 }');
  write(path.join(publicDir, 'assets', 'logo.svg'), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  write(path.join(publicDir, 'sub', 'index.html'), '<h1>sub</h1>');
  write(path.join(publicDir, 'plain', 'readme.txt'), 'a folder without an index page');
  write(path.join(publicDir, '.secret'), 'hidden');
  write(path.join(publicDir, 'info'), "a file named like the actuator's path");
  write(path.join(publicDir, 'hello'), "a file named like an extension's route");
  write(outside, 'outside the folder');
  fs.symlinkSync(outside, path.join(publicDir, 'link.txt'));
}

interface Served { base: string; stop: () => Promise<void> }

// the host resolves the folder from the shared configuration at construction, so each test loads
// the configuration BEFORE calling start()
async function start(registry: FunctionRegistry, routes: RouteMounter[] = []): Promise<Served> {
  const server = new EventApiServer(registry).createServer(routes);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve) => {
      registry.bus.close();
      server.close(() => resolve());
    })
  };
}

interface Raw { status: number; headers: http.IncomingHttpHeaders; body: string }

/** A request as written - fetch would normalize the dot segments before they reach the server. */
function raw(base: string, requestPath: string, method = 'GET', headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({ host: url.hostname, port: url.port, path: requestPath, method, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString()
        }));
      });
    request.on('error', reject);
    request.end();
  });
}

let root: string;
let appDir: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-static-'));
  appDir = path.join(root, 'app');
  bundle(path.join(appDir, 'resources', 'public'), path.join(root, 'outside.txt'));
});

after(() => {
  loadConfig(); // a fresh default configuration for the other modules
  fs.rmSync(root, { recursive: true, force: true });
});

// --- the table and the folder ---------------------------------------------------------------

test('the content type follows the engines table', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('app.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('bundle.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('style.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('logo.svg'), 'image/svg+xml');
  assert.equal(contentType('favicon.ico'), 'image/vnd.microsoft.icon');
  assert.equal(contentType('font.woff2'), 'font/woff2');
  assert.equal(contentType('app.js.map'), 'application/json; charset=utf-8');
  // the engine's rule: no dot, a trailing dot or an unknown extension is an octet stream
  assert.equal(contentType('README'), OCTET_STREAM);
  assert.equal(contentType('trailing.'), OCTET_STREAM);
  assert.equal(contentType('archive.tgz'), OCTET_STREAM);
});

test('the folder is resolved under the application file', () => {
  const config = new AppConfig(undefined, [], root);
  assert.equal(resolveFolder(config), path.join(root, 'resources', 'public'));
  config.set('static.html.folder', 'web/site');
  assert.equal(resolveFolder(config), path.join(root, 'web', 'site'));
  config.set('static.html.folder', `file:${path.join(root, 'absolute')}`);
  assert.equal(resolveFolder(config), path.join(root, 'absolute'));
  config.set('static.html.folder', path.join(root, 'elsewhere') + '/');
  assert.equal(resolveFolder(config), path.join(root, 'elsewhere'));
  // a classpath has no meaning in a pack - the default stands
  config.set('static.html.folder', 'classpath:/public');
  assert.equal(resolveFolder(config), path.join(root, 'resources', 'public'));
  // an empty value turns the service off
  config.set('static.html.folder', '');
  assert.equal(resolveFolder(config), undefined);
});

test('a missing folder serves nothing', async () => {
  assert.equal(new StaticContent(path.join(root, 'absent')).enabled, false);
  assert.equal(new StaticContent(undefined).enabled, false);
  assert.equal(await new StaticContent(undefined).locate('/index.html'), undefined);
});

// --- through the host -----------------------------------------------------------------------

test("the folder's index page replaces the landing page", async () => {
  loadConfig(undefined, appDir);
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<h1>bundle</h1>');
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.ok(page.headers.get('etag'));
    // HEAD: the same headers, no body
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await head.text(), '');
  } finally {
    await stop();
  }
});

test('a file is served with its type and an etag', async () => {
  loadConfig(undefined, appDir);
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 200);
    assert.equal(await script.text(), "console.log('bundle')");
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(script.headers.get('cache-control'), null); // a browser revalidates by the ETag
    const etag = script.headers.get('etag') ?? '';
    assert.ok(etag);
    const again = await fetch(`${base}/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    const style = await fetch(`${base}/style.css`);
    assert.equal(style.headers.get('content-type'), 'text/css; charset=utf-8');
    const logo = await fetch(`${base}/assets/logo.svg`);
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
  } finally {
    await stop();
  }
});

test('a folder serves its index page', async () => {
  loadConfig(undefined, appDir);
  const { base, stop } = await start(new FunctionRegistry());
  try {
    for (const requestPath of ['/sub', '/sub/']) {
      const page = await fetch(`${base}${requestPath}`);
      assert.equal(page.status, 200, requestPath);
      assert.equal(await page.text(), '<h1>sub</h1>', requestPath);
    }
    // a folder without one is not found, in the engines' error shape
    const plain = await fetch(`${base}/plain`);
    assert.equal(plain.status, 404);
    assert.deepEqual(await plain.json(), NOT_FOUND);
  } finally {
    await stop();
  }
});

test('what is never found', async () => {
  loadConfig(undefined, appDir);
  const { base, stop } = await start(new FunctionRegistry());
  try {
    for (const requestPath of [
      '/missing.js',                        // no such file
      '/.secret',                           // a hidden entry
      '/link.txt',                          // a symbolic link out of the folder
      '/%2e%2e/outside.txt',                // a traversal, percent-encoded
      '/sub/..%2F..%2Foutside.txt',         // a traversal with encoded separators
      '/assets/',                           // a folder without an index page
      '/assets'                             // never listed
    ]) {
      const response = await raw(base, requestPath);
      assert.equal(response.status, 404, requestPath);
      assert.deepEqual(JSON.parse(response.body), NOT_FOUND, requestPath);
    }
    // another method is not a file request
    const post = await raw(base, '/app.js', 'POST');
    assert.equal(post.status, 404);
    assert.deepEqual(JSON.parse(post.body), NOT_FOUND);
  } finally {
    await stop();
  }
});

test("the host's paths and an extension's routes win over a file", async () => {
  loadConfig(undefined, appDir);
  const mount: RouteMounter = async (_req, res, url) => {
    if (url.pathname !== '/hello') {
      return false;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('the route');
    return true;
  };
  const { base, stop } = await start(new FunctionRegistry(), [mount]);
  try {
    const info = await fetch(`${base}/info`);
    assert.equal(info.status, 200);
    assert.ok('app' in (await info.json() as Record<string, unknown>)); // the actuator, not public/info
    const hello = await fetch(`${base}/hello`);
    assert.equal(hello.status, 200);
    assert.equal(await hello.text(), 'the route'); // the extension, not public/hello
  } finally {
    await stop();
  }
});

test('the key names another folder', async () => {
  const elsewhere = path.join(root, 'elsewhere');
  write(path.join(elsewhere, 'index.html'), '<h1>elsewhere</h1>');
  loadConfig(undefined, appDir);
  appConfig().set('static.html.folder', elsewhere);
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<h1>elsewhere</h1>');
  } finally {
    await stop();
  }
});

test('without a folder the landing page stays', async () => {
  loadConfig(undefined, path.join(root, 'bare')); // no resources/public
  const { base, stop } = await start(new FunctionRegistry());
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.ok((page.headers.get('content-type') ?? '').startsWith('text/html'));
    assert.ok((await page.text()).includes('INFO endpoint'));
    const script = await fetch(`${base}/app.js`);
    assert.equal(script.status, 404);
    assert.deepEqual(await script.json(), NOT_FOUND);
  } finally {
    await stop();
  }
});
