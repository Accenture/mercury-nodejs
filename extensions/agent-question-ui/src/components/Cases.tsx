import { useEffect, useRef } from 'react';
import type { Case } from '../model';
import type { Decision, Row } from '../types';
import { Card } from './Card';

export interface CaseViewProps {
  item: Case;
  onDecide?: (row: Row, decisions: Decision[]) => Promise<void>;
  onTranscripts?: (correlationId: string) => void;
  /** When given, the case has advices this device has not seen and no open card: the person can mark it seen. */
  onSeen?: () => void;
}

/** One case: the use case, the graph and the correlation id, and its cards oldest first. */
export function CaseView({ item, onDecide, onTranscripts, onSeen }: CaseViewProps) {
  return (
    <section className="case">
      <h2>{item.description}</h2>
      <div className="meta">
        {item.graph_id} · {item.correlation_id}
        {onTranscripts && (
          <>
            {' · '}
            <button type="button" className="link" onClick={() => onTranscripts(item.correlation_id)}>transcripts</button>
          </>
        )}
      </div>
      {item.rows.map((row) => <Card key={row.id} row={row} onDecide={onDecide} />)}
      {onSeen && (
        <div className="seen">
          <button type="button" onClick={onSeen}>Seen</button>
          <span className="meta"> nothing waits here any more - move the case to the history</span>
        </div>
      )}
    </section>
  );
}

export interface QuestionsProps {
  waiting: Case[];
  onDecide: (row: Row, decisions: Decision[]) => Promise<void>;
  onTranscripts: (correlationId: string) => void;
  onSeen: (items: Case[]) => void;
}

/**
 * The question-and-answer panel: every case with a card that waits for the person, or an advice not yet seen. The
 * cases that only carry notices can be marked seen one by one or all at once - a channel's history of a hundred
 * advices arriving on a device that has not looked for a while asks for one click, not a hundred.
 */
export function Questions({ waiting, onDecide, onTranscripts, onSeen }: QuestionsProps) {
  if (waiting.length === 0) return <div className="empty">Nothing waits for you.</div>;
  const notices = waiting.filter((item) => item.open === 0);
  return (
    <>
      {notices.length > 1 && (
        <div className="seen-all">
          <button type="button" onClick={() => onSeen(notices)}>Mark all {notices.length} notices as seen</button>
          <span className="meta"> the cases that wait for a decision stay</span>
        </div>
      )}
      {waiting.map((item) => (
        <CaseView key={item.key} item={item} onDecide={onDecide} onTranscripts={onTranscripts} onSeen={item.open === 0 ? () => onSeen([item]) : undefined} />
      ))}
    </>
  );
}

export interface HistoryProps {
  history: Case[];
  more: boolean;
  loading: boolean;
  onMore: () => void;
  onTranscripts: (correlationId: string) => void;
}

/** The history: the closed cases in a viewport that loads older pages of the record as the person scrolls to its end. */
export function History({ history, more, loading, onMore, onTranscripts }: HistoryProps) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !more || loading || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onMore();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, loading, onMore, history.length]);
  return (
    <div className="viewport" data-testid="history">
      {history.length === 0 && !loading && <div className="empty">Nothing yet.</div>}
      {history.map((item) => <CaseView key={item.key} item={item} onTranscripts={onTranscripts} />)}
      {loading && <div className="loading">Loading older rows...</div>}
      {more && !loading && (
        <div className="loading">
          <button type="button" onClick={onMore}>Load older</button>
        </div>
      )}
      <div className="sentinel" ref={sentinel} />
    </div>
  );
}
