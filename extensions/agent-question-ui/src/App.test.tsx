import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { NONE } from './auth';
import { fakeFetch, fakeResponse, frame, headerOf, pushStream, row } from './test/fixtures';
import type { Row } from './types';

const OPEN = row({ id: 5, seq: 7, correlation_id: 'c-3', description: 'Order assistant' });
const CLOSED = row({ id: 1, seq: 3, state: 'answered', correlation_id: 'c-1', description: 'Refund assistant', answered_by: 'operator-2', answered_at: '2026-11-20T07:00:00.000Z', outcome: { status: 200, body: { type: 'resumed' } } });
const OLDER = row({ id: 7, seq: 1, state: 'expired', correlation_id: 'c-0', description: 'Shipping assistant' });

interface Backend {
  fetch: typeof fetch;
  calls: ReturnType<typeof fakeFetch>['calls'];
  stream: ReturnType<typeof pushStream>;
  decided: Row | null;
}

function backend(firstPage: Row[], older: Row[] = [], auth: 'none' | 'oauth2' = 'none'): Backend {
  const stream = pushStream();
  const state: Backend = { fetch: null as unknown as typeof fetch, calls: [], stream, decided: null };
  const { fetch, calls } = fakeFetch((url, init) => {
    if (url.pathname === '/questions/config') {
      return fakeResponse({ body: auth === 'none' ? { auth, title: 'Agent questions' } : { auth, title: 'Agent questions', oauth2: { issuer: 'http://issuer.test', client_id: 'ui', scopes: 'openid', audience: '' } } });
    }
    if (url.pathname === '/questions/events') return fakeResponse({ stream: stream.stream });
    if (url.pathname === '/questions' && url.searchParams.has('before')) {
      const before = url.searchParams.get('before');
      if (before === '') return fakeResponse({ body: { rows: firstPage, next: firstPage.at(-1)?.seq ?? null, more: older.length > 0, before: null } });
      return fakeResponse({ body: { rows: older, next: older.at(-1)?.seq ?? null, more: false, before: Number(before) } });
    }
    const decide = /^\/questions\/(\d+)\/decide$/.exec(url.pathname);
    if (decide && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { decisions: unknown[]; decided_by?: string };
      state.decided = row({ ...OPEN, seq: 9, state: 'answered', answered_by: body.decided_by ?? 'someone', answered_at: '2026-11-20T08:20:00.000Z', decisions: body.decisions as Row['decisions'], outcome: { status: 200, body: { type: 'resumed' } } });
      return fakeResponse({ body: { row: state.decided, outcome: { status: 200, body: { type: 'resumed' } } } });
    }
    if (url.pathname === '/transcripts') return fakeResponse({ body: { conversations: [], next: null, more: false } });
    if (url.pathname === '/info') return fakeResponse({ body: { app: { name: 'agent-question' } } });
    return fakeResponse({ status: 404, body: { message: `no ${url.pathname}` } });
  });
  state.fetch = fetch;
  state.calls = calls;
  return state;
}

const tab = (name: RegExp) => screen.getByRole('button', { name });

describe('App', () => {
  it('loads the newest page, shows what waits, keeps the history and follows the stream', async () => {
    const be = backend([OPEN, CLOSED], [OLDER]);
    render(<App fetchImpl={be.fetch} establishSession={async () => NONE} />);
    expect(await screen.findByText('Order assistant')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agent questions');
    expect(tab(/Waiting for you/)).toHaveTextContent('1');
    expect(screen.queryByText('Refund assistant')).toBeNull();
    // the stream opened from the newest sequence of the page
    await vi.waitFor(() => expect(be.calls.some((c) => c.url === '/questions/events')).toBe(true));
    const streamCall = be.calls.find((c) => c.url === '/questions/events')!;
    expect(headerOf(streamCall.init, 'last-event-id')).toBe('7');
    expect(await screen.findByTestId('status')).toHaveTextContent('connected');
    // an advice arrives on the open case: it asks for attention until seen
    be.stream.push(frame(row({ id: 9, seq: 8, kind: 'advice', state: null, ticket: null, link: null, calls: null, correlation_id: 'c-3', summary: 'The model is waiting' })));
    expect(await screen.findByText('The model is waiting')).toBeTruthy();
    expect(document.title).toBe('(2) Agent questions');
    expect(JSON.parse(window.localStorage.getItem('agent-question.seen')!)).toEqual({ upTo: 7, ids: [] });
    // the history holds the closed case and loads the older page on demand
    fireEvent.click(tab(/History/));
    expect(await screen.findByText('Refund assistant')).toBeTruthy();
    expect(screen.queryByText('Shipping assistant')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('Shipping assistant')).toBeTruthy();
    expect(be.calls.some((c) => c.url === '/questions?before=3&limit=100')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  it('keeps a case whose advices are unseen until the person marks it, and never an older page\'s advice', async () => {
    const oldAdvice = row({ id: 8, seq: 2, kind: 'advice', state: null, ticket: null, link: null, calls: null, correlation_id: 'c-9', description: 'An old notice', summary: 'Long ago' });
    const be = backend([CLOSED], [oldAdvice]);
    render(<App fetchImpl={be.fetch} establishSession={async () => NONE} />);
    expect(await screen.findByText('Nothing waits for you.')).toBeTruthy();
    be.stream.push(frame(row({ id: 11, seq: 9, kind: 'advice', state: null, ticket: null, link: null, calls: null, correlation_id: 'c-5', description: 'Status assistant', summary: 'Come back tomorrow' })));
    expect(await screen.findByText('Come back tomorrow')).toBeTruthy();
    expect(tab(/Waiting for you/)).toHaveTextContent('1');
    fireEvent.click(tab(/History/));
    fireEvent.click(await screen.findByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('Long ago')).toBeTruthy(); // in the history, not asking for attention
    fireEvent.click(tab(/Waiting for you/));
    expect(screen.queryByText('Long ago')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Seen' }));
    expect(await screen.findByText('Nothing waits for you.')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('agent-question.seen')!)).toEqual({ upTo: 3, ids: [11] });
    expect(document.title).toBe('Agent questions');
  });

  it('marks every notice seen at once and leaves the cases that wait for a decision', async () => {
    const be = backend([OPEN]);
    render(<App fetchImpl={be.fetch} establishSession={async () => NONE} />);
    await screen.findByText('Order assistant');
    for (const n of [1, 2, 3]) {
      be.stream.push(frame(row({ id: 20 + n, seq: 10 + n, kind: 'advice', state: null, ticket: null, link: null, calls: null, correlation_id: `n-${n}`, description: `Notice ${n}`, summary: `Batch ${n} done` })));
    }
    expect(await screen.findByText('Batch 3 done')).toBeTruthy();
    expect(tab(/Waiting for you/)).toHaveTextContent('4'); // one open card, three unseen notices
    fireEvent.click(screen.getByRole('button', { name: 'Mark all 3 notices as seen' }));
    await vi.waitFor(() => expect(screen.queryByText('Batch 1 done')).toBeNull());
    expect(screen.getByText('Order assistant')).toBeTruthy();
    expect(tab(/Waiting for you/)).toHaveTextContent('1');
    expect(JSON.parse(window.localStorage.getItem('agent-question.seen')!).ids.sort()).toEqual([21, 22, 23]);
  });

  it('sends a decision under the typed name and moves the case to the history', async () => {
    const be = backend([OPEN]);
    render(<App fetchImpl={be.fetch} establishSession={async () => NONE} />);
    const card = (await screen.findByText('Order assistant')).closest('section')!;
    fireEvent.change(screen.getByLabelText('your name'), { target: { value: 'operator-1' } });
    fireEvent.click(within(card).getByLabelText(/approve/));
    fireEvent.click(within(card).getByLabelText('yes'));
    fireEvent.click(within(card).getByRole('button', { name: 'Send the decision' }));
    await vi.waitFor(() => expect(be.decided).not.toBeNull());
    const sent = be.calls.find((c) => c.url === '/questions/5/decide')!;
    expect(JSON.parse(String(sent.init?.body))).toEqual({
      decisions: [{ id: 'toolu_01A', approved: true }, { id: 'toolu_01B', answer: 'yes' }],
      decided_by: 'operator-1'
    });
    expect(await screen.findByText('Nothing waits for you.')).toBeTruthy();
    fireEvent.click(tab(/History/));
    expect(await screen.findByText(/decided by operator-1/)).toBeTruthy();
    expect(document.title).toBe('Agent questions');
  });

  it('shows the person the issuer named and no name field under oauth2', async () => {
    const be = backend([], [], 'oauth2');
    render(<App fetchImpl={be.fetch} establishSession={async () => ({ mode: 'oauth2', who: 'operator-7', headers: async () => ({ authorization: 'Bearer at' }) })} />);
    expect(await screen.findByText('operator-7')).toBeTruthy();
    expect(screen.queryByLabelText('your name')).toBeNull();
    await vi.waitFor(() => expect(be.calls.some((c) => c.url.startsWith('/questions?before='))).toBe(true));
    const page = be.calls.find((c) => c.url.startsWith('/questions?before='))!;
    expect(headerOf(page.init, 'authorization')).toBe('Bearer at');
    expect(headerOf(be.calls[0].init, 'authorization')).toBeUndefined(); // the configuration is open
  });

  it('tells when the backend cannot be reached', async () => {
    const { fetch } = fakeFetch(() => fakeResponse({ status: 503, body: { message: 'the question record is not available' } }));
    render(<App fetchImpl={fetch} establishSession={async () => NONE} />);
    expect(await screen.findByText(/the question record is not available/)).toBeTruthy();
  });

  it('offers the host\'s actuator endpoints as a menu', async () => {
    const be = backend([OPEN]);
    render(<App fetchImpl={be.fetch} establishSession={async () => NONE} />);
    await screen.findByText('Order assistant');
    fireEvent.click(tab(/^Actuator$/));
    await vi.waitFor(() => expect(be.calls.some((c) => c.url === '/info')).toBe(true));
    expect(screen.getByRole('group', { name: 'actuator endpoints' })).toBeTruthy();
    for (const name of ['Info', 'Services', 'Health', 'Environment', 'Liveness probe']) expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('opens the transcripts filtered by the case a person picks', async () => {
    const be = backend([OPEN]);
    render(<App fetchImpl={be.fetch} establishSession={async () => NONE} />);
    await screen.findByText('Order assistant');
    fireEvent.click(screen.getByRole('button', { name: 'transcripts' }));
    expect((await screen.findByLabelText('correlation id')) as HTMLInputElement).toHaveValue('c-3');
    await vi.waitFor(() => expect(be.calls.some((c) => c.url === '/transcripts?limit=50&correlation_id=c-3')).toBe(true));
    expect(await screen.findByText('No transcript matches.')).toBeTruthy();
  });
});
