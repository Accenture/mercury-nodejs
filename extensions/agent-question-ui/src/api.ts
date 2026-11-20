// The agent-question backend's endpoints, called on the same origin the bundle is served from, every request under
// the session's headers (a bearer under oauth2, nothing under none).
import { readFrames } from './sse';
import type { ActuatorPath, ActuatorResult, Decision, Outcome, Page, Row, Transcript, TranscriptsPage, UiConfig } from './types';

export type HeaderSource = () => Promise<Record<string, string>>;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function failure(response: Response): Promise<ApiError> {
  let message = `${response.status}`;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (body && typeof body.message === 'string') message = body.message;
  } catch {
    // the status is the message
  }
  return new ApiError(response.status, message);
}

export class Api {
  constructor(
    private readonly headers: HeaderSource,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly retryMs = 2000
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(path, { headers: await this.headers(), credentials: 'same-origin' });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }

  /** The UI's configuration: open, read before any sign-in. */
  async config(): Promise<UiConfig> {
    const response = await this.fetchImpl('/questions/config', { credentials: 'same-origin' });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as UiConfig;
  }

  /** The replay: every row that changed since the cursor, oldest change first. */
  since(cursor: number, limit = 200): Promise<Page & { since: number }> {
    return this.get(`/questions?since=${cursor}&limit=${limit}`);
  }

  /** The history: the rows before the cursor (every row when null), newest change first, and the older page's cursor. */
  before(cursor: number | null, limit = 100): Promise<Page & { before: number | null }> {
    return this.get(`/questions?before=${cursor ?? ''}&limit=${limit}`);
  }

  /** The click: the decisions go to the reply endpoint through the backend; the row comes back as the record left it. */
  async decide(id: number, decisions: Decision[], decidedBy?: string): Promise<{ row: Row; outcome: Outcome }> {
    const body: Record<string, unknown> = { decisions };
    if (decidedBy) body.decided_by = decidedBy;
    const response = await this.fetchImpl(`/questions/${id}/decide`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(await this.headers()) },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as { row: Row; outcome: Outcome };
  }

  /** The transcript audit store's conversations, newest first. */
  transcripts(params: { before?: string | null; limit?: number; correlation_id?: string; graph_id?: string } = {}): Promise<TranscriptsPage> {
    const query = new URLSearchParams();
    if (params.before) query.set('before', params.before);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.correlation_id) query.set('correlation_id', params.correlation_id);
    if (params.graph_id) query.set('graph_id', params.graph_id);
    const text = query.toString();
    return this.get(`/transcripts${text ? `?${text}` : ''}`);
  }

  /**
   * One of the host's actuator endpoints, on the same origin as the backend - the engines' /info, /info/routes,
   * /health, /env and /livenessprobe, which stay at their paths beside the bundle for Kubernetes and operations.
   */
  async actuator(path: ActuatorPath): Promise<ActuatorResult> {
    const response = await this.fetchImpl(path, { headers: await this.headers(), credentials: 'same-origin' });
    const contentType = response.headers.get('content-type') ?? '';
    return { path, status: response.status, contentType, body: await response.text(), at: new Date().toISOString() };
  }

  /** One conversation with its turns. */
  transcript(conversation: string): Promise<Transcript> {
    return this.get(`/transcripts/${encodeURIComponent(conversation)}`);
  }

  /**
   * The stream, held until the signal aborts: rows since the cursor first, then every change the backend's feed
   * finds; a stream that ends or fails is reopened after a pause from the last sequence seen, so nothing is missed.
   */
  async stream(cursor: number, onRow: (row: Row) => void, onStatus: (status: 'connected' | 'reconnecting') => void, signal: AbortSignal): Promise<void> {
    let since = cursor;
    while (!signal.aborted) {
      try {
        const response = await this.fetchImpl('/questions/events', {
          credentials: 'same-origin',
          headers: { accept: 'text/event-stream', 'last-event-id': String(since), ...(await this.headers()) },
          signal
        });
        if (!response.ok || !response.body) throw await failure(response);
        onStatus('connected');
        await readFrames(response.body, (frame) => {
          if (frame.event !== 'question' || !frame.data) return;
          const row = JSON.parse(frame.data) as Row;
          since = Math.max(since, row.seq);
          onRow(row);
        }, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) throw error; // the sign-in is gone: the app handles it
      }
      if (signal.aborted) return;
      onStatus('reconnecting');
      await new Promise((resolveWait) => setTimeout(resolveWait, this.retryMs));
    }
  }
}
