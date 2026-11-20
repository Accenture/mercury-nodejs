import { useCallback, useEffect, useState } from 'react';
import type { Api } from '../api';
import { shortTime } from '../model';
import type { Conversation, Transcript } from '../types';

export interface TranscriptsProps {
  api: Api;
  /** A correlation id a case asked for; the filter follows it. */
  correlationId: string;
  onCorrelationId: (value: string) => void;
}

function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

/** The transcript audit store: the conversations newest first with filters and older pages, and one conversation's turns. */
export function Transcripts({ api, correlationId, onCorrelationId }: TranscriptsProps) {
  const [graphId, setGraphId] = useState('');
  const [rows, setRows] = useState<Conversation[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<Transcript | null>(null);

  const load = useCallback(async (before: string | null, replace: boolean) => {
    setLoading(true);
    setProblem(null);
    try {
      const page = await api.transcripts({ before, limit: 50, correlation_id: correlationId || undefined, graph_id: graphId || undefined });
      setRows((held) => (replace ? page.conversations : [...held, ...page.conversations]));
      setNext(page.next);
      setMore(page.more);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [api, correlationId, graphId]);

  useEffect(() => {
    setSelected(null);
    void load(null, true);
  }, [load]);

  const open = async (conversation: string) => {
    setProblem(null);
    try {
      setSelected(await api.transcript(conversation));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  if (selected) {
    const c = selected.conversation;
    return (
      <div>
        <button type="button" className="back" onClick={() => setSelected(null)}>← all conversations</button>
        <section className="case">
          <h2>{c.graph_id ?? 'a direct call'} · {c.node ?? '-'}</h2>
          <div className="meta">
            <code className="id">{c.conversation}</code> · {c.correlation_id ?? 'no correlation id'} · {c.model} · {c.status} · {c.turns} turn(s) ·
            {' '}{c.input_tokens + c.output_tokens} tokens · started {shortTime(c.started_at)}
          </div>
          {c.system && (
            <details>
              <summary>system prompt</summary>
              <pre>{c.system}</pre>
            </details>
          )}
          {c.tools !== undefined && c.tools !== null && (
            <details>
              <summary>tool catalog</summary>
              <Json value={c.tools} />
            </details>
          )}
        </section>
        {selected.turns.map((turn) => (
          <section className="turn" key={turn.turn}>
            <h3>
              turn {turn.turn}
              <span className="meta">{turn.status}{turn.stop_reason ? ` · ${turn.stop_reason}` : ''} · {turn.input_tokens}+{turn.output_tokens} tokens · {shortTime(turn.started_at)}</span>
            </h3>
            {turn.trace_id && <div className="meta">trace {turn.trace_id} · {turn.trace_path}</div>}
            <details open>
              <summary>request</summary>
              <Json value={turn.request} />
            </details>
            <details open>
              <summary>response</summary>
              <Json value={turn.response} />
            </details>
            {turn.calls !== null && turn.calls !== undefined && (
              <details>
                <summary>tool calls</summary>
                <Json value={turn.calls} />
              </details>
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="filters">
        <input type="text" placeholder="correlation id" value={correlationId} onChange={(event) => onCorrelationId(event.target.value)} aria-label="correlation id" />
        <input type="text" placeholder="graph id" value={graphId} onChange={(event) => setGraphId(event.target.value)} aria-label="graph id" />
        <span className="meta">{rows.length} conversation(s){more ? ', more below' : ''}</span>
      </div>
      {problem && <div className="notice error">{problem}</div>}
      {rows.length === 0 && !loading && <div className="empty">No transcript matches.</div>}
      {rows.length > 0 && (
        <table className="conversations">
          <thead>
            <tr><th>started</th><th>graph · node</th><th>correlation id</th><th>model</th><th>status</th><th>turns</th><th>tokens</th></tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.conversation} className="row" onClick={() => void open(c.conversation)}>
                <td>{shortTime(c.started_at)}</td>
                <td>{c.graph_id ?? '-'} · {c.node ?? '-'}</td>
                <td>{c.correlation_id ?? '-'}</td>
                <td>{c.model}</td>
                <td>{c.status}</td>
                <td>{c.turns}</td>
                <td>{c.input_tokens + c.output_tokens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {loading && <div className="loading">Loading...</div>}
      {more && !loading && (
        <div className="loading">
          <button type="button" onClick={() => void load(next, false)}>Load older</button>
        </div>
      )}
    </div>
  );
}
