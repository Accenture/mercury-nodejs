// Server-sent events read with fetch, so the stream carries the bearer token EventSource cannot: the frames are
// parsed here (id, event, data; a comment line is a keep-alive and is dropped).

export interface Frame {
  id?: string;
  event?: string;
  data: string;
}

/** The complete frames in the buffer and the text left over (a frame still arriving). */
export function parseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  let rest = buffer;
  for (;;) {
    const at = rest.indexOf('\n\n');
    if (at < 0) break;
    const block = rest.slice(0, at);
    rest = rest.slice(at + 2);
    const frame: Frame = { data: '' };
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue; // a keep-alive comment, or padding
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'id') frame.id = value;
      else if (field === 'event') frame.event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0 || frame.id !== undefined || frame.event !== undefined) {
      frame.data = data.join('\n');
      frames.push(frame);
    }
  }
  return { frames, rest };
}

/** Read a response body as frames until it ends or the signal aborts. */
export async function readFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: Frame) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseFrames(buffer);
      buffer = rest;
      for (const frame of frames) onFrame(frame);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
