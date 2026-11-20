import { useState, type FormEvent } from 'react';
import { outcomeText, shortTime } from '../model';
import type { Call, Decision, Row } from '../types';

function CallFields({ call, index }: { call: Call; index: number }) {
  const input = call.input ? <pre>{JSON.stringify(call.input, null, 2)}</pre> : null;
  if (call.ask) {
    const options = Array.isArray(call.input?.options) ? (call.input.options as unknown[]) : [];
    return (
      <fieldset data-id={call.id} data-kind="ask">
        <legend>{call.name ?? call.id} - a question</legend>
        {input}
        {options.map((option, k) => (
          <label key={String(option)}>
            <input type="radio" name={`a-${index}`} value={String(option)} defaultChecked={k === 0} /> {String(option)}
          </label>
        ))}
        {options.length > 0 && (
          <label>
            <input type="radio" name={`a-${index}`} value="__other__" /> another answer:
          </label>
        )}
        <textarea rows={2} placeholder="Your answer" />
      </fieldset>
    );
  }
  if (call.wait === false) {
    return (
      <fieldset>
        <legend>{call.name ?? call.id} - runs on resume</legend>
        {input}
      </fieldset>
    );
  }
  return (
    <fieldset data-id={call.id} data-kind="write">
      <legend>{call.name ?? call.id} - waits for a decision</legend>
      {call.route && <div className="meta">{call.route}</div>}
      {input}
      <label>
        <input type="radio" name={`d-${index}`} value="yes" /> approve
      </label>
      <label>
        <input type="radio" name={`d-${index}`} value="no" /> refuse
      </label>
      <input type="text" placeholder="A note for the model (optional)" />
    </fieldset>
  );
}

/** The decisions a submitted form holds, one per waiting call; null when a call is left undecided. */
export function decisionsOf(form: HTMLFormElement): Decision[] | null {
  const decisions: Decision[] = [];
  for (const set of form.querySelectorAll<HTMLFieldSetElement>('fieldset[data-id]')) {
    const id = set.dataset.id ?? '';
    if (set.dataset.kind === 'ask') {
      const picked = set.querySelector<HTMLInputElement>('input[type=radio]:checked');
      const text = set.querySelector<HTMLTextAreaElement>('textarea')?.value.trim() ?? '';
      decisions.push({ id, answer: picked && picked.value !== '__other__' ? picked.value : text });
    } else {
      const choice = set.querySelector<HTMLInputElement>('input[type=radio]:checked');
      if (!choice) return null;
      const note = set.querySelector<HTMLInputElement>('input[type=text]')?.value.trim() ?? '';
      const decision: Decision = { id, approved: choice.value === 'yes' };
      if (note) decision.note = note;
      decisions.push(decision);
    }
  }
  return decisions;
}

export interface CardProps {
  row: Row;
  onDecide?: (row: Row, decisions: Decision[]) => Promise<void>;
}

/** One row of a case: a wait with its form while open, its outcome after; an advice as a notice. */
export function Card({ row, onDecide }: CardProps) {
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const decisions = decisionsOf(event.currentTarget);
    if (!decisions) {
      setProblem('Approve or refuse every waiting call');
      return;
    }
    setProblem(null);
    setSending(true);
    try {
      await onDecide?.(row, decisions);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const state = row.state ?? '';
  return (
    <div className={`card ${state} ${row.kind}`} data-row={row.id}>
      <div className="head">
        <strong>{row.summary}</strong>
        <span className="meta">
          {row.kind}
          {row.turn !== null && ` · turn ${row.turn}`}
          {state && ` · ${state}`}
          {` · ${shortTime(row.updated_at)}`}
        </span>
      </div>
      {row.details && <p className="details">{row.details}</p>}
      {row.kind !== 'advice' && row.state === 'open' && (
        <form onSubmit={submit} data-decide={row.id}>
          {(row.calls ?? []).map((call, index) => <CallFields key={call.id} call={call} index={index} />)}
          <button className="primary" type="submit" disabled={sending}>{sending ? 'Sending...' : 'Send the decision'}</button>
          {row.expires_at && <div className="meta">expires {shortTime(row.expires_at)}</div>}
          {problem && <div className="meta" role="alert">{problem}</div>}
        </form>
      )}
      {row.kind !== 'advice' && row.state !== 'open' && (
        <div className="outcome">
          {row.answered_by && `decided by ${row.answered_by} at ${shortTime(row.answered_at)}`}
          {row.outcome && ` · ${outcomeText(row.outcome)}`}
        </div>
      )}
    </div>
  );
}
