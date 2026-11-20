import { describe, expect, it } from 'vitest';
import { Api, ApiError } from './api';
import { fakeFetch, fakeResponse, frame, headerOf, pushStream, row } from './test/fixtures';

const bearer = async () => ({ authorization: 'Bearer t-0k' });

describe('Api', () => {
  it('reads the configuration without a bearer and everything else with one', async () => {
    const { fetch, calls } = fakeFetch((url) => {
      if (url.pathname === '/questions/config') return fakeResponse({ body: { auth: 'none', title: 'Agent questions' } });
      return fakeResponse({ body: { rows: [], next: null, more: false, since: 0 } });
    });
    const api = new Api(bearer, fetch);
    expect((await api.config()).title).toBe('Agent questions');
    expect(headerOf(calls[0].init, 'authorization')).toBeUndefined();
    await api.since(7, 50);
    expect(calls[1].url).toBe('/questions?since=7&limit=50');
    expect(headerOf(calls[1].init, 'authorization')).toBe('Bearer t-0k');
    await api.before(null, 100);
    expect(calls[2].url).toBe('/questions?before=&limit=100');
    await api.before(12);
    expect(calls[3].url).toBe('/questions?before=12&limit=100');
  });

  it('posts a decision with the name the person typed and reads the row back', async () => {
    const decided = row({ id: 4, seq: 9, state: 'answered', answered_by: 'operator-1' });
    const { fetch, calls } = fakeFetch(() => fakeResponse({ body: { row: decided, outcome: { status: 200, body: { type: 'resumed' } } } }));
    const api = new Api(async () => ({}), fetch);
    const result = await api.decide(4, [{ id: 'toolu_01A', approved: true }], 'operator-1');
    expect(calls[0].url).toBe('/questions/4/decide');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ decisions: [{ id: 'toolu_01A', approved: true }], decided_by: 'operator-1' });
    expect(result.row.state).toBe('answered');
    expect(result.outcome.status).toBe(200);
  });

  it('builds the transcript queries and encodes the conversation id', async () => {
    const { fetch, calls } = fakeFetch(() => fakeResponse({ body: { conversations: [], next: null, more: false } }));
    const api = new Api(bearer, fetch);
    await api.transcripts();
    await api.transcripts({ before: '2026-11-20T08:00:00.000Z', limit: 20, correlation_id: 'c 1', graph_id: 'g' });
    await api.transcript('0123456789abcdef0123456789abcdef');
    expect(calls.map((c) => c.url)).toEqual([
      '/transcripts',
      '/transcripts?before=2026-11-20T08%3A00%3A00.000Z&limit=20&correlation_id=c+1&graph_id=g',
      '/transcripts/0123456789abcdef0123456789abcdef'
    ]);
  });

  it("raises the backend's message with its status", async () => {
    const { fetch } = fakeFetch(() => fakeResponse({ status: 401, body: { type: 'error', status: 401, message: 'a bearer token is required' } }));
    const api = new Api(bearer, fetch);
    const error = await api.since(0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).message).toBe('a bearer token is required');
  });

  it('streams rows from the cursor, then reopens from the last sequence seen when the stream ends', async () => {
    const first = pushStream();
    const second = pushStream();
    let opened = 0;
    const { fetch, calls } = fakeFetch((url) => {
      expect(url.pathname).toBe('/questions/events');
      opened += 1;
      return fakeResponse({ stream: opened === 1 ? first.stream : second.stream });
    });
    const api = new Api(bearer, fetch, 0);
    const controller = new AbortController();
    const rows: number[] = [];
    const statuses: string[] = [];
    const done = api.stream(5, (r) => rows.push(r.seq), (s) => statuses.push(s), controller.signal);
    first.push(frame(row({ id: 1, seq: 6 })));
    first.push(`${frame(row({ id: 2, seq: 7 })).slice(0, 10)}`);
    first.push(frame(row({ id: 2, seq: 7 })).slice(10));
    first.push(': keep-alive\n\n');
    first.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(rows).toEqual([6, 7]);
    expect(calls.length).toBe(2);
    expect(headerOf(calls[0].init, 'last-event-id')).toBe('5');
    expect(headerOf(calls[1].init, 'last-event-id')).toBe('7');
    expect(headerOf(calls[1].init, 'authorization')).toBe('Bearer t-0k');
    expect(statuses).toEqual(['connected', 'reconnecting', 'connected']);
    controller.abort();
    await done;
    expect(second.cancelled()).toBe(true);
  });

  it('gives up the stream when the sign-in is gone', async () => {
    const { fetch } = fakeFetch(() => fakeResponse({ status: 401, body: { message: 'expired' } }));
    const api = new Api(bearer, fetch, 0);
    const error = await api.stream(0, () => {}, () => {}, new AbortController().signal).catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(401);
  });
});
