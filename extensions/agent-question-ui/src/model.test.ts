import { describe, expect, it } from 'vitest';
import { attentionCount, groupCases, maxSeq, mergeRows, openCount, outcomeText, shortTime, split } from './model';
import { row } from './test/fixtures';

describe('mergeRows', () => {
  it('keeps the later change of a row and ignores an older one', () => {
    const held = mergeRows(new Map(), [row({ id: 1, seq: 3, state: 'answered' })]);
    const older = mergeRows(held, [row({ id: 1, seq: 2, state: 'open' })]);
    expect(older.get(1)?.state).toBe('answered');
    const newer = mergeRows(older, [row({ id: 1, seq: 5, state: 'expired' })]);
    expect(newer.get(1)?.state).toBe('expired');
    expect(held.get(1)?.state).toBe('answered'); // the held map is not mutated
  });

  it('adds rows it does not hold', () => {
    const merged = mergeRows(new Map(), [row({ id: 1, seq: 1 }), row({ id: 2, seq: 2, kind: 'advice', state: null })]);
    expect([...merged.keys()]).toEqual([1, 2]);
  });
});

describe('groupCases', () => {
  const rows = [
    row({ id: 1, seq: 3, state: 'answered', correlation_id: 'c-1', requested_at: '2026-11-20T07:00:00.000Z' }),
    row({ id: 2, seq: 2, kind: 'advice', state: null, correlation_id: 'c-1', requested_at: '2026-11-20T07:05:00.000Z' }),
    row({ id: 3, seq: 5, kind: 'question', state: 'open', correlation_id: 'c-2', description: 'Second case' }),
    row({ id: 4, seq: 4, state: 'expired', correlation_id: 'c-3' }),
    row({ id: 5, seq: 7, state: 'open', correlation_id: 'c-3' }),
    row({ id: 6, seq: 6, kind: 'advice', state: null, correlation_id: 'c-2' }),
    row({ id: 7, seq: 1, state: 'answered', correlation_id: 'c-1', requested_at: '2026-11-20T06:00:00.000Z' })
  ];

  it('groups by graph and correlation id, cases newest first, rows in the order they were recorded', () => {
    const cases = groupCases(rows);
    expect(cases.map((c) => c.correlation_id)).toEqual(['c-3', 'c-2', 'c-1']);
    // the answered wait (id 1) was recorded before the advice (id 2) and keeps its place although its answer moved its seq
    expect(cases[2].rows.map((r) => r.id)).toEqual([7, 1, 2]);
    expect(cases[1].description).toBe('Second case');
    expect(cases.map((c) => c.open)).toEqual([1, 1, 0]);
  });

  it('separates the same correlation id under another graph', () => {
    const cases = groupCases([row({ id: 1, seq: 1 }), row({ id: 2, seq: 2, graph_id: 'other' })]);
    expect(cases).toHaveLength(2);
  });

  it('splits what waits from the history and counts the open cards', () => {
    const { waiting, history } = split(groupCases(rows), { upTo: 7, ids: new Set() });
    expect(waiting.map((c) => c.correlation_id)).toEqual(['c-3', 'c-2']);
    expect(history.map((c) => c.correlation_id)).toEqual(['c-1']);
    expect(openCount(waiting)).toBe(2);
    expect(maxSeq(rows)).toBe(7);
    expect(maxSeq([])).toBe(0);
  });

  it('keeps a case with an advice this device has not seen in the waiting panel, and never an older page', () => {
    const cases = groupCases(rows);
    // the device's baseline is the newest sequence of its first page: advices up to it are history
    expect(split(cases, { upTo: 7, ids: new Set() }).waiting.map((c) => c.correlation_id)).toEqual(['c-3', 'c-2']);
    // a baseline before the advices: both advice cases ask for attention until marked seen
    const early = { upTo: 1, ids: new Set<number>() };
    expect(split(cases, early).waiting.map((c) => c.correlation_id)).toEqual(['c-3', 'c-2', 'c-1']);
    expect(attentionCount(cases, early)).toBe(4); // two open cards, two unseen advices
    const marked = { upTo: 1, ids: new Set([2, 6]) };
    expect(split(cases, marked).history.map((c) => c.correlation_id)).toEqual(['c-1']);
    expect(attentionCount(cases, marked)).toBe(2);
  });
});

describe('text helpers', () => {
  it('shortens a stamp to local date and time and leaves text it cannot read', () => {
    expect(shortTime('2026-11-20T08:05:09.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(shortTime('not a date')).toBe('not a date');
    expect(shortTime(null)).toBe('');
  });

  it("describes an outcome by the engine's type, its message or its status", () => {
    expect(outcomeText({ status: 200, body: { type: 'resumed' } })).toBe('resumed');
    expect(outcomeText({ status: 410, body: { message: 'nothing waiting' } })).toBe('nothing waiting');
    expect(outcomeText({ status: 502, body: 'gateway' })).toBe('502');
    expect(outcomeText({ status: null, body: null })).toBe('');
    expect(outcomeText(null)).toBe('');
  });
});
