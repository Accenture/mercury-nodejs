import { describe, expect, it } from 'vitest';
import { parseFrames, readFrames } from './sse';
import { encoder } from './test/fixtures';

describe('parseFrames', () => {
  it('parses complete frames and keeps a partial one', () => {
    const text = 'id: 3\nevent: question\ndata: {"a":1}\n\n: keep-alive\n\nid: 4\nevent: question\ndata: {"a"';
    const { frames, rest } = parseFrames(text);
    expect(frames).toEqual([{ id: '3', event: 'question', data: '{"a":1}' }]);
    expect(rest).toBe('id: 4\nevent: question\ndata: {"a"');
  });

  it('joins multi-line data and reads a field without a space', () => {
    const { frames } = parseFrames('data:one\ndata: two\n\n');
    expect(frames).toEqual([{ data: 'one\ntwo' }]);
  });

  it('drops a frame that is only a comment', () => {
    expect(parseFrames(': ping\n\n').frames).toEqual([]);
  });
});

describe('readFrames', () => {
  it('reassembles frames split across chunks and stops on abort', async () => {
    const chunks = ['id: 1\nevent: question\nda', 'ta: {"x":1}\n\nid: 2\nevent: q', 'uestion\ndata: {"x":2}\n\n'];
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        // the stream stays open - the abort ends the read
      },
      cancel() {
        cancelled = true;
      }
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const done = readFrames(stream, (frame) => {
      seen.push(`${frame.id}:${frame.data}`);
      if (seen.length === 2) controller.abort();
    }, controller.signal);
    await done;
    expect(seen).toEqual(['1:{"x":1}', '2:{"x":2}']);
    expect(cancelled).toBe(true);
  });

  it('returns when the stream ends', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\n\n'));
        controller.close();
      }
    });
    const seen: string[] = [];
    await readFrames(stream, (frame) => seen.push(frame.data));
    expect(seen).toEqual(['a']);
  });
});
