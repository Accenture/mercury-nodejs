/**
 * Static web content: the engines' `static.html.folder`, served by the host.
 *
 * The Java engine serves the files of `static.html.folder` (default `classpath:/public`) for a GET
 * no REST endpoint claims - `index.html` for a folder, a content type by extension, an ETag so a
 * browser revalidates - and the Rust engine serves a fixed `resources/public`. The packs serve the
 * same way: the key is the Java engine's and its default the Rust engine's location,
 * `resources/public` next to the application file, under the packs' resources rule (a relative
 * folder is under the application file's folder, never the working directory; `file:` is the
 * engine's prefix for an absolute path). The host's own paths and an extension's routes win over a
 * file, a file wins over the catch-all, and a folder's `index.html` replaces the embedded landing
 * page at `/`.
 *
 * Served: GET and HEAD of a regular file inside the folder, `index.html` for a folder. Not found: a
 * path with a hidden segment (one starting with `.`, so `..` too), a symbolic link that leaves the
 * folder, anything that is not a regular file. `text/html` is served `Cache-Control: no-cache` so a
 * redeployed page is revalidated on every load; every file carries an ETag and `If-None-Match`
 * answers 304, so a browser keeps the rest and asks only whether it changed. Not ported: the Java
 * engine's static-content filter, its `no-cache-pages` list and its `mime.types` section - the
 * table here covers what a web bundle ships; anything else is `application/octet-stream`.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AppConfig } from './config.js';
import { getLogger } from './log.js';

const log = getLogger('mercury.static');

export const STATIC_FOLDER = 'static.html.folder';
export const DEFAULT_FOLDER = 'resources/public';
const INDEX_HTML = 'index.html';
const FILE_PREFIX = 'file:';
const CLASSPATH_PREFIX = 'classpath:';
export const OCTET_STREAM = 'application/octet-stream';

// the engines' minimalist table (platform-core's built-in types and its mime-types.yml) plus what a
// web bundle ships; the text types carry their charset, as the host's own responses do
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/vnd.microsoft.icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  ttc: 'font/collection',
  pdf: 'application/pdf',
  wasm: 'application/wasm'
};

/**
 * The content type of a file name, by its extension - the engine's rule: a name without a dot, or
 * ending in one, is `application/octet-stream`, as is an extension the table lacks.
 */
export function contentType(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    return CONTENT_TYPES[name.slice(dot + 1).toLowerCase()] ?? OCTET_STREAM;
  }
  return OCTET_STREAM;
}

/**
 * The folder `static.html.folder` names, absolute, or undefined when there is nothing to serve: an
 * empty value turns the service off; a relative value is under the application file's folder (none
 * known - an interactive session - serves nothing); `file:` is stripped; `classpath:` has no meaning
 * in a pack, so the default stands and a warning names the value.
 */
export function resolveFolder(config: AppConfig): string | undefined {
  let value = (config.getProperty(STATIC_FOLDER, DEFAULT_FOLDER) ?? '').trim();
  if (!value) {
    return undefined;
  }
  if (value.startsWith(CLASSPATH_PREFIX)) {
    log.warn(`${STATIC_FOLDER} '${value}' names a classpath, which a pack does not have - serving ${DEFAULT_FOLDER}`);
    value = DEFAULT_FOLDER;
  } else if (value.startsWith(FILE_PREFIX)) {
    value = value.slice(FILE_PREFIX.length);
  }
  if (!isAbsolute(value)) {
    if (!config.appDir) {
      return undefined;
    }
    value = join(config.appDir, value);
  }
  return resolve(value);
}

function isDirectory(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** `If-None-Match`: one tag or a list, a weak tag matching its strong form, `*` matching anything. */
function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) {
    return false;
  }
  return value.split(',').some((tag) => {
    const candidate = tag.trim();
    return candidate === '*' || candidate.replace(/^W\//, '') === etag;
  });
}

/** The files of one folder, served by the host for the paths nothing else claims. */
export class StaticContent {
  readonly folder?: string;
  private readonly root?: string;

  constructor(folder?: string) {
    if (folder && isDirectory(folder)) {
      this.folder = folder;
      this.root = fs.realpathSync(folder);
      log.info(`Static content folder: ${folder}`);
    }
  }

  get enabled(): boolean {
    return this.root !== undefined;
  }

  /**
   * The regular file a request path names inside the folder (`index.html` for a folder), resolved,
   * or undefined: a hidden segment, a link out of the folder, a missing or special file.
   */
  async locate(pathname: string): Promise<string | undefined> {
    const root = this.root;
    if (!root) {
      return undefined;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }
    const segments = decoded.split('/').filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment.startsWith('.'))) {
      return undefined;
    }
    try {
      let target = segments.length ? await fs.promises.realpath(join(root, ...segments)) : root;
      let stat = await fs.promises.stat(target);
      if (stat.isDirectory()) {
        target = await fs.promises.realpath(join(target, INDEX_HTML));
        stat = await fs.promises.stat(target);
      }
      return target.startsWith(root + sep) && stat.isFile() ? target : undefined;
    } catch {
      return undefined; // missing, a loop, or not readable: not found
    }
  }

  /** Answer a GET or HEAD that names a file; false when the path is not ours. */
  async serve(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false;
    }
    const file = await this.locate(pathname);
    if (!file) {
      return false;
    }
    const stat = await fs.promises.stat(file);
    const etag = `"${Math.trunc(stat.mtimeMs).toString(16)}-${stat.size.toString(16)}"`;
    const type = contentType(basename(file));
    const headers: http.OutgoingHttpHeaders = {
      'content-type': type,
      etag,
      'last-modified': stat.mtime.toUTCString()
    };
    if (type.startsWith('text/html')) {
      headers['cache-control'] = 'no-cache';
    }
    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers['content-length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    try {
      await pipeline(fs.createReadStream(file), res);
    } catch {
      res.destroy();
    }
    return true;
  }
}
