/**
 * The built-in agent tools (extensions/agent-tools/agent-tools.mjs).
 *
 * The file tools against a workspace built in a temporary directory (a symbolic link that escapes
 * it, hidden entries, a binary, a file that is not UTF-8, a large file); the in-house HTML reader on
 * a fixture page; the web sandbox's allowlist and address rules without a network; the web tools
 * against a fixture site served in-process (pages that link each other, robots.txt, redirects to
 * allowed, private and foreign hosts, a slow page, a large body, charsets); the graph tools over a
 * fake backend that scripts the rows and the pure half on the driver's own classes; file.extract on
 * a PDF generated in the test and a Word fixture; the clock; the boot that registers only the tools
 * whose sandbox is configured and fails by name on a bad one; the health route; the describe
 * output; and the catalog files, which must equal the rows the module publishes byte for byte -
 * the Python twin carries the same files. The live graph test runs when TOOLS_GRAPH_TEST_URI is set.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import { AppException, appConfig, FunctionRegistry, Platform, PostOffice } from 'mercury-composable';
import * as tools from '../extensions/agent-tools/agent-tools.mjs';

const ROUTES = ['file.read', 'file.write', 'file.list', 'file.search', 'file.extract', 'web.fetch', 'web.crawl',
  'graph.schema', 'graph.query', 'graph.write', 'graph.ingest', 'time.now'];
const STEP_ONE_ROUTES = ROUTES.filter((r) => !r.startsWith('graph.'));
const WRITERS = new Set(['file_write', 'graph_write', 'graph_ingest']);
// the loop's closed schema subset (ToolSchema in the engines' agent loop), as the rows may use it
const SCHEMA_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum',
  'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'title',
  'description', 'default', 'examples', 'format']);

// --- helpers -------------------------------------------------------------------------------------

/** A logger that keeps what it is told, so a test can assert what never reached a log. */
function ledger() {
  const lines = [];
  const keep = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, text: () => lines.join('\n'), debug: keep('DEBUG'), info: keep('INFO'), warn: keep('WARN'), error: keep('ERROR') };
}

const touched = new Set();
function configure(settings) {
  for (const [key, value] of Object.entries(settings)) {
    appConfig().set(key, value);
    touched.add(key);
  }
}
function resetConfig() {
  for (const key of touched) appConfig().set(key, undefined);
  touched.clear();
}

/** The status and message of a refusal. */
async function refusal(promise) {
  try {
    await promise;
  } catch (e) {
    if (e instanceof AppException) return { status: e.status, message: e.message };
    throw e;
  }
  throw new assert.AssertionError({ message: 'expected a refusal' });
}
function refusalSync(fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppException) return { status: e.status, message: e.message };
    throw e;
  }
  throw new assert.AssertionError({ message: 'expected a refusal' });
}
function includes(text, part) {
  assert.ok(text.includes(part), `expected ${JSON.stringify(text)} to include ${JSON.stringify(part)}`);
}

// --- the workspace -------------------------------------------------------------------------------

function workspace() {
  const base = mkdtempSync(join(tmpdir(), 'agent-tools-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  for (const folder of ['notes', 'src', 'data', 'empty', '.secrets']) mkdirSync(join(root, folder), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside the workspace\n');
  writeFileSync(join(root, 'notes', 'plan.md'), '# Plan\n\nWrite the tools.\n');
  writeFileSync(join(root, 'src', 'app.py'), "def main():\n    print('hello')\n\n\ndef helper():\n    pass\n");
  writeFileSync(join(root, 'src', 'util.py'), '# TODO: tidy\nvalue = 1\n# todo: later\nTODO_COUNT = 2\n');
  writeFileSync(join(root, 'data', 'blob.bin'), Buffer.from([0, 1, 2, ...Buffer.from(' not text')]));
  writeFileSync(join(root, 'data', 'image.png'), Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(16)]));
  writeFileSync(join(root, 'data', 'latin.txt'), Buffer.from('caf\xe9\n', 'latin1'));
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(300 * 1024));
  writeFileSync(join(root, '.secrets', 'token.txt'), 'hidden\n');
  writeFileSync(join(root, '.env'), 'KEY=value\n');
  symlinkSync(outside, join(root, 'escape'));
  symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file'));
  return root;
}

let documents;
before(async () => {
  documents = await tools.loadDocuments();
  assert.ok(documents, 'the documents libraries are dev dependencies of this repo');
});
after(resetConfig);

async function fileTools(root, settings = {}) {
  resetConfig();
  configure({ [tools.FILE_ROOT]: root, ...settings });
  const log = ledger();
  return { files: tools.createFileTools(await tools.loadFileSandbox({ log }), { log, documents }), log };
}

test('file.read reads a text file and names the workspace-relative path', async () => {
  const { files } = await fileTools(workspace());
  assert.deepEqual(await files.read({}, { path: 'notes/plan.md' }),
    { path: 'notes/plan.md', bytes: 25, text: '# Plan\n\nWrite the tools.\n', truncated: false });
  assert.equal((await files.read({}, { path: 'src/../notes/plan.md' })).path, 'notes/plan.md');
});

test('file.read cuts at max_bytes and the workspace limit', async () => {
  const { files } = await fileTools(workspace(), { [tools.FILE_MAX_BYTES]: '4096' });
  const reply = await files.read({}, { path: 'big.txt', max_bytes: 1000 });
  assert.deepEqual([reply.text.length, reply.bytes, reply.truncated], [1000, 300 * 1024, true]);
  assert.equal((await files.read({}, { path: 'big.txt', max_bytes: 1_000_000 })).text.length, 4096, 'capped by the workspace limit');
  assert.equal((await files.read({}, { path: 'big.txt' })).text.length, 4096);
  assert.equal((await files.read({}, { path: 'notes/plan.md' })).truncated, false);
});

test('file.read refuses by rule', async () => {
  const { files } = await fileTools(workspace());
  for (const [path, status, message] of [
    ['../outside/secret.txt', 400, 'outside the workspace'],
    ['/etc/hosts', 400, 'not absolute'],
    ['C:\\windows\\win.ini', 400, 'not absolute'],
    ['escape/secret.txt', 400, 'outside the workspace'],
    ['escape-file', 400, 'outside the workspace'],
    ['.secrets/token.txt', 400, 'hidden'],
    ['.env', 400, 'hidden'],
    ['nope.txt', 404, 'file not found: nope.txt'],
    ['notes', 400, 'is a directory'],
    ['data/image.png', 400, 'a PNG image'],
    ['data/blob.bin', 400, '(binary)'],
    ['data/latin.txt', 400, 'not UTF-8 text']
  ]) {
    const got = await refusal(files.read({}, { path }));
    assert.equal(got.status, status, path);
    includes(got.message, message);
  }
});

test('hidden entries are available when the workspace exposes them', async () => {
  const { files } = await fileTools(workspace(), { [tools.FILE_HIDDEN]: true });
  assert.equal((await files.read({}, { path: '.env' })).text, 'KEY=value\n');
  const listed = (await files.list({}, {})).entries.map((e) => e.path);
  assert.ok(listed.includes('.env') && listed.includes('.secrets'));
});

test('arguments are checked against the row', async () => {
  const { files } = await fileTools(workspace());
  for (const [body, message] of [
    ['notes/plan.md', 'must be a map'],
    [{}, 'path is required'],
    [{ path: 3 }, 'path must be a string'],
    [{ path: 'notes/plan.md', max_bytes: '10' }, 'max_bytes must be an integer'],
    [{ path: 'notes/plan.md', max_bytes: true }, 'max_bytes must be an integer'],
    [{ path: 'notes/plan.md', max_bytes: 0 }, 'max_bytes must be at least 1'],
    [{ path: 'notes/plan.md', encoding: 'latin-1' }, 'file_read does not take encoding']
  ]) {
    const got = await refusal(files.read({}, body));
    assert.equal(got.status, 400);
    includes(got.message, message);
  }
});

test('file.write creates, refuses an existing file, overwrites and appends', async () => {
  const root = workspace();
  const { files } = await fileTools(root);
  assert.deepEqual(await files.write({}, { path: 'out/reports/summary.md', content: '# Summary\n' }),
    { path: 'out/reports/summary.md', bytes: 10, mode: 'create' });
  assert.equal(readFileSync(join(root, 'out', 'reports', 'summary.md'), 'utf8'), '# Summary\n');
  const again = await refusal(files.write({}, { path: 'out/reports/summary.md', content: 'again' }));
  assert.equal(again.status, 409);
  includes(again.message, 'exists');
  assert.equal((await files.write({}, { path: 'out/reports/summary.md', content: 'new', mode: 'overwrite' })).mode, 'overwrite');
  assert.equal((await files.write({}, { path: 'out/reports/summary.md', content: ' more', mode: 'append' })).bytes, 5);
  assert.equal(readFileSync(join(root, 'out', 'reports', 'summary.md'), 'utf8'), 'new more');
  assert.equal((await files.write({}, { path: 'out/café.txt', content: 'café' })).bytes, 5, 'UTF-8 bytes');
});

test('file.write refuses by rule', async () => {
  const { files } = await fileTools(workspace());
  for (const [body, status, message] of [
    [{ path: '../x.txt', content: 'a' }, 400, 'outside the workspace'],
    [{ path: '/tmp/x.txt', content: 'a' }, 400, 'not absolute'],
    [{ path: '.hidden/x.txt', content: 'a' }, 400, 'hidden'],
    [{ path: 'escape/x.txt', content: 'a' }, 400, 'outside the workspace'],
    [{ path: 'notes', content: 'a' }, 400, 'is a directory'],
    [{ path: '.', content: 'a' }, 400, 'is a directory'],
    [{ path: 'x.txt', content: 1 }, 400, 'content must be a string'],
    [{ path: 'x.txt' }, 400, 'content is required'],
    [{ path: 'x.txt', content: 'a', mode: 'replace' }, 400, 'mode must be one of create, overwrite, append']
  ]) {
    const got = await refusal(files.write({}, body));
    assert.equal(got.status, status, JSON.stringify(body));
    includes(got.message, message);
  }
});

test('file.write respects the extension list and the size limit', async () => {
  const { files } = await fileTools(workspace(), { [tools.FILE_WRITE_EXTENSIONS]: '.md, txt', [tools.FILE_MAX_BYTES]: 1024 });
  assert.equal((await files.write({}, { path: 'out/a.txt', content: 'ok' })).bytes, 2);
  assert.equal((await files.write({}, { path: 'out/A.MD', content: 'ok' })).bytes, 2);
  const suffix = await refusal(files.write({}, { path: 'out/a.py', content: 'x' }));
  assert.equal(suffix.status, 400);
  includes(suffix.message, 'does not end in .md, .txt');
  const size = await refusal(files.write({}, { path: 'out/b.txt', content: 'x'.repeat(1025) }));
  includes(size.message, "over the workspace's limit of 1024");
});

test('file.list lists the root and a folder', async () => {
  const { files } = await fileTools(workspace());
  const reply = await files.list({}, {});
  assert.equal(reply.truncated, false);
  assert.deepEqual(reply.entries.map((e) => [e.path, e.type]),
    [['big.txt', 'file'], ['data', 'directory'], ['empty', 'directory'], ['notes', 'directory'], ['src', 'directory']],
    'hidden entries and links that escape the workspace are not listed');
  assert.equal(reply.entries[0].bytes, 300 * 1024);
  assert.match(reply.entries[0].modified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual((await files.list({}, { path: 'src' })).entries.map((e) => e.path), ['src/app.py', 'src/util.py']);
  assert.deepEqual(await files.list({}, { path: 'empty' }), { entries: [], truncated: false });
});

test('file.list with a glob and a cap', async () => {
  const { files } = await fileTools(workspace());
  assert.deepEqual((await files.list({}, { glob: '**/*.py' })).entries.map((e) => e.path), ['src/app.py', 'src/util.py']);
  assert.deepEqual((await files.list({}, { path: 'src', glob: '*.py' })).entries.map((e) => e.path), ['src/app.py', 'src/util.py']);
  const cut = await files.list({}, { glob: '**/*', max_entries: 2 });
  assert.equal(cut.entries.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal((await refusal(files.list({}, { glob: '/abs/*' }))).status, 400);
  assert.deepEqual(await refusal(files.list({}, { path: 'notes/plan.md' })), { status: 400, message: 'notes/plan.md is not a directory' });
  assert.deepEqual(await refusal(files.list({}, { path: 'nowhere' })), { status: 404, message: 'directory not found: nowhere' });
  assert.equal((await files.list({}, { max_entries: 5000 })).truncated, false, 'over the cap is capped, not refused');
});

test('file.search finds literals and regular expressions with context', async () => {
  const { files } = await fileTools(workspace());
  const reply = await files.search({}, { pattern: 'todo' });
  assert.equal(reply.files_searched, 5, 'text files only - the binaries are skipped');
  assert.equal(reply.truncated, false);
  assert.deepEqual(reply.matches.map((m) => [m.path, m.line, m.text]),
    [['src/util.py', 1, '# TODO: tidy'], ['src/util.py', 3, '# todo: later'], ['src/util.py', 4, 'TODO_COUNT = 2']]);
  assert.deepEqual((await files.search({}, { pattern: 'TODO', case_sensitive: true })).matches.map((m) => m.line), [1, 4]);
  assert.deepEqual((await files.search({}, { pattern: 'def \\w+\\(', regex: true })).matches.map((m) => m.line), [1, 5]);
  assert.deepEqual((await files.search({}, { pattern: 'def \\w+\\(' })).matches, [], 'without regex the pattern is literal');
  assert.deepEqual(new Set((await files.search({}, { pattern: 'e', path: 'notes' })).matches.map((m) => m.path)), new Set(['notes/plan.md']));
  assert.deepEqual(new Set((await files.search({}, { pattern: 'e', glob: '**/*.md' })).matches.map((m) => m.path)), new Set(['notes/plan.md']));
  const context = (await files.search({}, { pattern: 'value', context: 1 })).matches[0];
  assert.deepEqual([context.before, context.after], [['# TODO: tidy'], ['# todo: later']]);
  assert.deepEqual((await files.search({}, { pattern: 'value', context: 3 })).matches[0].before, ['# TODO: tidy'], 'context stops at the top');
});

test('file.search caps and refusals', async () => {
  const { files } = await fileTools(workspace(), { [tools.FILE_LINE_MAX_CHARS]: 20 });
  const cut = await files.search({}, { pattern: 'todo', max_results: 2 });
  assert.equal(cut.matches.length, 2);
  assert.equal(cut.truncated, true);
  assert.equal((await files.search({}, { pattern: 'xxxx' })).matches[0].text.length, 20, 'a line is cut to tools.file.line.max.chars');
  const bad = await refusal(files.search({}, { pattern: '(', regex: true }));
  assert.equal(bad.status, 400);
  includes(bad.message, 'not a valid regular expression');
  assert.deepEqual(await refusal(files.search({}, { pattern: '' })), { status: 400, message: 'pattern must not be empty' });
  assert.ok((await files.search({}, { pattern: 'a', context: 9 })).matches.length, 'over the cap is capped, not refused');
  assert.equal((await refusal(files.search({}, { pattern: 'a', path: '../' }))).status, 400);
});

// --- HTML to text --------------------------------------------------------------------------------

const PAGE = `<!DOCTYPE html><html><head><title> Page   Title </title><meta charset="utf-8">
<style>body { color: red }</style><script>var x = "<p>not text</p>";</script></head>
<body><header><a href="/">Site</a></header><nav><ul><li><a href="/menu">Menu</a></li></ul></nav>
<main><h1>Heading &amp; more</h1><p>First paragraph with a <a href="/docs/a#section">link to A</a>,
<code>inline code</code> and caf&eacute;.</p><ul><li>one</li><li>two <ul><li>nested</li></ul></li></ul>
<pre>line 1
  line 2</pre><p>Line<br>break</p><table><tr><th>H1</th><th>H2</th></tr><tr><td>c1</td><td>c2</td></tr></table>
<a href="mailto:x@example.com">mail</a> <a href="#top">top</a> <a href="https://other.example/x">other</a>
<a href="/docs/a">again</a><img src="pic.png" alt="pic"></main><footer>Footer text</footer></body></html>`;

test('html to text drops chrome and keeps the readable text', () => {
  const { title, text, links } = tools.htmlToText(PAGE, 'https://site.example/docs/index.html');
  assert.equal(title, 'Page Title');
  const blocks = text.split('\n\n');
  assert.equal(blocks[0], 'Heading & more');
  assert.equal(blocks[1], 'First paragraph with a link to A, inline code and café.');
  assert.deepEqual(blocks.slice(2, 5), ['- one', '- two', '  - nested']);
  assert.equal(blocks[5], 'line 1\n  line 2');
  assert.equal(blocks[6], 'Line break');
  includes(blocks[7], 'H1 H2');
  includes(blocks[8], 'c1 c2');
  for (const dropped of ['Menu', 'Site', 'Footer text', 'color: red', 'not text']) assert.ok(!text.includes(dropped), dropped);
  assert.deepEqual(links, ['https://site.example/docs/a', 'https://other.example/x']);
});

test('html to markdown keeps headings, lists, links and code', () => {
  const { text } = tools.htmlToText(PAGE, 'https://site.example/', { markdown: true });
  const blocks = text.split('\n\n');
  assert.equal(blocks[0], '# Heading & more');
  assert.equal(blocks[1], 'First paragraph with a [link to A](https://site.example/docs/a#section), `inline code` and café.');
  assert.deepEqual(blocks.slice(2, 5), ['- one', '- two', '  - nested']);
  assert.equal(blocks[5], '```\nline 1\n  line 2\n```');
  includes(text, '[other](https://other.example/x)');
});

test('html to text drops chrome marked by role or aria-hidden and survives broken markup', () => {
  const page = '<body><div role="navigation"><h3>Navigation</h3><ul><li><a href="/i">index</a></li></ul></div>'
    + '<div role="banner">Banner</div><span aria-hidden="true">hidden icon</span>'
    + '<div class="body"><h1>Topic</h1><p>Real <img src="x.png" alt="x"> text.</p></div>'
    + '<div role="contentinfo">Copyright</div><div role="main">Kept</div></body>';
  const chrome = tools.htmlToText(page, 'https://h/');
  assert.equal(chrome.text, 'Topic\n\nReal text.\n\nKept');
  assert.deepEqual(chrome.links, []);
  const broken = tools.htmlToText("<p>unclosed <b>bold <a href='x'>link</p><div>next</div></span>", 'https://h/');
  assert.equal(broken.title, '');
  assert.equal(broken.text, 'unclosed bold link\n\nnext');
  assert.deepEqual(broken.links, ['https://h/x']);
  assert.equal(tools.htmlToText('', '').text, '');
  assert.equal(tools.decodeEntities('a &lt; b &amp; &#169; &#x2014; &unknown; &nbsp;x'), 'a < b & © — &unknown; \u00a0x');
});

// --- the web sandbox without a network -----------------------------------------------------------

test('host rules are parsed with scheme and port', () => {
  const rules = tools.parseHostRules(['docs.example.com', '*.example.org', 'http://127.0.0.1', 'host:8443', 'http://[::1]:8080', 'HTTPS://Upper.Example.Com.']);
  assert.deepEqual(rules.map((r) => [r.pattern, r.scheme, r.port]), [
    ['docs.example.com', 'https', undefined], ['*.example.org', 'https', undefined], ['127.0.0.1', 'http', undefined],
    ['host', 'https', 8443], ['::1', 'http', 8080], ['upper.example.com', 'https', undefined]
  ]);
  assert.deepEqual(rules.slice(0, 4).map(tools.ruleText), ['docs.example.com', '*.example.org', 'http://127.0.0.1', 'https://host:8443']);
  for (const [bad, message] of [['https://x/path', 'not a host pattern'], ['ftp://x', 'scheme must be http or https'],
    ['host:abc', 'port must be a number'], ['host:70000', 'between 1 and 65535'], ['user@host', 'not a host pattern']]) {
    assert.throws(() => tools.parseHostRules([bad]), (e) => e instanceof tools.ToolsError && e.message.includes(message));
  }
});

const SANDBOX = new tools.WebSandbox({ rules: tools.parseHostRules(['docs.example.com', '*.example.org', 'http://127.0.0.1', 'host:8443']) });

test('checkUrl allows listed hosts and drops the fragment', () => {
  for (const [url, expect] of [
    ['https://docs.example.com/a/b?x=1#frag', 'https://docs.example.com/a/b?x=1'],
    ['https://DOCS.example.com', 'https://docs.example.com/'],
    ['https://sub.example.org/', 'https://sub.example.org/'],
    ['https://a.b.example.org/', 'https://a.b.example.org/'],
    ['http://127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['https://127.0.0.1/x', 'https://127.0.0.1/x'],
    ['https://host:8443/', 'https://host:8443/']
  ]) {
    assert.equal(SANDBOX.checkUrl(url).url, expect, url);
  }
});

test('checkUrl refuses by rule', () => {
  for (const [url, message] of [
    ['http://docs.example.com/', 'allowed over https only - list it as http://docs.example.com'],
    ['https://evil.example/', 'evil.example is not one of the sites this agent may reach'],
    ['https://example.org/', 'example.org is not one of the sites'],
    ['https://docs.example.com.evil.example/', 'not one of the sites'],
    ['https://user:pw@docs.example.com/', 'must not carry credentials'],
    ['ftp://docs.example.com/', 'must start with https://'],
    ['docs.example.com/page', 'must start with https://'],
    ['https://host:9443/', 'host is not allowed on port 9443']
  ]) {
    const got = refusalSync(() => SANDBOX.checkUrl(url));
    assert.equal(got.status, 400, url);
    includes(got.message, message);
  }
});

test('address kinds', () => {
  for (const [address, kind] of [
    ['127.0.0.1', 'loopback'], ['10.0.0.1', 'private'], ['172.16.5.5', 'private'], ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'], ['224.0.0.1', 'multicast'], ['0.0.0.0', 'unspecified'],
    ['::1', 'loopback'], ['::ffff:10.0.0.1', 'private'], ['fe80::1', 'link-local'], ['fc00::1', 'private'],
    ['93.184.216.34', undefined], ['2606:2800:220:1:248:1893:25c8:1946', undefined]
  ]) {
    assert.equal(tools.addressKind(address), kind, address);
  }
});

test('pin refuses private addresses unless allowed', async () => {
  const lookup = async (host) => (host === 'no-such-host.invalid' ? Promise.reject(new Error('ENOTFOUND')) : [{ address: '127.0.0.1', family: 4 }]);
  const closed = new tools.WebSandbox({ rules: tools.parseHostRules(['http://127.0.0.1', 'http://169.254.169.254', 'localhost']), lookup });
  let got = await refusal(closed.pin('127.0.0.1'));
  assert.equal(got.status, 400);
  includes(got.message, 'loopback address');
  includes(got.message, tools.WEB_ALLOW_PRIVATE);
  got = await refusal(closed.pin('169.254.169.254'));
  includes(got.message, 'link-local address');
  got = await refusal(closed.pin('localhost'));
  includes(got.message, 'localhost resolves to a loopback address');
  const open = new tools.WebSandbox({ rules: closed.rules, allowPrivate: true, lookup });
  assert.deepEqual(await open.pin('127.0.0.1'), { address: '127.0.0.1', family: 4 });
  assert.equal((await open.pin('localhost')).address, '127.0.0.1');
  got = await refusal(open.pin('no-such-host.invalid'));
  assert.equal(got.status, 502);
  includes(got.message, 'cannot be resolved');
});

test('robots.txt rules: the longest match wins, Allow over Disallow on a tie', () => {
  const rules = tools.parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public\n\nUser-agent: Other\nDisallow: /\n');
  assert.equal(rules.canFetch('/docs/a'), true);
  assert.equal(rules.canFetch('/private/secret'), false);
  assert.equal(rules.canFetch('/private/public/page'), true);
  assert.equal(tools.parseRobots('').canFetch('/anything'), true);
  const ours = tools.parseRobots('User-agent: MercuryComposable\nDisallow: /only-us\n\nUser-agent: *\nDisallow: /\n');
  assert.equal(ours.canFetch('/only-us/x'), false);
  assert.equal(ours.canFetch('/docs'), true, 'our own group wins over *');
});

// --- the fixture site ----------------------------------------------------------------------------

const SITE_PAGES = {
  '/': ['Home', '<nav><a href="/menu">Menu</a></nav><h1>Welcome</h1><p>Start <a href="/docs/a">Section A</a> and '
    + '<a href="/docs/b">Section B</a>, <a href="/other">elsewhere</a>, <a href="/private/secret">secret</a>, '
    + '<a href="https://elsewhere.example/x">external</a>, <a href="#top">top</a>, <a href="/docs/a#again">A again</a>.</p>'],
  '/docs/a': ['Section A', '<h1>A</h1><p>Text of A, see <a href="/docs/c">C</a>.</p>'],
  '/docs/b': ['Section B', '<h1>B</h1><p>Text of B, back to <a href="/docs/a">A</a>.</p>'],
  '/docs/c': ['Section C', '<h1>C</h1><p>Text of C.</p>'],
  '/other': ['Other', '<p>Outside the docs.</p>'],
  '/private/secret': ['Secret', '<p>Robots keep out.</p>']
};
const page = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;

let site;
let server;
before(async () => {
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, { 'Content-Type': type, ...headers });
      response.end(body);
    };
    if (SITE_PAGES[url.pathname]) return send(200, 'text/html; charset=utf-8', page(...SITE_PAGES[url.pathname]));
    switch (url.pathname) {
      case '/robots.txt': return send(200, 'text/plain', 'User-agent: *\nDisallow: /private/\n');
      case '/plain.txt': return send(200, 'text/plain; charset=utf-8', 'plain text body\n');
      case '/data.json': return send(200, 'application/json', JSON.stringify({ a: 1 }));
      case '/image.png': return send(200, 'image/png', Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64)]));
      case '/big': return send(200, 'text/plain', 'x'.repeat(3_000_000));
      case '/slow': await new Promise((r) => setTimeout(r, 2000)); return send(200, 'text/plain', 'late');
      case '/redirect': return send(302, 'text/plain', '', { Location: '/docs/a' });
      case '/redirect-private': return send(302, 'text/plain', '', { Location: 'http://10.0.0.1/' });
      case '/redirect-other': return send(302, 'text/plain', '', { Location: 'https://not-allowed.example/' });
      case '/loop': return send(302, 'text/plain', '', { Location: '/loop' });
      case '/latin1': return send(200, 'text/html; charset=iso-8859-1', Buffer.from(page('Caf\xe9', '<p>Caf\xe9</p>'), 'latin1'));
      case '/meta-charset': return send(200, 'text/html', Buffer.from('<html><head><meta charset="iso-8859-1"><title>Caf\xe9</title></head><body><p>Caf\xe9</p></body></html>', 'latin1'));
      case '/missing': return send(404, 'text/html', page('Not found', '<p>No such page.</p>'));
      default: return send(404, 'text/plain', 'nothing here');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const SITE_SETTINGS = { [tools.WEB_ALLOW]: 'http://127.0.0.1', [tools.WEB_ALLOW_PRIVATE]: 'true', [tools.WEB_CRAWL_DELAY_MS]: 0,
  [tools.WEB_TIMEOUT_MS]: 500, [tools.WEB_MAX_BYTES]: 65536 };

function webTools(settings = {}) {
  resetConfig();
  configure({ ...SITE_SETTINGS, ...settings });
  const log = ledger();
  return { web: tools.createWebTools(tools.loadWebSandbox({ log }), { log }), log };
}

test('web.fetch returns a page as text, markdown and raw', async () => {
  const { web } = webTools();
  const reply = await web.webFetch({}, { url: `${site}/` });
  assert.deepEqual([reply.url, reply.status, reply.content_type, reply.title], [`${site}/`, 200, 'text/html', 'Home']);
  assert.ok(reply.text.startsWith('Welcome\n\nStart Section A and Section B'), reply.text);
  assert.ok(!reply.text.includes('Menu'));
  assert.ok(reply.bytes > 100 && reply.truncated === false);
  const markdown = await web.webFetch({}, { url: `${site}/`, as: 'markdown' });
  assert.ok(markdown.text.startsWith(`# Welcome\n\nStart [Section A](${site}/docs/a) and [Section B](${site}/docs/b)`), markdown.text);
  const raw = await web.webFetch({}, { url: `${site}/`, as: 'raw' });
  assert.ok(raw.text.startsWith('<!DOCTYPE html>') && raw.title === '');
});

test('web.fetch returns text resources and refuses binaries', async () => {
  const { web } = webTools();
  const plain = await web.webFetch({}, { url: `${site}/plain.txt` });
  assert.deepEqual([plain.content_type, plain.text, plain.title], ['text/plain', 'plain text body\n', '']);
  assert.deepEqual(JSON.parse((await web.webFetch({}, { url: `${site}/data.json`, as: 'markdown' })).text), { a: 1 });
  assert.deepEqual(await refusal(web.webFetch({}, { url: `${site}/image.png` })), { status: 400, message: 'the response is image/png, not text' });
  const missing = await web.webFetch({}, { url: `${site}/missing` });
  assert.deepEqual([missing.status, missing.title], [404, 'Not found'], "a page's own status is a result, not an error");
});

test('web.fetch cuts the body and the text', async () => {
  const { web } = webTools();
  const big = await web.webFetch({}, { url: `${site}/big` });
  assert.deepEqual([big.bytes, big.truncated], [65536, true]);
  assert.equal(big.text.length, tools.DEFAULT_PAGE_MAX_CHARS);
  const { web: small } = webTools({ [tools.WEB_PAGE_MAX_CHARS]: 100 });
  const cut = await small.webFetch({}, { url: `${site}/`, as: 'markdown' });
  assert.equal(cut.text.length, 100);
  assert.equal(cut.truncated, true);
});

test('web.fetch decodes the charset of the header or the meta tag', async () => {
  const { web } = webTools();
  const header = await web.webFetch({}, { url: `${site}/latin1` });
  assert.deepEqual([header.title, header.text], ['Café', 'Café']);
  const meta = await web.webFetch({}, { url: `${site}/meta-charset` });
  assert.deepEqual([meta.title, meta.text], ['Café', 'Café']);
});

test('web.fetch follows allowed redirects and refuses the others', async () => {
  const { web } = webTools();
  const followed = await web.webFetch({}, { url: `${site}/redirect` });
  assert.deepEqual([followed.url, followed.status, followed.title], [`${site}/docs/a`, 200, 'Section A']);
  includes((await refusal(web.webFetch({}, { url: `${site}/redirect-private` }))).message, '10.0.0.1 is not one of the sites');
  includes((await refusal(web.webFetch({}, { url: `${site}/redirect-other` }))).message, 'not-allowed.example is not one of the sites');
  includes((await refusal(web.webFetch({}, { url: `${site}/loop` }))).message, 'too many redirects');
});

test('web.fetch times out and refuses outside the allowlist', async () => {
  const { web } = webTools();
  const slow = await refusal(web.webFetch({}, { url: `${site}/slow` }));
  assert.equal(slow.status, 408);
  includes(slow.message, 'did not answer within 500 ms');
  includes((await refusal(web.webFetch({}, { url: 'https://docs.example.com/' }))).message, 'not one of the sites');
  includes((await refusal(web.webFetch({}, { url: `${site}/`, as: 'pdf' }))).message, 'as must be one of text, markdown, raw');
  includes((await refusal(web.webFetch({}, { url: `${site}/`, mode: 'text' }))).message, 'web_fetch does not take mode');
});

test('the private-range gate closes the fixture without the flag, and http needs its scheme listed', async () => {
  const { web: closed } = webTools({ [tools.WEB_ALLOW_PRIVATE]: false });
  const got = await refusal(closed.webFetch({}, { url: `${site}/` }));
  assert.equal(got.status, 400);
  includes(got.message, '127.0.0.1 resolves to a loopback address');
  const { web: httpsOnly } = webTools({ [tools.WEB_ALLOW]: '127.0.0.1', [tools.WEB_ALLOW_PRIVATE]: true });
  includes((await refusal(httpsOnly.webFetch({}, { url: `${site}/` }))).message, 'allowed over https only');
});

test('logs carry the host and the size, never the URL', async () => {
  const { web, log } = webTools();
  await web.webFetch({}, { url: `${site}/docs/a?token=do-not-log-me` });
  includes(log.text(), 'web.fetch 127.0.0.1 200');
  assert.ok(!log.text().includes('do-not-log-me') && !log.text().includes('/docs/a'));
});

test('web.crawl follows links breadth-first inside the include', async () => {
  const { web } = webTools();
  const reply = await web.webCrawl({}, { url: `${site}/`, include: '/docs/' });
  assert.deepEqual(reply.pages.map((p) => p.url), [`${site}/`, `${site}/docs/a`, `${site}/docs/b`, `${site}/docs/c`]);
  assert.deepEqual(reply.pages.map((p) => p.title), ['Home', 'Section A', 'Section B', 'Section C']);
  assert.equal(reply.pages[1].text, 'A\n\nText of A, see C.');
  assert.deepEqual([reply.visited, reply.truncated], [4, false]);
  const relative = await web.webCrawl({}, { url: `${site}/`, include: 'ocs/' });
  assert.deepEqual(relative.pages.map((p) => p.url), [`${site}/`, `${site}/docs/a`, `${site}/docs/b`, `${site}/docs/c`], 'a relative include matches anywhere in the path');
  const shallow = await web.webCrawl({}, { url: `${site}/`, include: 'docs/', max_depth: 1 });
  assert.deepEqual(shallow.pages.map((p) => p.url), [`${site}/`, `${site}/docs/a`, `${site}/docs/b`]);
  assert.equal(shallow.truncated, false);
  const alone = await web.webCrawl({}, { url: `${site}/docs/c`, max_depth: 0 });
  assert.equal(alone.pages.length, 1);
});

test('web.crawl honours robots.txt, the host and the caps', async () => {
  const { web } = webTools();
  const reply = await web.webCrawl({}, { url: `${site}/` });
  const urls = reply.pages.map((p) => p.url);
  assert.ok(!urls.includes(`${site}/private/secret`), 'robots.txt is honoured');
  assert.ok(urls.includes(`${site}/other`) && !urls.some((u) => u.includes('elsewhere.example')), 'same host only');
  assert.equal(reply.visited, 5);
  const capped = await web.webCrawl({}, { url: `${site}/`, max_pages: 2 });
  assert.equal(capped.pages.length, 2);
  assert.equal(capped.truncated, true);
  tools.setCrawlResultMaxChars(30);
  try {
    const budget = await web.webCrawl({}, { url: `${site}/` });
    assert.equal(budget.truncated, true);
    assert.ok(budget.pages.reduce((n, p) => n + p.text.length, 0) <= 30);
  } finally {
    tools.setCrawlResultMaxChars(60000);
  }
  const { web: three } = webTools({ [tools.WEB_CRAWL_MAX_PAGES]: 3 });
  const configured = await three.webCrawl({}, { url: `${site}/`, max_pages: 50 });
  assert.equal(configured.pages.length, 3);
  assert.equal(configured.truncated, true);
});

// --- the clock -----------------------------------------------------------------------------------

test('time.now in UTC and in a zone', async () => {
  const reply = await tools.timeNow({}, undefined);
  assert.deepEqual(Object.keys(reply).sort(), ['epoch_ms', 'local', 'offset', 'timezone', 'utc', 'weekday']);
  assert.ok(reply.utc.endsWith('Z') && reply.timezone === 'UTC' && reply.offset === '+00:00');
  assert.equal(reply.weekday, new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(reply.epoch_ms)));
  assert.ok(reply.local.startsWith(reply.utc.slice(0, 19)) && reply.local.endsWith('+00:00'), reply.local);
  const singapore = await tools.timeNow({}, { timezone: 'Asia/Singapore' });
  assert.ok(singapore.offset === '+08:00' && singapore.local.endsWith('+08:00') && singapore.timezone === 'Asia/Singapore');
  const bad = await refusal(tools.timeNow({}, { timezone: 'Mars/Olympus' }));
  assert.equal(bad.status, 400);
  includes(bad.message, 'is not a time zone');
  includes((await refusal(tools.timeNow({}, { tz: 'UTC' }))).message, 'time_now does not take tz');
});

// --- the knowledge graph: the pure half ---------------------------------------------------------

test('write clauses are found outside literals and comments', () => {
  for (const [query, clause] of [
    ['MATCH (n) RETURN n', undefined],
    ["MATCH (n) WHERE n.name = 'please SET this' RETURN n", undefined],
    ['MATCH (n:`CREATE`) RETURN n.offset, n.settings // DELETE later', undefined],
    ['MATCH (n) RETURN n /* MERGE */', undefined],
    ['CREATE (n:X) RETURN n', 'CREATE'], ['match (n) set n.x = 1', 'SET'], ['MATCH (n) DETACH DELETE n', 'DELETE'],
    ['MERGE (n:X {k: 1})', 'MERGE'], ['MATCH (n) REMOVE n:X', 'REMOVE'], ['DROP INDEX x', 'DROP'],
    ["LOAD   CSV FROM 'file:///x.csv' AS row RETURN row", 'LOAD CSV']
  ]) {
    assert.equal(tools.writeClause(query), clause, query);
  }
  assert.equal(tools.deleteClause('MATCH (n) DETACH DELETE n'), 'DELETE');
  assert.equal(tools.deleteClause('DROP CONSTRAINT c'), 'DROP');
  assert.equal(tools.deleteClause("MERGE (n:X) SET n.deleted = 'DELETE'"), undefined);
});

const fakeNode = (id, labels, props) => ({ elementId: id, labels, properties: props, identity: 0 });
const fakeRel = (id, type, from, to, props) => ({ elementId: id, type, startNodeElementId: from, endNodeElementId: to, properties: props, identity: 0 });

test('renderValue shapes nodes, relationships, paths and the driver types', () => {
  const a = fakeNode('4:g:1', ['Party', 'Clause'], { key: 'clause:1', n: 1 });
  const b = fakeNode('4:g:2', ['Party'], { key: 'party:a' });
  const r = fakeRel('5:g:9', 'BINDS', '4:g:1', '4:g:2', { since: 2026 });
  assert.deepEqual(tools.renderValue(a), { id: '4:g:1', labels: ['Clause', 'Party'], properties: { key: 'clause:1', n: 1 } });
  assert.deepEqual(tools.renderValue(r), { id: '5:g:9', type: 'BINDS', start: '4:g:1', end: '4:g:2', properties: { since: 2026 } });
  assert.deepEqual(tools.renderValue({ start: a, end: b, segments: [{ start: a, relationship: r, end: b }] }).map((i) => i.id), ['4:g:1', '5:g:9', '4:g:2']);
  const { Node, Relationship, Path, PathSegment, DateTime, Date: DriverDate, Point } = neo4j.types;
  const real = new Node(7, ['Clause'], { key: 'clause:7' }, '4:real:7');
  assert.deepEqual(tools.renderValue(real), { id: '4:real:7', labels: ['Clause'], properties: { key: 'clause:7' } });
  const realRel = new Relationship(2, 1, 3, 'BINDS', { since: neo4j.int(2026) }, '5:r:2', '4:n:1', '4:n:3');
  assert.deepEqual(tools.renderValue(realRel), { id: '5:r:2', type: 'BINDS', start: '4:n:1', end: '4:n:3', properties: { since: 2026 } });
  const n1 = new Node(1, ['A'], {}, '4:n:1');
  const n3 = new Node(3, ['B'], {}, '4:n:3');
  assert.deepEqual(tools.renderValue(new Path(n1, n3, [new PathSegment(n1, realRel, n3)])).map((i) => i.id), ['4:n:1', '5:r:2', '4:n:3']);
  assert.equal(tools.renderValue(new DateTime(2026, 11, 17, 10, 0, 0, 0, 0)), '2026-11-17T10:00:00Z');
  assert.equal(tools.renderValue(new DriverDate(2026, 11, 17)), '2026-11-17');
  assert.deepEqual(tools.renderValue(new Point(7203, 1, 2)), { srid: 7203, coordinates: [1, 2] });
  assert.equal(tools.renderValue(Buffer.from([0, 1])), 'AAE=');
  assert.deepEqual(tools.renderValue({ k: [1, 'a', null, true] }), { k: [1, 'a', null, true] });
  assert.equal(tools.renderValue(3.5), 3.5);
  assert.equal(tools.renderValue(neo4j.int(42)), 42);
});

test('graph errors map to statuses by type', () => {
  const error = (code, message) => new neo4j.Neo4jError(message, code);
  const syntax = tools.graphError(error('Neo.ClientError.Statement.SyntaxError', "Invalid input 'X'"), { timeoutMs: 10 });
  assert.deepEqual([syntax.status, syntax.message], [400, "Neo.ClientError.Statement.SyntaxError: Invalid input 'X'"]);
  const timed = tools.graphError(error('Neo.ClientError.Transaction.TransactionTimedOut', 'took too long'), { timeoutMs: 10 });
  assert.equal(timed.status, 408);
  includes(timed.message, 'within 10 ms');
  const auth = tools.graphError(error('Neo.ClientError.Security.Unauthorized', 'the credential itself'), { timeoutMs: 10 });
  assert.ok(auth.status === 503 && !auth.message.includes('the credential itself'));
  assert.equal(tools.graphError(error('Neo.TransientError.Transaction.DeadlockDetected', 'deadlock'), { timeoutMs: 10 }).status, 503);
  assert.deepEqual(Object.assign({}, { s: tools.graphError(error('ServiceUnavailable', 'gone'), { timeoutMs: 10 }).status }), { s: 503 });
  assert.equal(tools.graphError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), { timeoutMs: 10 }).status, 408);
  assert.equal(tools.graphError(new RangeError('x'), { timeoutMs: 10 }).status, 502);
  const mine = new AppException(400, 'mine');
  assert.equal(tools.graphError(mine, { timeoutMs: 10 }), mine);
});

test('planIngest groups and validates', () => {
  const plan = tools.planIngest({
    nodes: [
      { key: 'clause:1', label: 'Clause', properties: { text: 'a', n: 1, tags: ['x', 'y'], gone: null } },
      { key: 'party:a', label: 'Party' },
      { key: 'clause:2', label: 'Clause', properties: {} }
    ],
    relationships: [{ from: 'clause:1', to: 'party:a', type: 'BINDS', properties: { since: 2026 } }],
    source: 'docs/a.md'
  }, { maxNodes: 10 });
  assert.deepEqual([...plan.nodes.keys()], ['Clause', 'Party']);
  assert.deepEqual(plan.nodes.get('Clause'), [{ key: 'clause:1', properties: { text: 'a', n: 1, tags: ['x', 'y'] } }, { key: 'clause:2', properties: {} }]);
  assert.deepEqual([...plan.relationships.entries()], [['BINDS', [{ from: 'clause:1', to: 'party:a', properties: { since: 2026 } }]]]);
  assert.deepEqual([plan.nodeCount, plan.relationshipCount, plan.source, plan.endpointKeys], [3, 1, 'docs/a.md', ['clause:1', 'party:a']]);
  const statements = tools.ingestStatements(plan);
  assert.deepEqual(statements.map(([q]) => q), [
    'UNWIND $rows AS row MERGE (n:`_Ingested`:`Clause` {key: row.key}) SET n += row.properties, n.source = $source',
    'UNWIND $rows AS row MERGE (n:`_Ingested`:`Party` {key: row.key}) SET n += row.properties, n.source = $source',
    'UNWIND $rows AS row MATCH (a:`_Ingested` {key: row.from}) MATCH (b:`_Ingested` {key: row.to}) MERGE (a)-[r:`BINDS`]->(b) SET r += row.properties, r.source = $source'
  ]);
  // a match on key without a label reads every node of the database: no statement has one
  const every = [...statements.map(([q]) => q), tools.ENDPOINTS_QUERY];
  assert.deepEqual(every.filter((q) => q.includes('(n {') || q.includes('(a {') || q.includes('(b {')), []);
  assert.equal(tools.ENDPOINTS_QUERY, 'UNWIND $keys AS key OPTIONAL MATCH (n:`_Ingested` {key: key}) WITH key, n WHERE n IS NULL RETURN key');
  assert.deepEqual(statements[0][1], { rows: plan.nodes.get('Clause'), source: 'docs/a.md' });
  const bare = tools.ingestStatements(tools.planIngest({ nodes: [{ key: 'k', label: 'L' }] }, { maxNodes: 10 }));
  assert.ok(bare[0][0].endsWith('SET n += row.properties'));
});

test('planIngest refuses by rule', () => {
  for (const [args, message] of [
    [{}, 'nothing to ingest'],
    [{ nodes: 'x' }, 'must be arrays'],
    [{ nodes: [{ key: 'k', label: 'Bad Label' }] }, 'nodes[0].label must be an identifier'],
    [{ nodes: [{ key: 'k', label: '9L' }] }, 'nodes[0].label must be an identifier'],
    [{ nodes: [{ key: '', label: 'L' }] }, 'nodes[0].key must be a non-empty string'],
    [{ nodes: [{ key: 'k', label: 'L' }, { key: 'k', label: 'L' }] }, 'appears twice'],
    [{ nodes: [{ key: 'k', label: 'L', properties: { 'bad-name': 1 } }] }, 'not an identifier'],
    [{ nodes: [{ key: 'k', label: 'L', properties: { key: 'x' } }] }, 'must not set key'],
    [{ nodes: [{ key: 'k', label: 'L', properties: { nested: { a: 1 } } }] }, 'scalar or a list of scalars'],
    [{ nodes: [{ key: 'k', label: 'L', properties: { mixed: [1, { a: 1 }] } }] }, 'list of scalars'],
    [{ nodes: [{ key: 'k', label: 'L', extra: 1 }] }, 'nodes[0] does not take extra'],
    [{ relationships: [{ from: 'a', to: 'b', type: 'has space' }] }, 'relationships[0].type must be an identifier'],
    [{ relationships: [{ from: 'a', to: 'b' }] }, 'relationships[0].type must be an identifier'],
    [{ nodes: [{ key: 'k', label: 'L' }], source: 3 }, 'source must be a string'],
    [{ nodes: [0, 1, 2].map((i) => ({ key: `k${i}`, label: 'L' })) }, '3 nodes is over the limit of 2'],
    [{ relationships: Array(9).fill({ from: 'a', to: 'b', type: 'T' }) }, '9 relationships is over the limit of 8']
  ]) {
    const got = refusalSync(() => tools.planIngest(args, { maxNodes: 2 }));
    assert.equal(got.status, 400);
    includes(got.message, message);
  }
});

// --- the knowledge graph: the tools over a fake backend ----------------------------------------

const rows = (columns, values, { truncated = false, counters = undefined } = {}) => ({ columns, values, truncated, counters });

/** Runs the work of a transaction against a script: (query, parameters, limit) -> rows, or throw. */
function fakeBackend(script) {
  const backend = {
    calls: [], modes: [], closed: false,
    async verify() {},
    async close() { backend.closed = true; },
    async execute(work, { write }) {
      backend.modes.push(write);
      return work({ run: async (query, parameters = {}, { limit } = {}) => { backend.calls.push([query, parameters, limit]); return script(query, parameters, limit); } });
    }
  };
  return backend;
}

function graphTools(script, settings = {}) {
  const backend = fakeBackend(script);
  const log = ledger();
  const sandbox = { uri: 'bolt://graph.example:7687', address: 'bolt://graph.example:7687', write: false, delete: false,
    maxRows: tools.ROWS_DEFAULT, timeoutMs: 10000, ingestMaxNodes: 500, ...settings };
  return { graph: tools.createGraphTools(sandbox, { backend, log }), backend, log };
}

function schemaScript({ memgraph = false } = {}) {
  return (query) => {
    if (query === tools.LABEL_COUNTS_QUERY) return rows(['label', 'count'], [['Clause', 12], ['Party', 3], ['_Ingested', 15]]);
    if (query === tools.RELATIONSHIP_COUNTS_QUERY) {
      return rows(['type', 'from', 'to', 'count'], [['BINDS', ['Clause', '_Ingested'], ['_Ingested', 'Party'], 7], ['BINDS', ['Rule'], ['Party'], 1]]);
    }
    if (query === tools.NODE_PROPERTIES_QUERIES[0]) {
      if (memgraph) throw new Error("There is no procedure named 'db.schema.nodeTypeProperties'.");
      return rows(['nodeLabels', 'propertyName', 'propertyTypes'], [[['Clause', '_Ingested'], 'text', ['String']], [['_Ingested', 'Clause'], 'key', ['String']], [['Party'], 'key', ['String']], [['Orphan'], null, null]]);
    }
    if (query === tools.NODE_PROPERTIES_QUERIES[1]) {
      assert.ok(memgraph, 'the fallback runs only when the first procedure is missing');
      return rows(['nodeLabels', 'propertyName', 'propertyTypes'], [[['Clause'], 'key', ['String']]]);
    }
    if (query === tools.RELATIONSHIP_PROPERTIES_QUERIES[0]) {
      if (memgraph) throw new Error("There is no procedure named 'db.schema.relTypeProperties'.");
      return rows(['relType', 'propertyName', 'propertyTypes'], [[':`BINDS`', 'source', ['String']], [':`CITES`', null, null]]);
    }
    if (query === tools.RELATIONSHIP_PROPERTIES_QUERIES[1]) return rows(['relType', 'propertyName', 'propertyTypes'], [[':BINDS', 'source', ['String']]]);
    throw new Error(`unexpected query ${query}`);
  };
}

test('graph.schema merges counts and properties', async () => {
  const { graph, backend } = graphTools(schemaScript());
  const schema = await graph.schema({}, undefined);
  assert.deepEqual(schema.labels, [
    { label: 'Clause', count: 12, properties: [{ name: 'key', types: ['String'] }, { name: 'text', types: ['String'] }] },
    { label: 'Orphan', count: 0, properties: [] },
    { label: 'Party', count: 3, properties: [{ name: 'key', types: ['String'] }] }
  ]);
  assert.deepEqual(schema.relationship_types, [
    { type: 'BINDS', count: 8, from: ['Clause', 'Rule'], to: ['Party'], properties: [{ name: 'source', types: ['String'] }] },
    { type: 'CITES', count: 0, from: [], to: [], properties: [] }
  ]);
  assert.ok(!JSON.stringify(schema).includes('_Ingested'), 'the ingest label is on every node and is left out');
  assert.deepEqual(backend.modes, [false], 'one read transaction');
});

test("graph.schema falls back to Memgraph's procedures", async () => {
  const { graph, backend } = graphTools(schemaScript({ memgraph: true }));
  const schema = await graph.schema({}, {});
  assert.deepEqual(schema.labels.map((l) => l.label), ['Clause', 'Party']);
  assert.deepEqual(schema.relationship_types[0].properties, [{ name: 'source', types: ['String'] }]);
  const queries = backend.calls.map((c) => c[0]);
  assert.ok(queries.includes(tools.NODE_PROPERTIES_QUERIES[1]) && queries.includes(tools.RELATIONSHIP_PROPERTIES_QUERIES[1]));
});

test('graph.query runs read-only with the row cap', async () => {
  const node = fakeNode('4:g:1', ['Clause'], { key: 'clause:1' });
  const { graph, backend } = graphTools((query, parameters, limit) => {
    assert.ok(query.includes('MATCH'));
    assert.deepEqual(parameters, { k: 'clause:1' });
    assert.equal(limit, 50);
    return rows(['n', 'c'], [[node, 2]], { truncated: true });
  }, { maxRows: 50 });
  assert.deepEqual(await graph.query({}, { query: 'MATCH (n {key: $k}) RETURN n, 2 AS c', parameters: { k: 'clause:1' } }),
    { columns: ['n', 'c'], rows: [[{ id: '4:g:1', labels: ['Clause'], properties: { key: 'clause:1' } }, 2]], truncated: true });
  assert.deepEqual(backend.modes, [false]);
  for (const [body, message] of [
    [{ query: 'MATCH (n) SET n.x = 1 RETURN n' }, 'query carries SET, a write clause'],
    [{ query: '   ' }, 'query must not be empty'],
    [{ query: 'MATCH (n) RETURN n', parameters: [1] }, 'parameters must be a map'],
    [{ cypher: 'MATCH (n) RETURN n' }, 'graph_query does not take cypher']
  ]) {
    const got = await refusal(graph.query({}, body));
    assert.equal(got.status, 400);
    includes(got.message, message);
  }
  assert.equal(backend.modes.length, 1, 'a refused query never reaches the database');
  const { graph: failing } = graphTools(() => { throw new neo4j.Neo4jError('Invalid input', 'Neo.ClientError.Statement.SyntaxError'); });
  assert.deepEqual(await refusal(failing.query({}, { query: 'MATCH (n RETURN n' })), { status: 400, message: 'Neo.ClientError.Statement.SyntaxError: Invalid input' });
});

test('graph.write returns counters and guards deletion', async () => {
  const { graph, backend, log } = graphTools((query) => { assert.ok(query.startsWith('CREATE INDEX')); return rows([], [], { counters: { indexes_added: 1 } }); }, { write: true });
  const reply = await graph.write({}, { query: 'CREATE INDEX clause_key FOR (n:Clause) ON (n.key)' });
  assert.deepEqual(reply.counters, Object.fromEntries(tools.COUNTER_NAMES.map((n) => [n, n === 'indexes_added' ? 1 : 0])));
  assert.deepEqual([reply.columns, reply.rows, reply.truncated], [[], [], false]);
  assert.deepEqual(backend.modes, [true]);
  includes(log.text(), 'graph.write 200 indexes_added=1');
  const guarded = await refusal(graph.write({}, { query: 'MATCH (n:Clause) DETACH DELETE n' }));
  includes(guarded.message, 'query carries DELETE - deletion is not allowed');
  includes(guarded.message, tools.GRAPH_DELETE);
  includes((await refusal(graph.write({}, { query: 'DROP INDEX clause_key' }))).message, 'DROP');
  const { graph: allowed } = graphTools(() => rows([], [], { counters: { nodes_deleted: 3 } }), { write: true, delete: true });
  assert.equal((await allowed.write({}, { query: 'MATCH (n:Clause) DETACH DELETE n' })).counters.nodes_deleted, 3);
});

test('graph.ingest merges nodes, checks endpoints, then merges relationships', async () => {
  const { graph, backend } = graphTools((query, parameters) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) return rows(['name'], [[tools.INGEST_CONSTRAINT]]);
    if (query === tools.ENDPOINTS_QUERY) {
      assert.deepEqual(parameters, { keys: ['clause:1', 'party:a'] });
      return rows(['key'], []);
    }
    return rows([], [], { counters: { nodes_created: 1 } });
  }, { write: true });
  const body = {
    nodes: [{ key: 'clause:1', label: 'Clause', properties: { text: 'pay within 30 days' } }, { key: 'party:a', label: 'Party' }],
    relationships: [{ from: 'clause:1', to: 'party:a', type: 'BINDS' }],
    source: 'contracts/a.md'
  };
  assert.deepEqual(await graph.ingest({}, body), { nodes: 2, relationships: 1 });
  const queries = backend.calls.map((c) => c[0]);
  assert.equal(queries[0], tools.INGEST_CONSTRAINT_QUERY, 'the constraint is there: nothing to prepare');
  assert.deepEqual(queries.slice(1).map((q) => (q === tools.ENDPOINTS_QUERY ? 'CHECK' : q.split(' ')[0])), ['UNWIND', 'UNWIND', 'CHECK', 'UNWIND']);
  assert.ok(queries[1].includes('MERGE (n:`_Ingested`:`Clause`') && queries[2].includes('MERGE (n:`_Ingested`:`Party`') && queries[4].includes('MERGE (a)-[r:`BINDS`]->(b)'));
  assert.deepEqual(backend.calls[1][1], { rows: [{ key: 'clause:1', properties: { text: 'pay within 30 days' } }], source: 'contracts/a.md' });
  assert.deepEqual(backend.modes, [false, true], 'a read for the constraint, then one write transaction');
  assert.deepEqual(await graph.ingest({}, body), { nodes: 2, relationships: 1 }, 'the same ingest again runs the same statements');
  assert.deepEqual(backend.modes, [false, true, true]);
  assert.equal(backend.calls.filter((c) => c[0] === tools.INGEST_CONSTRAINT_QUERY).length, 1, 'the constraint is not asked for again in this process');
});

const neo4jError = (code, message = 'refused') => Object.assign(new Error(message), { name: 'Neo4jError', code });
const INGEST_ONE_NODE = { nodes: [{ key: 'clause:1', label: 'Clause' }] };

test('the first ingest prepares a graph written before the label', async () => {
  const { graph, backend, log } = graphTools((query) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) return rows(['name'], []);
    if (query === tools.INGEST_LABEL_STATEMENT) return rows([], [], { counters: { labels_added: 42 } });
    return rows([], []);
  }, { write: true });
  assert.deepEqual(await graph.ingest({}, INGEST_ONE_NODE), { nodes: 1, relationships: 0 });
  const queries = backend.calls.map((c) => c[0]);
  // the nodes take the label before the constraint is made, and both before anything is merged:
  // a merge through the label would not find an unlabelled node and would write it a second time
  assert.deepEqual(queries.slice(0, 3), [tools.INGEST_CONSTRAINT_QUERY, tools.INGEST_LABEL_STATEMENT, tools.INGEST_CONSTRAINT_STATEMENT]);
  assert.ok(queries[3].startsWith('UNWIND $rows AS row MERGE (n:`_Ingested`:`Clause`'));
  assert.deepEqual(backend.modes, [false, true, true, true], 'a schema change has its own transaction');
  includes(log.text(), 'graph.ingest prepared the graph - 42 node(s) took the label _Ingested, constraint mercury_ingested_key created');
  assert.deepEqual(await graph.ingest({}, INGEST_ONE_NODE), { nodes: 1, relationships: 0 });
  assert.equal(backend.modes.length, 5, 'prepared once in this process');
});

test('a key on two nodes refuses the ingest and names the query that lists them', async () => {
  const { graph, backend } = graphTools((query) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) return rows(['name'], []);
    if (query === tools.INGEST_CONSTRAINT_STATEMENT) throw neo4jError('Neo.DatabaseError.Schema.ConstraintCreationFailed');
    return rows([], []);
  }, { write: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const got = await refusal(graph.ingest({}, INGEST_ONE_NODE));
    assert.equal(got.status, 409);
    assert.ok(got.message.endsWith(tools.INGEST_DUPLICATES_QUERY));
    includes(got.message, 'nothing was ingested');
  }
  const queries = backend.calls.map((c) => c[0]);
  assert.deepEqual(queries.filter((q) => q.startsWith('UNWIND')), [], 'nothing was merged');
  assert.equal(queries.filter((q) => q === tools.INGEST_CONSTRAINT_STATEMENT).length, 2, 'the next ingest tries again');
});

test('a process that may not create the constraint names the statement', async () => {
  const { graph, backend } = graphTools((query) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) return rows(['name'], []);
    if (query === tools.INGEST_CONSTRAINT_STATEMENT) throw neo4jError('Neo.ClientError.Security.Forbidden');
    return rows([], []);
  }, { write: true });
  const got = await refusal(graph.ingest({}, INGEST_ONE_NODE));
  assert.equal(got.status, 503);
  assert.ok(got.message.endsWith(tools.INGEST_CONSTRAINT_STATEMENT));
  assert.deepEqual(backend.calls.filter((c) => c[0].startsWith('UNWIND')), []);
});

test("a database without Neo4j's constraint commands is matched by the label", async () => {
  const { graph, backend, log } = graphTools((query) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) throw neo4jError('Memgraph.ClientError.MemgraphError.MemgraphError', "mismatched input 'YIELD'");
    return rows([], []);
  }, { write: true });
  assert.deepEqual(await graph.ingest({}, INGEST_ONE_NODE), { nodes: 1, relationships: 0 });
  const queries = backend.calls.map((c) => c[0]);
  assert.deepEqual(queries.slice(0, 2), [tools.INGEST_CONSTRAINT_QUERY, tools.INGEST_LABEL_STATEMENT]);
  assert.ok(!queries.includes(tools.INGEST_CONSTRAINT_STATEMENT));
  assert.ok(queries[2].startsWith('UNWIND $rows AS row MERGE (n:`_Ingested`:`Clause`'));
  includes(log.text(), "the index on its key is the installation's to create");
});

test('a failure while preparing keeps its status and is tried again', async () => {
  const outcomes = [neo4jError('Neo.TransientError.General.DatabaseUnavailable'), null];
  const { graph } = graphTools((query) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) {
      const failure = outcomes.shift();
      if (failure) throw failure;
      return rows(['name'], [[tools.INGEST_CONSTRAINT]]);
    }
    return rows([], []);
  }, { write: true });
  assert.equal((await refusal(graph.ingest({}, INGEST_ONE_NODE))).status, 503, 'an unreachable database is not another dialect');
  assert.deepEqual(await graph.ingest({}, INGEST_ONE_NODE), { nodes: 1, relationships: 0 });
  const { graph: slow, backend } = graphTools((query) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) return rows(['name'], []);
    if (query === tools.INGEST_LABEL_STATEMENT) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return rows([], []);
  }, { write: true, timeoutMs: 1500 });
  const got = await refusal(slow.ingest({}, INGEST_ONE_NODE));
  assert.equal(got.status, 408);
  includes(got.message, 'did not finish within 1500 ms');
  assert.ok(got.message.endsWith(tools.INGEST_LABEL_STATEMENT));
  assert.deepEqual(backend.calls.filter((c) => c[0].startsWith('UNWIND')), []);
});

test('graph.ingest refuses a missing endpoint before any relationship is written', async () => {
  const { graph, backend } = graphTools((query) => {
    if (query === tools.INGEST_CONSTRAINT_QUERY) return rows(['name'], [[tools.INGEST_CONSTRAINT]]);
    return query === tools.ENDPOINTS_QUERY ? rows(['key'], [['ghost:1']]) : rows([], []);
  }, { write: true });
  const got = await refusal(graph.ingest({}, { nodes: [{ key: 'clause:1', label: 'Clause' }], relationships: [{ from: 'clause:1', to: 'ghost:1', type: 'BINDS' }] }));
  assert.deepEqual(got, { status: 400, message: 'relationship endpoints not found in the graph or in this call: ghost:1' });
  assert.deepEqual(backend.calls.map((c) => c[0]).filter((q) => q.includes('MERGE (a)')), [], 'no relationship statement ran');
  includes((await refusal(graph.ingest({}, { nodes: [{ key: 'k', label: 'Bad Label' }] }))).message, 'identifier');
  assert.equal(backend.modes.length, 2, 'a refused ingest never reaches the database');
  assert.equal(tools.graphAddress('neo4j+s://user:secret@graph.example:7687/x?y=1'), 'neo4j+s://graph.example:7687');
});

// --- file.extract --------------------------------------------------------------------------------

/** A minimal PDF with one line of text per page, with a correct cross-reference table. */
function pdf(pages) {
  const objects = [];
  const pageIds = pages.map((_, i) => 4 + 2 * i);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const content = `BT /F1 12 Tf 72 712 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function documentsWorkspace() {
  const root = workspace();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'agreement.pdf'), pdf(['Hello page one', 'Second page here', 'Third and last page of the agreement, with more words']));
  writeFileSync(join(root, 'docs', 'policy.docx'), readFileSync(fileURLToPath(new URL('./fixtures/policy.docx', import.meta.url))));
  writeFileSync(join(root, 'docs', 'page.html'), '<html><head><title>T</title></head><body><h1>Heading</h1><p>Body text.</p></body></html>');
  writeFileSync(join(root, 'docs', 'archive.zip'), Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(30)]));
  return fileTools(root);
}

test('file.extract reads a PDF with page markers and a range', async () => {
  const { files } = await documentsWorkspace();
  const reply = await files.extract({}, { path: 'docs/agreement.pdf' });
  assert.deepEqual([reply.path, reply.type, reply.pages, reply.truncated], ['docs/agreement.pdf', 'pdf', 3, false]);
  assert.equal(reply.text, '--- page 1 ---\nHello page one\n\n--- page 2 ---\nSecond page here\n\n--- page 3 ---\nThird and last page of the agreement, with more words');
  assert.equal((await files.extract({}, { path: 'docs/agreement.pdf', pages: '2' })).text, '--- page 2 ---\nSecond page here');
  const ranged = await files.extract({}, { path: 'docs/agreement.pdf', pages: '3, 1-2, 9' });
  assert.deepEqual(ranged.text.split('\n').filter((l) => l.startsWith('---')), ['--- page 3 ---', '--- page 1 ---', '--- page 2 ---']);
  const cut = await files.extract({}, { path: 'docs/agreement.pdf', max_chars: 100 });
  assert.equal(cut.text.length, 100);
  assert.equal(cut.truncated, true);
});

test('file.extract reads Word, HTML and text documents', async () => {
  const { files } = await documentsWorkspace();
  const word = await files.extract({}, { path: 'docs/policy.docx' });
  assert.deepEqual([word.type, word.pages], ['docx', 1]);
  includes(word.text, '--- page 1 ---\nPolicy title\n\nPay within thirty days.');
  includes(word.text, 'Party');
  includes(word.text, 'Supplier');
  const html = await files.extract({}, { path: 'docs/page.html' });
  assert.deepEqual([html.type, html.text], ['html', '--- page 1 ---\nHeading\n\nBody text.']);
  const text = await files.extract({}, { path: 'notes/plan.md' });
  assert.deepEqual([text.type, text.text], ['text', '--- page 1 ---\n# Plan\n\nWrite the tools.']);
});

test('file.extract refuses by rule', async () => {
  const { files } = await documentsWorkspace();
  for (const [body, status, message] of [
    [{ path: 'data/image.png' }, 400, 'not a PDF, Word, HTML or text document (a PNG image)'],
    [{ path: 'docs/archive.zip' }, 400, 'not a PDF, Word, HTML or text document'],
    [{ path: 'docs/agreement.pdf', pages: 'x' }, 400, 'pages must be page numbers and ranges'],
    [{ path: 'docs/agreement.pdf', pages: '0' }, 400, 'counted from 1'],
    [{ path: 'docs/agreement.pdf', pages: '3-1' }, 400, 'counted from 1'],
    [{ path: 'docs/agreement.pdf', pages: 2 }, 400, 'pages must be a string'],
    [{ path: 'docs/agreement.pdf', max_chars: 10 }, 400, 'max_chars must be at least 100'],
    [{ path: 'docs/missing.pdf' }, 404, 'file not found'],
    [{ path: 'docs' }, 400, 'is a directory'],
    [{ path: '../outside/secret.txt' }, 400, 'outside the workspace']
  ]) {
    const got = await refusal(files.extract({}, body));
    assert.equal(got.status, status, JSON.stringify(body));
    includes(got.message, message);
  }
  assert.deepEqual(tools.pageRange(undefined, 3), [1, 2, 3]);
  assert.deepEqual(tools.pageRange(' ', 2), [1, 2]);
  assert.deepEqual(tools.pageRange('2-9', 3), [2, 3]);
  assert.deepEqual(tools.pageRange('1,1,2', 3), [1, 2]);
  assert.deepEqual(tools.pageRange('1-3', 0), []);
  assert.equal(tools.documentKind(Buffer.from('%PDF-1.7 ...'), '.pdf'), 'pdf');
  assert.equal(tools.documentKind(Buffer.from('<!DOCTYPE html><html>'), '.txt'), 'html');
  assert.equal(tools.documentKind(Buffer.from('plain words'), '.htm'), 'html');
  assert.equal(tools.documentKind(Buffer.from('plain words'), '.md'), 'text');
  assert.equal(tools.documentKind(Buffer.from('\x89PNG\r\n', 'latin1'), '.png'), undefined);
  assert.equal(tools.documentKind(readFileSync(fileURLToPath(new URL('./fixtures/policy.docx', import.meta.url))), '.docx'), 'docx');
});

// --- the boot: what registers, the health route, describe ---------------------------------------

function app(settings, options = {}) {
  resetConfig();
  configure(settings);
  const registry = new FunctionRegistry();
  const log = ledger();
  const lines = [];
  const instance = tools.createAgentTools({ registry, log, out: (line) => lines.push(line), ...options });
  return { instance, registry, log, lines };
}

test('without a sandbox only the clock registers', async () => {
  const { instance, registry, log } = app({});
  await instance.boot();
  assert.deepEqual(instance.registered, ['time.now']);
  includes(log.text(), 'File tools not registered - tools.file.root is not set');
  includes(log.text(), 'Web tools not registered - tools.web.allow is empty');
  includes(log.text(), 'Graph tools not registered - tools.graph.uri is not set');
  const service = registry.get('time.now');
  assert.ok(service && !service.isPrivate && service.instances === 10);
  await instance.shutdown();
  const { instance: off } = app({ [tools.TIME_ENABLED]: 'false' });
  await off.boot();
  assert.deepEqual(off.registered, []);
});

test('a bad sandbox stops the boot by name', async () => {
  const { instance, log } = app({ [tools.FILE_ROOT]: join(tmpdir(), 'no-such-workspace-dir') });
  await assert.rejects(instance.boot(), (e) => e instanceof tools.ToolsError);
  includes(log.text(), 'tools.file.root is not a directory');
  const { instance: web, log: webLog } = app({ [tools.WEB_ALLOW]: 'https://x/path' });
  await assert.rejects(web.boot(), tools.ToolsError);
  includes(webLog.text(), 'is not a host pattern');
  const { instance: number, log: numberLog } = app({ [tools.WEB_ALLOW]: 'docs.example.com', [tools.WEB_TIMEOUT_MS]: 'soon' });
  await assert.rejects(number.boot(), tools.ToolsError);
  includes(numberLog.text(), 'tools.web.timeout.ms must be an integer');
  const { instance: uri, log: uriLog } = app({ [tools.GRAPH_URI]: 'http://graph.example:7474' });
  await assert.rejects(uri.boot(), tools.ToolsError);
  includes(uriLog.text(), 'tools.graph.uri must be a Bolt URI');
  const { instance: noDriver, log: noDriverLog } = app({ [tools.GRAPH_URI]: 'bolt://graph.example:7687' }, { driver: false });
  await assert.rejects(noDriver.boot(), tools.ToolsError);
  includes(noDriverLog.text(), 'the Bolt driver is not installed - npm install --save-dev neo4j-driver');
});

test('a full configuration registers every file, web and clock tool and serves them through the bus', async () => {
  const root = workspace();
  const { instance, registry, log } = app({ ...SITE_SETTINGS, [tools.FILE_ROOT]: root, [tools.WEB_CRAWL_MAX_PAGES]: 80 });
  await instance.boot();
  includes(log.text(), "tools.web.crawl.max.pages=80 is over the tool's cap 50");
  assert.deepEqual(instance.registered, STEP_ONE_ROUTES);
  for (const route of STEP_ONE_ROUTES) {
    const service = registry.get(route);
    assert.ok(service && !service.isPrivate && service.instances === 10, route);
  }
  const po = new PostOffice(undefined, {}, registry);
  try {
    const read = await po.request('file.read', { path: 'notes/plan.md' }, { timeoutMs: 5000 });
    assert.ok(read.getStatus() === 200 && read.body.text.startsWith('# Plan'));
    const refused = await po.request('file.read', { path: '../x' }, { timeoutMs: 5000 });
    assert.ok(refused.getStatus() === 400 && String(refused.body).includes('outside the workspace'));
    const fetched = await po.request('web.fetch', { url: `${site}/docs/c` }, { timeoutMs: 5000 });
    assert.ok(fetched.getStatus() === 200 && fetched.body.title === 'Section C');
    const clock = await po.request('time.now', {}, { timeoutMs: 5000 });
    assert.ok(clock.getStatus() === 200 && clock.body.timezone === 'UTC');
    const info = await instance.health({ type: 'info' });
    assert.equal(info.service, 'agent.tools');
    assert.deepEqual(info.tools, STEP_ONE_ROUTES);
    assert.equal(info.workspace, instance.state.files.root);
    assert.deepEqual(info.allowed_sites, ['http://127.0.0.1']);
    assert.equal(info.graph, null);
    assert.equal(await instance.health({ type: 'health' }), 'agent.tools is running fine');
  } finally {
    await registry.bus.close();
    await instance.shutdown();
  }
});

test('the graph tools register by the URI and the write gate, and a silent database is logged, not fatal', async () => {
  const backends = [];
  const graphBackend = (sandbox) => { const b = fakeBackend(() => rows([], [])); b.sandbox = sandbox; backends.push(b); return b; };
  const { instance: reads, log } = app({ [tools.GRAPH_URI]: 'bolt://graph.example:7687', [tools.GRAPH_USERNAME]: 'neo4j',
    [tools.GRAPH_PASSWORD]: 'a-value-never-logged', [tools.TIME_ENABLED]: false }, { graphBackend });
  await reads.boot();
  assert.deepEqual(reads.registered, ['graph.schema', 'graph.query']);
  includes(log.text(), 'graph.write and graph.ingest not registered - tools.graph.write is false');
  includes(log.text(), 'Graph tools registered - bolt://graph.example:7687');
  assert.ok(!log.text().includes('a-value-never-logged'));
  assert.equal(backends[0].sandbox.password, 'a-value-never-logged');
  await reads.shutdown();
  assert.ok(backends[0].closed);
  const { instance: writes, log: writesLog } = app({ [tools.GRAPH_URI]: 'bolt://graph.example:7687', [tools.GRAPH_WRITE]: 'true',
    [tools.GRAPH_DELETE]: true, [tools.TIME_ENABLED]: false }, { graphBackend });
  await writes.boot();
  assert.deepEqual(writes.registered, ['graph.schema', 'graph.query', 'graph.write', 'graph.ingest']);
  includes(writesLog.text(), 'writes allowed, deletion allowed');
  assert.equal((await writes.health({ type: 'info' })).graph, 'bolt://graph.example:7687');
  const unreachable = (sandbox) => { const b = fakeBackend(() => rows([], [])); b.verify = async () => { throw new Error('connection refused'); }; b.sandbox = sandbox; return b; };
  const { instance: silent, log: silentLog } = app({ [tools.GRAPH_URI]: 'bolt://graph.example:7687', [tools.TIME_ENABLED]: false }, { graphBackend: unreachable });
  await silent.boot();
  assert.deepEqual(silent.registered, ['graph.schema', 'graph.query']);
  includes(silentLog.text(), 'does not answer yet (Error); calls fail until it does');
});

test('file.extract registers only with the documents libraries', async () => {
  const root = workspace();
  const { instance } = app({ [tools.FILE_ROOT]: root, [tools.TIME_ENABLED]: false });
  await instance.boot();
  assert.ok(instance.registered.includes('file.extract'));
  const { instance: without, log } = app({ [tools.FILE_ROOT]: root, [tools.TIME_ENABLED]: false }, { documents: false });
  await without.boot();
  assert.ok(!without.registered.includes('file.extract'));
  includes(log.text(), 'file.extract not registered - npm install --save-dev mammoth pdfjs-dist');
});

test('the platform runs the boot before the host listens', async () => {
  const registry = new FunctionRegistry();
  resetConfig();
  const instance = tools.createAgentTools({ registry, log: ledger() });
  const fresh = new Platform(registry);
  fresh.onStartup(instance.boot);
  fresh.onCleanup(instance.shutdown);
  const httpServer = await fresh.run({ port: 0 });
  try {
    assert.deepEqual(instance.registered, ['time.now']);
  } finally {
    await new Promise((r) => httpServer.close(r));
    await registry.bus.close();
  }
});

test('describe prints every row and what registers', async () => {
  const { instance, lines } = app({});
  assert.equal(await instance.describe([]), 0);
  const out = lines.join('\n');
  assert.ok(out.startsWith('# 12 built-in tool(s)'));
  includes(out, '## file.read (file_read) - NOT registered (tools.file.root is not set)');
  includes(out, '## file.extract (file_extract) - NOT registered (tools.file.root is not set)');
  includes(out, '## web.fetch (web_fetch) - NOT registered (tools.web.allow is empty)');
  includes(out, '## graph.schema (graph_schema) - NOT registered (tools.graph.uri is not set)');
  includes(out, '## time.now (time_now) - registers');
  for (const row of tools.ROWS) includes(out, tools.rowJson(row).trimEnd());
  const root = workspace();
  const { instance: configured, lines: configuredLines } = app({ [tools.FILE_ROOT]: root, [tools.WEB_ALLOW]: 'docs.example.com, *.example.org', [tools.GRAPH_URI]: 'bolt://graph.example:7687' });
  assert.equal(await configured.describe(['file_read', 'web.crawl', 'graph_query', 'graph_write']), 0);
  const text = configuredLines.join('\n');
  assert.ok(text.startsWith('# 4 built-in tool(s)'));
  includes(text, `## file.read (file_read) - registers (workspace ${instanceRoot(root)})`);
  includes(text, '## web.crawl (web_crawl) - registers (2 allowed site pattern(s))');
  includes(text, '## graph.query (graph_query) - registers (bolt://graph.example:7687)');
  includes(text, '## graph.write (graph_write) - NOT registered (tools.graph.write is false)');
  assert.ok(!text.includes('file_write'));
  const errors = [];
  assert.equal(await configured.describe(['nope'], (line) => errors.push(line)), 1);
  includes(errors.join('\n'), 'Unknown tool(s): nope');
});

function instanceRoot(root) {
  // macOS resolves /var to /private/var: the workspace is reported as its real path
  return readdirSync(root) && (root.startsWith('/var/') ? `/private${root}` : root);
}

test('the catalog files are the rows byte for byte, and the rows satisfy the loop\'s catalog rules', () => {
  const files = readdirSync(tools.CATALOG_DIR).sort();
  assert.deepEqual(files, tools.ROWS.map((row) => `${row.name}.json`).sort());
  for (const row of tools.ROWS) {
    assert.equal(readFileSync(join(tools.CATALOG_DIR, `${row.name}.json`), 'utf8'), tools.rowJson(row), row.name);
    assert.ok(['name,description,input_schema,route', 'name,description,input_schema,route,write'].includes(Object.keys(row).join(',')));
    assert.match(row.name, /^[a-zA-Z0-9_-]{1,128}$/);
    assert.equal(row.name, row.route.replace(/\./g, '_'));
    assert.ok(row.description.trim() && row.description.length < 700);
    checkSchema(row.input_schema);
    assert.equal(row.input_schema.type, 'object');
    assert.equal(row.input_schema.additionalProperties, false);
    assert.equal(Boolean(row.write), WRITERS.has(row.name), `${row.name} write mark`);
  }
});

function checkSchema(schema) {
  for (const key of Object.keys(schema)) assert.ok(SCHEMA_KEYWORDS.has(key), `${key} is not in the loop's subset`);
  assert.ok(['string', 'integer', 'boolean', 'object', 'array'].includes(schema.type));
  if (schema.type === 'object') {
    for (const prop of Object.values(schema.properties ?? {})) checkSchema(prop);
    for (const name of schema.required ?? []) assert.ok(name in (schema.properties ?? {}), name);
  }
  if (schema.type === 'array') checkSchema(schema.items);
}

// --- the live graph (gated) ---------------------------------------------------------------------

test('live graph round trip', { skip: process.env.TOOLS_GRAPH_TEST_URI ? false : 'set TOOLS_GRAPH_TEST_URI (and TOOLS_GRAPH_TEST_PASSWORD) - e.g. the database extensions/agent-tools/dev/graph-up.sh starts' }, async () => {
  resetConfig();
  configure({
    [tools.GRAPH_URI]: process.env.TOOLS_GRAPH_TEST_URI, [tools.GRAPH_USERNAME]: process.env.TOOLS_GRAPH_TEST_USER ?? 'neo4j',
    [tools.GRAPH_PASSWORD]: process.env.TOOLS_GRAPH_TEST_PASSWORD ?? '', [tools.GRAPH_WRITE]: true, [tools.GRAPH_DELETE]: true
  });
  const log = ledger();
  const sandbox = await tools.loadGraphSandbox({ log });
  const graph = tools.createGraphTools(sandbox, { log });
  const cleanup = 'MATCH (n) WHERE n:T_Clause OR n:T_Party DETACH DELETE n';
  const body = {
    nodes: [{ key: 't_clause:1', label: 'T_Clause', properties: { text: 'pay within 30 days', days: 30 } },
      { key: 't_party:a', label: 'T_Party', properties: { name: 'supplier a' } }],
    relationships: [{ from: 't_clause:1', to: 't_party:a', type: 'T_BINDS', properties: { since: 2026 } }],
    source: 'contracts/a.md'
  };
  try {
    await graph.backend.verify();
    await graph.write({}, { query: cleanup });
    assert.deepEqual(await graph.ingest({}, body), { nodes: 2, relationships: 1 });
    assert.deepEqual(await graph.ingest({}, body), { nodes: 2, relationships: 1 }, 'idempotent');
    assert.deepEqual((await graph.query({}, { query: 'MATCH (n:T_Clause) RETURN count(n) AS c' })).rows, [[1]]);
    const result = await graph.query({}, { query: 'MATCH (a:T_Clause)-[r:T_BINDS]->(b) RETURN a, r, b, a.days + $x AS sum', parameters: { x: 1 } });
    const [node, relationship, party, total] = result.rows[0];
    assert.deepEqual([...node.labels].sort(), ['T_Clause', '_Ingested']);
    assert.ok(node.properties.key === 't_clause:1' && node.properties.source === 'contracts/a.md');
    assert.ok(relationship.type === 'T_BINDS' && relationship.start === node.id && relationship.end === party.id);
    assert.deepEqual(relationship.properties, { since: 2026, source: 'contracts/a.md' });
    assert.equal(total, 31);
    const path = await graph.query({}, { query: 'MATCH p = (:T_Clause)-[:T_BINDS]->(:T_Party) RETURN p' });
    assert.deepEqual(path.rows[0][0].map((item) => (item.labels ? [...item.labels].sort() : item.type)), [['T_Clause', '_Ingested'], 'T_BINDS', ['T_Party', '_Ingested']]);
    const schema = await graph.schema({}, undefined);
    const clause = schema.labels.find((l) => l.label === 'T_Clause');
    assert.ok(clause.count === 1 && ['key', 'text', 'days', 'source'].every((n) => clause.properties.some((p) => p.name === n)));
    const binds = schema.relationship_types.find((k) => k.type === 'T_BINDS');
    assert.deepEqual([binds.count, binds.from, binds.to], [1, ['T_Clause'], ['T_Party']]);
    includes((await refusal(graph.query({}, { query: 'MATCH (n:T_Clause) SET n.x = 1 RETURN n' }))).message, 'write clause');
    assert.ok((await refusal(graph.query({}, { query: 'MATCH (n:T_Clause RETURN n' }))).message.startsWith('Neo.ClientError.Statement.SyntaxError'));
    includes((await refusal(graph.ingest({}, { relationships: [{ from: 't_clause:1', to: 'ghost:9', type: 'T_BINDS' }] }))).message, 'ghost:9');
    const guarded = tools.createGraphTools({ ...sandbox, write: true, delete: false }, { log });
    try {
      includes((await refusal(guarded.write({}, { query: cleanup }))).message, 'deletion is not allowed');
    } finally {
      await guarded.close();
    }
    // a key names one node: the constraint refuses it under another label
    const second = await refusal(graph.ingest({}, { nodes: [{ key: 't_clause:1', label: 'T_Party' }] }));
    assert.equal(second.status, 400);
    includes(second.message, 'ConstraintValidationFailed');
    // a node written before the label existed: a new process prepares the graph, and the same key
    // is merged into that node, not written a second time
    await graph.write({}, { query: "CREATE (:T_Clause {key: 't_clause:old', text: 'old'})" });
    await graph.write({}, { query: `DROP CONSTRAINT \`${tools.INGEST_CONSTRAINT}\` IF EXISTS` });
    const later = tools.createGraphTools(sandbox, { log });
    try {
      assert.deepEqual(await later.ingest({}, { nodes: [{ key: 't_clause:old', label: 'T_Clause', properties: { days: 7 } }] }), { nodes: 1, relationships: 0 });
      const found = await later.query({}, { query: "MATCH (n:_Ingested {key: 't_clause:old'}) RETURN n.text, n.days" });
      assert.deepEqual(found.rows, [['old', 7]], 'one node, with the old and the new property');
    } finally {
      await later.close();
    }
    const deleted = await graph.write({}, { query: cleanup });
    assert.ok(deleted.counters.nodes_deleted === 3 && deleted.counters.relationships_deleted === 1);
  } finally {
    await graph.close();
  }
});
