/**
 * Attachments on a single llm.chat call (RFC-0016) in the LLM helper - token-free.
 *
 * test/vectors/llm-attachments-vectors.json and the files of test/fixtures/attachments (both
 * byte-identical in mercury-python) state the contract: the shape of the field, where it does not
 * belong, the one root a request reads inside, the files refused before any model call, the blocks
 * the model gets and the reference the audit keeps. Every case builds its own root and a folder
 * beside it, and runs the real path: the files read in a worker thread. The tests after the vector
 * run pin what a vector cannot: an image's limit by backend, the helper without the PDF library,
 * the deadline over the read, the worker thread, the log and the trace annotations, and the start
 * with a root that is not a folder.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from '@cantoo/pdf-lib';
import { AppException, FunctionRegistry, PostOffice } from 'mercury-composable';
import { loadAttachments, loadInWorker } from '../extensions/llm-helper/attachments.mjs';
import {
  AUDIT_ROUTE, backendFor, createLlmHelper, MemoryAuditStore, MemoryStore
} from '../extensions/llm-helper/llm-helper.mjs';
import { fakeBackend, FakeWriter, settings, silent } from './fixtures/llm-helper-fakes.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/attachments/', import.meta.url));
const VECTORS_FILE = new URL('./vectors/llm-attachments-vectors.json', import.meta.url);
// the Python twin pins the same digests: change a file in both packs or in neither
const VECTORS_SHA256 = '06b0e85f7fa67c51eb9e63e0833d25a5e96f660c91210e460d3a346f2c574153';
const FIXTURES_SHA256 = {
  'damaged.pdf': '36a27d716a382936c825c5c3cb7bd7a2d38c0af35242d89b186b31faf2eb4ee1',
  'encrypted.pdf': '9f9e621bbe4dad963b3f5846b449dcc7424344335722c670e5d425efc7580dc7',
  'notes.txt': '98118d59bb278aef85d7f37cf587551fef57622d220e869e589d2850ffde82ce',
  'pixel.gif': '963d31f918ceb12c5322161ea10ecaa1fc3d0c31390cd4f0cd49e1c43729b31e',
  'pixel.jpg': '95ec656f94ada529679e4c7da103599777c24e090c592c6f052b503b231ff9e5',
  'pixel.png': 'b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640',
  'pixel.webp': '86be52bdb7547413cafb3ed175a806a798c65de98b40849e0b974c47d187de65',
  'three-pages.pdf': 'c609d99e859256615fe1fe853eb4fe6c449de56a859bbb6b6b66e0ac8c086416'
};
const VECTORS = JSON.parse(readFileSync(VECTORS_FILE, 'utf8'));
const CASES = VECTORS.cases;
const ROOT_KEY = 'llm.attachments.root';
const ANSWER = {
  kind: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn', deltas: ['A page.'],
  usage: { input_tokens: 900, output_tokens: 4 }, request_id: 'req_attach_test'
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const encoded = (fixture) => readFileSync(path.join(FIXTURES, fixture)).toString('base64');
const lines = () => { const seen = []; return { seen, info: (m) => seen.push(m), warn: (m) => seen.push(m), error: (m) => seen.push(m) }; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fill(folder, files) {
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(folder, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    if (typeof source === 'object') {
      symlinkSync(source.link, target);
    } else {
      copyFileSync(path.join(FIXTURES, source), target);
    }
  }
}

/** A new root holding the named fixtures and a folder beside it, removed when the test ends. */
function rootFor(t, files, outside = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'llm-attachments-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  mkdirSync(root);
  mkdirSync(path.join(base, 'outside'));
  fill(root, files);
  fill(path.join(base, 'outside'), outside);
  return { base, root };
}

/** A helper over a fake provider, with the real path under it: the function behind its mailbox,
 * the memory working store and the reference audit store, for the case that audits. */
function rigFor({ provider = ANSWER, config = {}, log = silent, deps = {}, backendOptions = {} } = {}) {
  const { backend, ledger } = fakeBackend(provider,
    { name: config['llm.backend'] ?? 'anthropic', api: config['llm.aws.api'] ?? 'mantle', ...backendOptions });
  const out = new FakeWriter();
  const registry = new FunctionRegistry();
  const postOffice = new PostOffice(undefined, {}, registry);
  const store = new MemoryStore();
  const audit = new MemoryAuditStore();
  const seen = {};
  const helper = createLlmHelper({
    prop: settings(config), backend: () => backend, store: async () => store, audit: async () => audit,
    send: (route, event) => postOffice.send(route, event), registry, writer: () => out, log,
    trace: (key, value) => { seen[key] = value; }, ...deps
  });
  registry.register(AUDIT_ROUTE, helper.transcriptAudit, { instances: 1, isPrivate: true });
  return { helper, ledger, out, store, audit, seen, backend };
}

async function refusedBy(work) {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AppException, String(error));
    return error;
  }
  return assert.fail('an AppException was expected');
}

function assertError(error, wanted) {
  assert.ok(error instanceof AppException, 'an AppException was expected');
  assert.equal(error.status, wanted.status, error.message);
  for (const fragment of wanted.message_contains) {
    assert.ok(error.message.includes(fragment), `${JSON.stringify(fragment)} not in ${JSON.stringify(error.message)}`);
  }
}

/** A sent block against its short form in the vector file. */
async function assertBlock(block, wanted) {
  if ('text' in wanted) {
    assert.deepEqual(block, { type: 'text', text: wanted.text });
    return;
  }
  if ('image' in wanted) {
    assert.deepEqual(block, {
      type: 'image', source: { type: 'base64', media_type: wanted.media_type, data: encoded(wanted.image) }
    });
    return;
  }
  assert.deepEqual([Object.keys(block).sort(), block.type], [['source', 'type'], 'document']);
  assert.deepEqual(Object.keys(block.source).sort(), ['data', 'media_type', 'type']);
  assert.deepEqual([block.source.type, block.source.media_type], ['base64', 'application/pdf']);
  if (!('pages' in wanted)) {
    assert.equal(block.source.data, encoded(wanted.document), 'a whole document goes as it is');
    return;
  }
  // a cut is never compared byte for byte: page n of the fixture is 100+n points wide
  const cut = await PDFDocument.load(Buffer.from(block.source.data, 'base64'));
  assert.deepEqual(cut.getPages().map((page) => Math.round(page.getWidth()) - 100), wanted.pages);
}

test('the vector file and the fixtures are the ones the python twin runs', () => {
  assert.equal(sha256(readFileSync(VECTORS_FILE)), VECTORS_SHA256, 'the shared vector file changed - update both packs');
  assert.deepEqual([VECTORS.contract, VECTORS.version], ['llm-attachments', 1]);
  const held = Object.fromEntries(readdirSync(FIXTURES).sort().map((name) => [name, sha256(readFileSync(path.join(FIXTURES, name)))]));
  assert.deepEqual(held, FIXTURES_SHA256, 'a shared fixture changed - update both packs');
  assert.deepEqual(Object.keys(VECTORS.fixtures).sort(), Object.keys(FIXTURES_SHA256));
});

for (const c of CASES) {
  test(`attachments contract: ${c.name}`, async (t) => {
    const { base, root } = rootFor(t, c.files ?? {}, c.outside ?? {});
    const config = { ...c.config };
    if (c.root !== false) {
      config[ROOT_KEY] = root;
    }
    const rig = rigFor({ provider: c.provider, config });
    const { expect } = c;
    let result;
    let error;
    if (c.route === 'llm.stream') {
      await rig.helper.stream({}, { body: c.body });
      error = rig.out.error ?? undefined;
    } else {
      try {
        result = await rig.helper.chat({}, c.body);
      } catch (e) {
        assert.ok(e instanceof AppException, String(e));
        error = e;
      }
    }
    if (expect.error) {
      assertError(error, expect.error);
      assert.ok(!error.message.includes(base), 'no host path');
      assert.equal(rig.ledger.calls.length, 0, 'a refused attachment reaches no model call');
      return;
    }
    assert.equal(error, undefined, error?.message);
    for (const [key, value] of Object.entries(expect.result)) {
      assert.deepEqual(result[key], value, key);
    }
    assert.equal(rig.ledger.calls.length, 1);
    const sent = rig.ledger.calls[0].params.messages;
    const wanted = expect.messages;
    assert.equal(sent.length, wanted.length);
    assert.deepEqual(sent.slice(0, -1), wanted.slice(0, -1));
    assert.deepEqual([sent.at(-1).role, sent.at(-1).content.length], ['user', wanted.at(-1).content.length]);
    for (const [index, short] of wanted.at(-1).content.entries()) {
      await assertBlock(sent.at(-1).content[index], short);
    }
    if (expect.audit_request) {
      await rig.helper.auditSingleIdle();
      for (let i = 0; i < 400 && !(rig.audit.conversations.size > 0 && rig.store.records.size === 0); i += 1) {
        await sleep(5);
      }
      assert.equal(rig.audit.conversations.size, 1, 'the call was recorded');
      const [conversation] = [...rig.audit.conversations.keys()];
      const turn = rig.audit.turnRows.get(conversation).get(1);
      assert.deepEqual(turn.request, expect.audit_request);
      assert.ok(!JSON.stringify(turn).includes('base64'), 'the audit holds a reference, never the bytes');
    }
  });
}

// --- what a vector cannot express --------------------------------------------------------------

test("an image over the backend's limit is refused before any call", async (t) => {
  // the provider counts an image base64-encoded, and the limit depends on the route to the models:
  // 10 MB on the Claude API, 5 MB on Amazon Bedrock. The helper refuses by name first
  assert.equal(backendFor('anthropic', {}).imageMaxEncoded, 10 * 1024 * 1024);
  assert.equal(backendFor('bedrock', {}).imageMaxEncoded, 5 * 1024 * 1024);
  const { root } = rootFor(t, { 'page.png': 'pixel.png' });
  const body = { prompt: 'x', attachments: ['page.png'] };
  // the 69 bytes of the fixture are 92 base64-encoded: exactly at the limit passes
  const { backend, ledger } = fakeBackend(ANSWER);
  const withLimit = (limit) => createLlmHelper({
    prop: settings({ [ROOT_KEY]: root }), backend: () => ({ ...backend, imageMaxEncoded: limit }), log: silent, trace: () => {}
  });
  assert.equal((await withLimit(92).chat({}, body)).text, 'A page.');
  const refused = await refusedBy(withLimit(91).chat({}, body));
  assert.deepEqual([refused.status, refused.message],
    [400, "attachments[0]: an image of 92 bytes base64-encoded - the backend's limit is 91"]);
  assert.equal(ledger.calls.length, 1, 'only the call that passed reached the provider');
});

test('without the pdf library pages are a 503 and a whole document goes as it is', async (t) => {
  // the library is an optional install: cutting pages needs it, and the 503 names it. A whole
  // document needs none - it goes as it is, unchecked, and the provider judges it
  const { root } = rootFor(t, { 'form.pdf': 'three-pages.pdf', 'locked.pdf': 'encrypted.pdf' });
  const rig = rigFor({ config: { [ROOT_KEY]: root }, deps: { pdfLibrary: '@cantoo/pdf-lib-that-is-not-installed' } });
  const missing = await refusedBy(rig.helper.chat({}, { prompt: 'x', attachments: [{ path: 'form.pdf', pages: 1 }] }));
  assert.deepEqual([missing.status, missing.message],
    [503, 'attachments: pages needs @cantoo/pdf-lib - npm install @cantoo/pdf-lib']);
  assert.equal(rig.ledger.calls.length, 0);
  await rig.helper.chat({}, { prompt: 'x', attachments: ['form.pdf', 'locked.pdf'] });
  const blocks = rig.ledger.calls[0].params.messages.at(-1).content;
  assert.deepEqual(blocks.slice(0, 2).map((block) => block.source.data), [encoded('three-pages.pdf'), encoded('encrypted.pdf')]);
});

test('the deadline covers the reading, and the files are read in a worker thread', async (t) => {
  // params.timeout_ms bounds the whole call, the files included: a read that outlasts it is the
  // 408 of the contract and no model call follows. The read runs in a worker thread, so a slow
  // disk, a hash or a PDF never holds the event loop, which carries every other call and stream
  const { root } = rootFor(t, { 'page.png': 'pixel.png' });
  const request = { specs: [{ path: 'page.png' }], root, maxBytes: 1000, imageMaxEncoded: 1000 };
  assert.equal((await loadAttachments(request)).thread, 0, 'called directly, it runs where it is called');
  const inWorker = await loadInWorker(request);
  assert.ok(inWorker.thread > 0, 'the helper reads in a worker thread');
  assert.deepEqual([inWorker.blocks[0].source.data, inWorker.size], [encoded('pixel.png'), 69]);
  // and the helper, left to itself, reads that way: one worker thread for the call
  let workers = 0;
  const count = () => { workers += 1; };
  process.on('worker', count);
  t.after(() => process.off('worker', count));
  const plain = rigFor({ config: { [ROOT_KEY]: root } });
  assert.equal((await plain.helper.chat({}, { prompt: 'x', attachments: ['page.png'] })).text, 'A page.');
  assert.equal(workers, 1, "the helper's own reading runs in a worker thread");
  let reads = 0;
  const slow = async (asked) => { reads += 1; await sleep(300); return loadInWorker(asked); };
  const rig = rigFor({ config: { [ROOT_KEY]: root }, deps: { loadAttachments: slow } });
  const started = performance.now();
  const late = await refusedBy(rig.helper.chat({}, { prompt: 'x', attachments: ['page.png'], params: { timeout_ms: 50 } }));
  assert.ok(performance.now() - started < 250, 'the caller has its answer at the deadline, not after the read');
  assert.deepEqual([late.status, late.message], [408, 'LLM request timed out after 50 ms']);
  assert.deepEqual([reads, rig.ledger.calls.length], [1, 0], 'no model call after the deadline');
  await sleep(320); // let the read end before the folder is removed
  // and what the read left of the deadline is the model's: the SDK's abort signal takes the rest
  const quick = rigFor({ config: { [ROOT_KEY]: root }, deps: { loadAttachments: async (asked) => { await sleep(40); return loadInWorker(asked); } } });
  await quick.helper.chat({}, { prompt: 'x', attachments: ['page.png'], params: { timeout_ms: 5000 } });
  assert.equal(quick.ledger.calls[0].options.timeout, 5000, "the SDK's own timeout is the request's");
  assert.ok(quick.ledger.calls[0].options.signal instanceof AbortSignal);
});

test("a log carries the count and the bytes and never a path or a file's content", async (t) => {
  const { base, root } = rootFor(t, { 'SCAN-MARKER/page.png': 'pixel.png', 'form.pdf': 'three-pages.pdf' });
  const log = lines();
  const rig = rigFor({ config: { [ROOT_KEY]: root }, log });
  await rig.helper.chat({}, { prompt: 'x', attachments: ['SCAN-MARKER/page.png', { path: 'form.pdf', pages: '2' }] });
  assert.ok(log.seen.includes('llm.chat attachments=2 bytes=803'), log.seen.join('\n'));
  assert.deepEqual([rig.seen.llm_attachments, rig.seen.llm_attachment_bytes], ['2', '803']);
  await refusedBy(rig.helper.chat({}, { prompt: 'x', attachments: ['SCAN-MARKER/gone.png'] }));
  const text = log.seen.join('\n');
  assert.ok(text.includes('llm.chat failed - status=400'), text);
  for (const hidden of ['SCAN-MARKER', 'form.pdf', base, encoded('pixel.png').slice(0, 24)]) {
    assert.ok(!text.includes(hidden), hidden);
  }
});

test('a call without attachments reads no root and sends text as before', async () => {
  // the field is optional: without it nothing of this is touched - no root is needed, the turn
  // stays a string, and the trace carries no attachment annotation
  let reads = 0;
  const rig = rigFor({ deps: { loadAttachments: async () => { reads += 1; return assert.fail('no file is read'); } } });
  await rig.helper.chat({}, { prompt: 'x', attachments: null });
  assert.deepEqual(rig.ledger.calls[0].params.messages, [{ role: 'user', content: 'x' }]);
  assert.deepEqual([reads, 'llm_attachments' in rig.seen], [0, false]);
  assert.equal(rig.ledger.calls[0].options.signal instanceof AbortSignal, true, 'the deadline as before');
});

test('the root is resolved once, and a root that is not a folder stops the start', async (t) => {
  // a root given through a link is resolved, once, so a request is measured against the real
  // folder. A configured root that is not a folder is a deployment error: the application stops at
  // start, by name; with no root configured the start does nothing
  const { base, root } = rootFor(t, { 'page.png': 'pixel.png' });
  const link = path.join(base, 'through-a-link');
  symlinkSync(root, link);
  const log = lines();
  const rig = rigFor({ config: { [ROOT_KEY]: link }, log });
  await rig.helper.attachmentsBoot();
  assert.ok(log.seen.includes('attachments ready - llm.attachments.root is set'), log.seen.join('\n'));
  const body = { prompt: 'x', attachments: ['page.png'] };
  assert.equal((await rig.helper.chat({}, body)).text, 'A page.');
  // the root stays the folder it resolved to, whatever the link is pointed at afterwards
  unlinkSync(link);
  symlinkSync(path.join(base, 'outside'), link);
  assert.equal((await rig.helper.chat({}, body)).text, 'A page.');
  const broken = rigFor({ config: { [ROOT_KEY]: path.join(root, 'page.png') }, log });
  const stopped = await refusedBy(broken.helper.attachmentsBoot());
  assert.deepEqual([stopped.status, stopped.message], [500, 'llm.attachments.root is not a folder']);
  assert.ok(log.seen.includes('attachments cannot start - llm.attachments.root is not a folder'), log.seen.join('\n'));
  assert.equal((await refusedBy(broken.helper.chat({}, body))).status, 500, 'and a request that meets it is a 500');
  const quiet = lines();
  await rigFor({ log: quiet }).helper.attachmentsBoot(); // with no root configured: nothing
  assert.deepEqual(quiet.seen, []);
});
