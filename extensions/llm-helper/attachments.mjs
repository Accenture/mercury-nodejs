/**
 * Attachments on a single llm.chat call (RFC-0016): the files a request names, read for the LLM
 * helper next to this file. A request names a file inside ONE configured root and never carries
 * one; this module resolves the name, reads the file, decides its kind by its first bytes and
 * builds the block the model gets and the reference the audit keeps.
 *
 * The root has the agent tools' workspace rules: resolved once, a relative path only, the
 * resolved path inside it - so a path that climbs out and a link that leads out are refused - no
 * hidden entry, a regular file. Every caller that can reach the helper can have a file under the
 * root sent to the provider and read back in the reply: the root is deployment configuration.
 *
 * loadAttachments() does the work; loadInWorker() runs it in a worker thread, because hashing,
 * base64 and cutting a PDF are CPU work, and the helper's event loop carries every other call and
 * every stream of the process - a token batch is never held back for a file. Run as a worker, this
 * module answers one request from its workerData and ends. The Python twin (mercury-python
 * extensions/llm-helper) reads the same files to the same blocks, statuses and messages.
 */
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';

export const ATTACHMENTS_ROOT = 'llm.attachments.root';
export const ATTACHMENTS_MAX_BYTES = 'llm.attachments.max.bytes';
export const PDF_MEDIA_TYPE = 'application/pdf';
/** The library that cuts a PDF and tells an encrypted one - an optional install. */
export const PDF_LIBRARY = '@cantoo/pdf-lib';
export const MISSING_ATTACHMENTS_ROOT = 'attachments not configured - set llm.attachments.root';
export const MISSING_PDF_SDK = `attachments: pages needs ${PDF_LIBRARY} - npm install ${PDF_LIBRARY}`;

/** A refusal as it crosses the worker's boundary: the helper raises it as an AppException. */
export class AttachmentError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AttachmentError';
    this.status = status;
  }
}

const refuse = (status, message) => new AttachmentError(status, message);
const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

/** The one folder a request may name files in, resolved - links followed - or an error that
 * names the setting: unset is a 503, a path that is not a folder a 500. */
export async function resolveRoot(configured) {
  if (!configured) {
    throw refuse(503, MISSING_ATTACHMENTS_ROOT);
  }
  const text = String(configured);
  const expanded = text === '~' || text.startsWith('~/') ? path.join(homedir(), text.slice(1)) : text;
  try {
    const root = await realpath(path.resolve(expanded));
    if ((await stat(root)).isDirectory()) {
      return root;
    }
  } catch (error) {
    if (!missing(error) && error?.code !== 'ELOOP') {
      throw error;
    }
  }
  throw refuse(500, `${ATTACHMENTS_ROOT} is not a folder`);
}

/** A path with its links followed as far as it exists and the rest kept as written: where the
 * name leads, whether or not the file is there. */
async function resolved(target) {
  const rest = [];
  let existing = target;
  for (;;) {
    try {
      return path.join(await realpath(existing), ...rest);
    } catch (error) {
      if (!missing(error)) {
        throw error;
      }
    }
    const parent = path.dirname(existing);
    if (parent === existing) {
      return target;
    }
    rest.unshift(path.basename(existing));
    existing = parent;
  }
}

const parts = (text) => text.split(/[\\/]+/).filter((part) => part && part !== '.' && part !== '..');
const hidden = (text) => parts(text).some((part) => part.startsWith('.'));

/** The file a request names, or a 400 that names the rule it breaks - never the host's own path.
 * The resolved path decides, so a link that leads out of the root is outside it. */
async function attachmentFile(root, index, named) {
  const where = `attachments[${index}]`;
  if (path.isAbsolute(named) || named.startsWith('~')) {
    throw refuse(400, `${where}: an absolute path - name a file inside the root`);
  }
  let file;
  try {
    file = await resolved(path.resolve(root, named));
  } catch { // a loop of links, a null byte
    throw refuse(400, `${where}: not found`);
  }
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw refuse(400, `${where}: outside ${ATTACHMENTS_ROOT}`);
  }
  if (hidden(named) || hidden(relative)) {
    throw refuse(400, `${where}: a hidden entry, which the root does not expose`);
  }
  let entry;
  try {
    entry = await stat(file);
  } catch {
    throw refuse(400, `${where}: not found`);
  }
  if (!entry.isFile()) {
    throw refuse(400, `${where}: not a file`);
  }
  return { file, size: entry.size };
}

/** At most `limit` bytes of a file: a file may grow under the read. */
async function readUpTo(file, limit) {
  const handle = await open(file, 'r');
  try {
    const chunks = [];
    let total = 0;
    while (total < limit) {
      const room = Math.min(limit - total, 1 << 20);
      const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(room), 0, room, null);
      if (!bytesRead) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

const starts = (data, bytes) => data.subarray(0, bytes.length).equals(Buffer.from(bytes));

/** A file's kind by its first bytes, never by its name. */
export function mediaType(data) {
  if (starts(data, '%PDF-')) {
    return PDF_MEDIA_TYPE;
  }
  if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (starts(data, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (starts(data, 'GIF87a') || starts(data, 'GIF89a')) {
    return 'image/gif';
  }
  if (starts(data, 'RIFF') && data.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return 'image/webp';
  }
  return undefined;
}

/** The PDF to send: the file as it is, or a new one that holds only the pages named, in the order
 * named, so a long document costs the pages asked for. The library is needed to cut; with it a
 * whole document is also checked, and without it a whole document goes as it is and the provider
 * judges it. */
async function pdfOf(index, data, pages, library) {
  const where = `attachments[${index}]`;
  let lib;
  try {
    lib = await import(library);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
    if (pages === undefined) {
      return data;
    }
    throw refuse(503, MISSING_PDF_SDK);
  }
  let source;
  let count;
  try {
    source = await lib.PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
    count = source.isEncrypted ? 0 : source.getPageCount();
  } catch { // the library's own errors for a damaged file, of several types
    throw refuse(400, `${where}: not a readable PDF`);
  }
  if (source.isEncrypted) {
    throw refuse(400, `${where}: an encrypted PDF - the provider takes none`);
  }
  if (pages === undefined) {
    return data;
  }
  const beyond = pages.find(([, high]) => high > count);
  if (beyond !== undefined) {
    throw refuse(400, `${where}.pages names page ${beyond[1]} of a document of ${count}`);
  }
  try {
    const cut = await lib.PDFDocument.create({ updateMetadata: false });
    const numbers = pages.flatMap(([low, high]) => Array.from({ length: high - low + 1 }, (_, i) => low + i - 1));
    for (const page of await cut.copyPages(source, numbers)) {
      cut.addPage(page);
    }
    return Buffer.from(await cut.save());
  } catch {
    throw refuse(400, `${where}: not a readable PDF`);
  }
}

/**
 * Read the files: the blocks the model gets, the references the audit keeps - the path, the kind,
 * the size and the SHA-256 of the source file as it was read, never its bytes - and the bytes
 * read. A file's size is taken before it is read, so a file over the limit is refused unread.
 * specs: [{ path, pages: [[low, high], ...] | undefined, pagesText }].
 */
export async function loadAttachments({ specs, root, maxBytes, imageMaxEncoded, library = PDF_LIBRARY }) {
  const blocks = [];
  const references = [];
  let total = 0;
  const over = () => refuse(400,
    `attachments: more than ${maxBytes} bytes of files - ${ATTACHMENTS_MAX_BYTES} (${maxBytes})`);
  for (const [index, spec] of specs.entries()) {
    const where = `attachments[${index}]`;
    const { file, size } = await attachmentFile(root, index, spec.path);
    if (total + size > maxBytes) {
      throw over();
    }
    const data = await readUpTo(file, maxBytes - total + 1);
    total += data.length;
    if (total > maxBytes) {
      throw over();
    }
    const kind = mediaType(data);
    if (kind === undefined) {
      throw refuse(400, `${where}: not a PNG, JPEG, GIF, WebP or PDF file`);
    }
    const reference = { type: 'attachment', path: spec.path };
    if (spec.pagesText !== undefined) {
      reference.pages = spec.pagesText;
    }
    Object.assign(reference, {
      media_type: kind, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')
    });
    let sent = data;
    if (kind === PDF_MEDIA_TYPE) {
      sent = await pdfOf(index, data, spec.pages, library);
    } else {
      if (spec.pages !== undefined) {
        throw refuse(400, `${where}.pages needs a PDF - the file is ${kind}`);
      }
      const encoded = 4 * Math.floor((data.length + 2) / 3);
      if (encoded > imageMaxEncoded) {
        throw refuse(400, `${where}: an image of ${encoded} bytes base64-encoded - the backend's `
          + `limit is ${imageMaxEncoded}`);
      }
    }
    blocks.push({
      type: kind === PDF_MEDIA_TYPE ? 'document' : 'image',
      source: { type: 'base64', media_type: kind, data: sent.toString('base64') }
    });
    references.push(reference);
  }
  return { blocks, references, size: total, thread: threadId };
}

/** loadAttachments() in a worker thread of its own: the helper's event loop never waits for a
 * file, a hash or a PDF. A refusal comes back as an AttachmentError with its status. */
export function loadInWorker(request) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { attachments: request } });
    let answered = false;
    worker.once('message', (answer) => {
      answered = true;
      if (answer.refused) {
        reject(refuse(answer.refused.status, answer.refused.message));
      } else if (answer.failed) {
        reject(new Error(answer.failed));
      } else {
        resolve(answer.loaded);
      }
    });
    worker.once('error', reject);
    worker.once('exit', () => {
      if (!answered) {
        reject(new Error('the attachments worker ended without an answer'));
      }
    });
  });
}

if (!isMainThread && workerData?.attachments !== undefined) {
  try {
    parentPort.postMessage({ loaded: await loadAttachments(workerData.attachments) });
  } catch (error) {
    parentPort.postMessage(error instanceof AttachmentError
      ? { refused: { status: error.status, message: error.message } }
      : { failed: `${error?.name ?? 'Error'}: ${error?.message ?? error}` });
  }
}
