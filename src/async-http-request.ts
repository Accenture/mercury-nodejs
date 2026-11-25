/**
 * The `AsyncHttpRequest` model: the request a REST automation entry delivers to its function, with
 * the engines' keys.
 *
 * A function behind a `rest.yaml` entry receives the whole request as its body - a map with `method`,
 * `url`, `ip`, `https`, `host`, `headers`, `parameters` (`path` and `query`), `body`, `timeout`,
 * `query` (the raw query string), `cookies` and `session` (the authentication function's verdict
 * headers) - never the bare HTTP body. An entry with `upload: true` adds the engines' upload keys for
 * a multipart body - `filename`, `file_type`, `file_length`, the `upload` tags and `size` - and, in
 * this pack's bounded form of the engines' streaming upload, the files' bytes in `contents`. This
 * class reads that map with the engines' accessor vocabulary and builds it at the edge, so the pack's
 * wire shape has one definition:
 *
 *   preload('profile.lookup', { instances: 10 }, async (headers, body) => {
 *     const request = new AsyncHttpRequest(body);
 *     const profileId = request.pathParameter('id');   // from url: /api/profile/{id}
 *     const lang = request.queryParameter('lang');      // the first value
 *     for (const uploaded of request.files()) {         // an upload entry's files
 *       save(uploaded.name, uploaded.content);
 *     }
 *     return { profile_id: profileId, lang };
 *   });
 *
 * A reply's status and headers come from a returned `EventEnvelope`
 * (`new EventEnvelope().setStatus(201).setHeader('Location', url).setBody(result)`); an error is a
 * thrown `AppException(status, message)`.
 */
import { asText } from './envelope.js';
import { isMapping, QueryValues } from './rest-routing.js';

/**
 * One file of a multipart upload as the request map carries it: the name the client gave, the
 * declared content type, the size, the form field it came in (the upload tag) and the bytes.
 */
export interface UploadedFile {
  name: string;
  contentType: string;
  size: number;
  tag: string;
  content: Buffer;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => asText(item)) : [];
}

function textMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (isMapping(value)) {
    for (const [key, item] of Object.entries(value)) {
      result[key] = asText(item);
    }
  }
  return result;
}

/** The engines' request model over the map a REST entry delivers. */
export class AsyncHttpRequest {
  private _method?: string;
  private _url?: string;
  private _host?: string;
  private _headers: Record<string, string> = {};
  private _body: unknown = undefined;
  private _hasBody = false;
  private _query: QueryValues = {};
  private _path: Record<string, string> = {};
  private _cookies: Record<string, string> = {};
  private _session: Record<string, string> = {};
  private _ip?: string;
  private _https?: boolean;
  private _timeout?: number;
  private _queryString?: string;
  private _fileNames: string[] = [];
  private _fileTypes: string[] = [];
  private _fileSizes: number[] = [];
  private _uploadTags: string[] = [];
  private _contents: Buffer[] = [];
  private _contentLength?: number;

  constructor(data?: unknown) {
    if (isMapping(data)) {
      this.read(data);
    }
  }

  private read(data: Record<string, unknown>): void {
    this._method = text(data.method);
    this._url = text(data.url);
    this._host = text(data.host);
    this._ip = text(data.ip);
    this._https = typeof data.https === 'boolean' ? data.https : undefined;
    this._timeout = integer(data.timeout);
    this._queryString = text(data.query);
    if ('body' in data) {
      this._body = data.body;
      this._hasBody = true;
    }
    this._headers = textMap(data.headers);
    this._cookies = textMap(data.cookies);
    this._session = textMap(data.session);
    const parameters = data.parameters;
    if (isMapping(parameters)) {
      const query = parameters.query;
      if (isMapping(query)) {
        for (const [key, value] of Object.entries(query)) {
          this._query[key] = Array.isArray(value) ? value.map((v) => asText(v)) : asText(value);
        }
      }
      this._path = textMap(parameters.path);
    }
    this._fileNames = textList(data.filename);
    this._fileTypes = textList(data.file_type);
    const sizes = data.file_length;
    this._fileSizes = Array.isArray(sizes)
      ? sizes.filter((v): v is number => integer(v) !== undefined) : [];
    this._uploadTags = textList(data.upload);
    const contents = data.contents;
    this._contents = Array.isArray(contents)
      ? contents.filter((c): c is Uint8Array => c instanceof Uint8Array).map((c) => Buffer.from(c)) : [];
    this._contentLength = integer(data.size);
  }

  // ---- the wire shape ----

  /**
   * The engines' `toMap()` shape: `parameters` always carries both sub-maps, `cookies` and `session`
   * appear only when present, a body set to null stays on the wire, and an upload's files ride as
   * the engines' parallel lists plus `contents`.
   */
  toMap(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (this._method !== undefined) {
      result.method = this._method;
    }
    if (this._url !== undefined) {
      result.url = this._url;
    }
    if (this._host !== undefined) {
      result.host = this._host;
    }
    if (Object.keys(this._headers).length) {
      result.headers = { ...this._headers };
    }
    if (this._hasBody) {
      result.body = this._body === undefined ? null : this._body;
    }
    if (this._ip !== undefined) {
      result.ip = this._ip;
    }
    if (this._https !== undefined) {
      result.https = this._https;
    }
    if (this._timeout !== undefined) {
      result.timeout = this._timeout;
    }
    if (this._queryString !== undefined) {
      result.query = this._queryString;
    }
    if (Object.keys(this._cookies).length) {
      result.cookies = { ...this._cookies };
    }
    if (Object.keys(this._session).length) {
      result.session = { ...this._session };
    }
    if (this._fileNames.length) {
      result.filename = [...this._fileNames];
      result.file_type = [...this._fileTypes];
      result.file_length = [...this._fileSizes];
    }
    if (this._contentLength !== undefined) {
      result.size = this._contentLength;
    }
    if (this._uploadTags.length) {
      result.upload = [...this._uploadTags];
    }
    if (this._contents.length) {
      result.contents = [...this._contents];
    }
    const query: QueryValues = {};
    for (const [key, value] of Object.entries(this._query)) {
      query[key] = Array.isArray(value) ? [...value] : value;
    }
    result.parameters = { query, path: { ...this._path } };
    return result;
  }

  // ---- reading ----

  get method(): string {
    return this._method || 'GET';
  }

  get url(): string {
    return this._url || '/';
  }

  get targetHost(): string | undefined {
    return this._host;
  }

  get headers(): Record<string, string> {
    return { ...this._headers };
  }

  header(name: string): string | undefined {
    const lowered = name.toLowerCase();
    for (const [key, value] of Object.entries(this._headers)) {
      if (key.toLowerCase() === lowered) {
        return value;
      }
    }
    return undefined;
  }

  get body(): unknown {
    return this._hasBody ? this._body : null;
  }

  get pathParameters(): Record<string, string> {
    return { ...this._path };
  }

  pathParameter(name: string): string | undefined {
    return this._path[name];
  }

  get queryParametersMap(): QueryValues {
    const result: QueryValues = {};
    for (const [key, value] of Object.entries(this._query)) {
      result[key] = Array.isArray(value) ? [...value] : value;
    }
    return result;
  }

  /** The first value of a query parameter. */
  queryParameter(name: string): string | undefined {
    const value = this._query[name];
    if (Array.isArray(value)) {
      return value.length ? value[0] : undefined;
    }
    return value;
  }

  /** Every value of a repeated query parameter. */
  queryParameters(name: string): string[] {
    const value = this._query[name];
    if (value === undefined) {
      return [];
    }
    return Array.isArray(value) ? [...value] : [value];
  }

  get cookies(): Record<string, string> {
    return { ...this._cookies };
  }

  cookie(name: string): string | undefined {
    return this._cookies[name];
  }

  get session(): Record<string, string> {
    return { ...this._session };
  }

  sessionInfo(name: string): string | undefined {
    return this._session[name];
  }

  get remoteIp(): string | undefined {
    return this._ip;
  }

  get isSecure(): boolean {
    return Boolean(this._https);
  }

  /** The entry's timeout in seconds; a caller-sent `x-ttl` (milliseconds) wins. */
  get timeoutSeconds(): number | undefined {
    const ttl = this.header('x-ttl');
    if (ttl !== undefined) {
      const trimmed = ttl.trim();
      if (/^[+-]?\d+$/.test(trimmed)) {
        return Math.max(1, Math.floor(Number.parseInt(trimmed, 10) / 1000));
      }
    }
    return this._timeout;
  }

  get queryString(): string | undefined {
    return this._queryString;
  }

  /** True for a multipart upload that carried files. */
  get isFile(): boolean {
    return this._fileNames.length > 0;
  }

  /** The files of an upload, in the order they arrived. */
  files(): UploadedFile[] {
    const count = Math.min(this._fileNames.length, this._contents.length);
    const result: UploadedFile[] = [];
    for (let i = 0; i < count; i++) {
      result.push({
        name: this._fileNames[i],
        contentType: i < this._fileTypes.length ? this._fileTypes[i] : 'application/octet-stream',
        size: i < this._fileSizes.length ? this._fileSizes[i] : this._contents[i].length,
        tag: i < this._uploadTags.length ? this._uploadTags[i] : 'file',
        content: this._contents[i]
      });
    }
    return result;
  }

  get fileNames(): string[] {
    return [...this._fileNames];
  }

  get fileContentTypes(): string[] {
    return [...this._fileTypes];
  }

  get fileSizes(): number[] {
    return [...this._fileSizes];
  }

  get uploadTags(): string[] {
    return [...this._uploadTags];
  }

  /** The bytes of the files of an upload, together (the engines' `size`). */
  get contentLength(): number | undefined {
    return this._contentLength;
  }

  // ---- building (the edge) ----

  setMethod(method: string): this {
    this._method = method;
    return this;
  }

  setUrl(url: string): this {
    this._url = url;
    return this;
  }

  setTargetHost(host: string): this {
    this._host = host;
    return this;
  }

  setHeader(name: string, value: string): this {
    const lowered = name.toLowerCase();
    const kept: Record<string, string> = {};
    for (const [key, item] of Object.entries(this._headers)) {
      if (key.toLowerCase() !== lowered) {
        kept[key] = item;
      }
    }
    kept[name] = value;
    this._headers = kept;
    return this;
  }

  setBody(body: unknown): this {
    this._body = body;
    this._hasBody = true;
    return this;
  }

  setQueryParameter(name: string, value: string | string[]): this {
    this._query[name] = Array.isArray(value) ? [...value] : value;
    return this;
  }

  setPathParameter(name: string, value: string): this {
    this._path[name] = value;
    return this;
  }

  setCookie(name: string, value: string): this {
    this._cookies[name] = value;
    return this;
  }

  setSessionInfo(name: string, value: string): this {
    this._session[name] = value;
    return this;
  }

  setRemoteIp(ip: string): this {
    this._ip = ip;
    return this;
  }

  setSecure(https: boolean): this {
    this._https = https;
    return this;
  }

  setTimeoutSeconds(seconds: number): this {
    this._timeout = seconds;
    return this;
  }

  setQueryString(query: string): this {
    this._queryString = query;
    return this;
  }

  /** One uploaded file: the engines' parallel lists grow together and `size` counts the bytes of them all. */
  addFile(name: string, contentType: string, content: Uint8Array, tag = 'file'): this {
    const bytes = Buffer.from(content);
    this._fileNames.push(name);
    this._fileTypes.push(contentType);
    this._fileSizes.push(bytes.length);
    this._uploadTags.push(tag);
    this._contents.push(bytes);
    this._contentLength = (this._contentLength ?? 0) + bytes.length;
    return this;
  }

  setContentLength(size: number): this {
    this._contentLength = size;
    return this;
  }
}
