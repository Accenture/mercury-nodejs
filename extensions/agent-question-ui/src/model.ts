// The pure half of the UI: rows merged by their change sequence, grouped into cases by graph and correlation id,
// split into what waits for the person and the history.
import type { Row } from './types';

export interface Case {
  key: string;
  graph_id: string;
  correlation_id: string;
  description: string;
  rows: Row[];
  newest: number;
  open: number;
}

/** The rows held, with the given ones merged in: a row's latest change (the higher sequence) wins. */
export function mergeRows(held: Map<number, Row>, rows: Row[]): Map<number, Row> {
  const merged = new Map(held);
  for (const row of rows) {
    const current = merged.get(row.id);
    if (!current || row.seq >= current.seq) merged.set(row.id, row);
  }
  return merged;
}

/**
 * The rows grouped by case - the graph and the correlation id - the cases newest activity first, each case's rows in
 * the order they were recorded (a wait keeps its place above the advices that follow it when its answer moves its
 * sequence).
 */
export function groupCases(rows: Iterable<Row>): Case[] {
  const groups = new Map<string, Case>();
  for (const row of rows) {
    const key = `${row.graph_id}\u0000${row.correlation_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, graph_id: row.graph_id, correlation_id: row.correlation_id, description: row.description, rows: [], newest: 0, open: 0 };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.newest = Math.max(group.newest, row.seq);
    if (row.state === 'open') group.open += 1;
  }
  const cases = [...groups.values()];
  for (const group of cases) group.rows.sort((a, b) => a.requested_at.localeCompare(b.requested_at) || a.id - b.id);
  return cases.sort((a, b) => b.newest - a.newest);
}

/**
 * What this device has seen: `seen` leaves the record (RFC-0014 round 4) and is the device's. An advice is unseen when
 * its change is later than the device's baseline `upTo` - set to the newest sequence the first page showed, so an older
 * page never floods the waiting panel - and the person has not marked its case seen (`ids`).
 */
export interface Seen {
  upTo: number;
  ids: ReadonlySet<number>;
}

export const NOTHING_SEEN: Seen = { upTo: 0, ids: new Set() };

export const unseenAdvices = (item: Case, seen: Seen): Row[] =>
  item.rows.filter((r) => r.kind === 'advice' && r.seq > seen.upTo && !seen.ids.has(r.id));

/** The cases with an open card, or an advice this device has not seen, wait for the person; the rest are the history. */
export function split(cases: Case[], seen: Seen = NOTHING_SEEN): { waiting: Case[]; history: Case[] } {
  const waits = (c: Case) => c.open > 0 || unseenAdvices(c, seen).length > 0;
  return { waiting: cases.filter(waits), history: cases.filter((c) => !waits(c)) };
}

/** What asks for attention: the open cards and the advices not yet seen. */
export const attentionCount = (cases: Case[], seen: Seen = NOTHING_SEEN): number =>
  cases.reduce((n, c) => n + c.open + unseenAdvices(c, seen).length, 0);

export const openCount = (cases: Case[]): number => cases.reduce((n, c) => n + c.open, 0);

export const maxSeq = (rows: Iterable<Row>): number => {
  let max = 0;
  for (const row of rows) max = Math.max(max, row.seq);
  return max;
};

/** A short local time for a card: `YYYY-MM-DD HH:MM:SS` from an ISO stamp, or the text as given. */
export function shortTime(stamp: string | null | undefined): string {
  if (!stamp) return '';
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return stamp;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One line for an outcome: the engine's type or message, else its status. */
export function outcomeText(outcome: { status: number | null; body: unknown } | null): string {
  if (!outcome) return '';
  const body = outcome.body as { type?: unknown; message?: unknown } | null;
  if (body && typeof body === 'object') {
    if (typeof body.type === 'string') return body.type;
    if (typeof body.message === 'string') return body.message;
  }
  return outcome.status === null ? '' : String(outcome.status);
}
