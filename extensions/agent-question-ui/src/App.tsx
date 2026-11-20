import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Api, ApiError } from './api';
import { establish, type Session } from './auth';
import { groupCases, maxSeq, mergeRows, openCount, split } from './model';
import type { Decision, Row, UiConfig } from './types';
import { AtomIcon } from './components/AtomIcon';
import { History, Questions } from './components/Cases';
import { Transcripts } from './components/Transcripts';
import { Actuator } from './components/Actuator';

type Tab = 'questions' | 'history' | 'transcripts' | 'actuator';
type Phase = { kind: 'loading' } | { kind: 'signing-in' } | { kind: 'ready'; config: UiConfig; session: Session } | { kind: 'failed'; message: string };

const FIRST_PAGE = 100;
const NAME_KEY = 'agent-question.name';

function storedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export interface AppProps {
  fetchImpl?: typeof fetch;
  establishSession?: (config: UiConfig) => Promise<Session>;
}

export default function App({ fetchImpl, establishSession = establish }: AppProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('questions');
  const [rows, setRows] = useState<Map<number, Row>>(() => new Map());
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [historyMore, setHistoryMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [name, setName] = useState(storedName);
  const [correlationId, setCorrelationId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);

  const api = useMemo(() => new Api(async () => (sessionRef.current ? sessionRef.current.headers() : {}), fetchImpl), [fetchImpl]);

  // the configuration, the sign-in, the newest page of the record, then the stream from where that page ended
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const config = await api.config();
        if (controller.signal.aborted) return;
        document.title = config.title;
        if (config.auth === 'oauth2') setPhase({ kind: 'signing-in' });
        const session = await establishSession(config);
        if (controller.signal.aborted) return;
        sessionRef.current = session;
        setPhase({ kind: 'ready', config, session });
        const first = await api.before(null, FIRST_PAGE);
        if (controller.signal.aborted) return;
        let held = mergeRows(new Map(), first.rows);
        setRows(held);
        setHistoryNext(first.next);
        setHistoryMore(first.more);
        const cursor = maxSeq(held.values());
        void api.stream(cursor, (row) => {
          held = mergeRows(held, [row]);
          setRows(held);
        }, setStatus, controller.signal).catch((error: unknown) => {
          if (!controller.signal.aborted) setProblem(error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => controller.abort();
  }, [api, establishSession]);

  const loadOlder = useCallback(async () => {
    if (!historyMore || historyLoading) return;
    setHistoryLoading(true);
    try {
      const page = await api.before(historyNext, FIRST_PAGE);
      setRows((held) => mergeRows(held, page.rows));
      setHistoryNext(page.next);
      setHistoryMore(page.more);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [api, historyMore, historyLoading, historyNext]);

  const decide = useCallback(async (row: Row, decisions: Decision[]) => {
    const who = sessionRef.current?.mode === 'none' ? name.trim() || undefined : undefined;
    const result = await api.decide(row.id, decisions, who);
    setRows((held) => mergeRows(held, [result.row]));
    if (result.outcome.status !== null && result.outcome.status >= 400) {
      const body = result.outcome.body as { message?: unknown; type?: unknown } | null;
      const text = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : `the engine answered ${result.outcome.status}`;
      throw new ApiError(result.outcome.status, text);
    }
  }, [api, name]);

  const showTranscripts = useCallback((value: string) => {
    setCorrelationId(value);
    setTab('transcripts');
  }, []);

  const cases = useMemo(() => groupCases(rows.values()), [rows]);
  const { waiting, history } = useMemo(() => split(cases), [cases]);
  const open = openCount(waiting);
  useEffect(() => {
    if (phase.kind === 'ready') document.title = `${open ? `(${open}) ` : ''}${phase.config.title}`;
  }, [open, phase]);

  const rename = (value: string) => {
    setName(value);
    try {
      window.localStorage.setItem(NAME_KEY, value);
    } catch {
      // a browser without storage keeps the name for the page's life
    }
  };

  if (phase.kind === 'loading' || phase.kind === 'signing-in') {
    return (
      <div className="app">
        <header className="top"><AtomIcon className="mark" /><h1>Agent questions</h1></header>
        <main><div className="empty">{phase.kind === 'signing-in' ? 'Signing you in...' : 'Loading...'}</div></main>
      </div>
    );
  }
  if (phase.kind === 'failed') {
    return (
      <div className="app">
        <header className="top"><AtomIcon className="mark" /><h1>Agent questions</h1></header>
        <main><div className="notice error">The backend could not be reached - {phase.message}</div></main>
      </div>
    );
  }
  const { config, session } = phase;
  return (
    <div className="app">
      <header className="top">
        <AtomIcon className="mark" />
        <h1>{config.title}</h1>
        <span className="spacer" />
        {session.mode === 'none' ? (
          <label className="meta">
            your name{' '}
            <input type="text" value={name} placeholder="as the model will see it" onChange={(event) => rename(event.target.value)} aria-label="your name" />
          </label>
        ) : (
          <>
            <span className="meta">{session.who ?? 'signed in'}</span>
            {session.signOut && <button type="button" onClick={() => void session.signOut?.()}>Sign out</button>}
          </>
        )}
        <span className="meta" data-testid="status">{status}</span>
      </header>
      <nav className="tabs" aria-label="panels">
        <button type="button" className={tab === 'questions' ? 'active' : ''} onClick={() => setTab('questions')}>
          Waiting for you {open > 0 && <span className="count">{open}</span>}
        </button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History {history.length > 0 && <span className="count quiet">{history.length}</span>}
        </button>
        <button type="button" className={tab === 'transcripts' ? 'active' : ''} onClick={() => setTab('transcripts')}>Transcripts</button>
        <button type="button" className={tab === 'actuator' ? 'active' : ''} onClick={() => setTab('actuator')}>Actuator</button>
      </nav>
      <main>
        {problem && <div className="notice error" role="alert">{problem} <button type="button" onClick={() => setProblem(null)}>dismiss</button></div>}
        {tab === 'questions' && <Questions waiting={waiting} onDecide={decide} onTranscripts={showTranscripts} />}
        {tab === 'history' && <History history={history} more={historyMore} loading={historyLoading} onMore={() => void loadOlder()} onTranscripts={showTranscripts} />}
        {tab === 'transcripts' && <Transcripts api={api} correlationId={correlationId} onCorrelationId={setCorrelationId} />}
        {tab === 'actuator' && <Actuator api={api} />}
      </main>
    </div>
  );
}
