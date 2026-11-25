/**
 * The LLM helper's document intake (llm.upload): the files of a multipart upload saved under uploads/
 * inside the attachments root and the references a later llm.chat call names - the twin of the Python
 * pack's tests/test_llm_upload.py.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AppException, AsyncHttpRequest } from 'mercury-composable';
import { MISSING_ATTACHMENTS_ROOT } from '../extensions/llm-helper/attachments.mjs';
import { createLlmHelper, safeName, UPLOAD_NO_FILES } from '../extensions/llm-helper/llm-helper.mjs';
import { fakeBackend, settings, silent } from './fixtures/llm-helper-fakes.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/attachments/', import.meta.url));
const ROOT_KEY = 'llm.attachments.root';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const scratch = mkdtempSync(path.join(tmpdir(), 'mercury-upload-'));

after(() => rmSync(scratch, { recursive: true, force: true }));

function request(...files) {
  const built = new AsyncHttpRequest().setMethod('POST').setUrl('/api/llm/upload');
  for (const [name, contentType, content, tag] of files) {
    built.addFile(name, contentType, content, tag);
  }
  return built.toMap();
}

function helperWith(config) {
  const { backend } = fakeBackend('anthropic');
  return createLlmHelper({ prop: settings(config), backend: () => backend, log: silent, trace: () => {} });
}

test('the files are saved under new names and their references returned', async () => {
  const root = path.join(scratch, 'root');
  mkdirSync(root);
  const helper = helperWith({ [ROOT_KEY]: root });
  const pdf = readFileSync(path.join(FIXTURES, 'three-pages.pdf'));
  const docx = Buffer.from('PK\x03\x04 a word-processor file', 'latin1');
  const result = await helper.upload({}, request(
    ['Quarterly Report (final).pdf', 'application/pdf', pdf, 'doc'],
    ['../.hidden/notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx, 'doc']
  ));
  const saved = result.files;
  assert.equal(saved.length, 2);
  const [first, second] = saved;
  // a new name under uploads/, the original name kept beside it, hidden dots and odd characters gone
  assert.ok(first.path.startsWith('uploads/') && first.path.endsWith('-Quarterly_Report__final_.pdf'), first.path);
  assert.ok(second.path.endsWith('-hidden_notes.docx') || second.path.endsWith('-notes.docx'), second.path);
  assert.equal(first.filename, 'Quarterly Report (final).pdf');
  // the kind by the first bytes, the declared type when the bytes say nothing the model takes
  assert.equal(first.media_type, 'application/pdf');
  assert.equal(first.attachable, true);
  assert.ok(second.media_type.startsWith('application/vnd.openxmlformats'));
  assert.equal(second.attachable, false);
  assert.equal(first.bytes, pdf.length);
  assert.equal(first.sha256, sha256(pdf));
  // the saved file is the one uploaded, at the path a later call names inside the root
  assert.ok(readFileSync(path.join(root, first.path)).equals(pdf));
  assert.ok(readFileSync(path.join(root, second.path)).equals(docx));
  assert.notEqual(first.path, second.path);
});

test('without a file the request is a 400, and without a root a 503', async () => {
  const root = path.join(scratch, 'root2');
  mkdirSync(root);
  const configured = helperWith({ [ROOT_KEY]: root });
  await assert.rejects(configured.upload({}, request()), (error) => {
    assert.ok(error instanceof AppException);
    assert.deepEqual([error.status, error.message], [400, UPLOAD_NO_FILES]);
    return true;
  });
  const unconfigured = helperWith({});
  await assert.rejects(unconfigured.upload({}, request(['a.pdf', 'application/pdf', Buffer.from('%PDF-1.4'), 'doc'])),
    (error) => {
      assert.ok(error instanceof AppException);
      assert.deepEqual([error.status, error.message], [503, MISSING_ATTACHMENTS_ROOT]);
      return true;
    });
});

test('safe names', () => {
  assert.equal(safeName('Quarterly Report (final).pdf'), 'Quarterly_Report__final_.pdf');
  assert.equal(safeName('../.hidden/evil name.pdf'), 'evil_name.pdf');
  assert.equal(safeName('.bashrc'), 'bashrc');
  assert.equal(safeName(''), '');
  assert.equal(safeName(`${'x'.repeat(200)}.pdf`).length, 80);
});
