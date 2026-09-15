// Decode incrementally: a network frame is not a JSON message or a UTF-8 character.
export async function* readNdjson(
  response: Response,
  idleTimeoutMs = 600000,
): AsyncGenerator<unknown> {
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body) {
    throw new Error('ASR streaming response has an invalid content type or empty body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  const maxLineLength = 2 * 1024 * 1024;
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const next = reader.read();
      const idle = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('ASR stream timed out waiting for data')),
          idleTimeoutMs,
        );
      });
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await Promise.race([next, idle]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      const { done, value } = part;
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        if (newline > maxLineLength) throw new Error('ASR streaming message is too large');
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new Error('ASR stream contains invalid JSON');
          }
          yield parsed;
        }
        newline = pending.indexOf('\n');
      }
      if (pending.length > maxLineLength) throw new Error('ASR streaming message is too large');
      if (done) break;
    }
    if (pending.trim()) throw new Error('ASR streaming response ended inside a message');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
