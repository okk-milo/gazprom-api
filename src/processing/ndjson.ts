export const ASR_STREAM_IDLE_TIMEOUT_MS = 600000;

const transportCodes = new Set([
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ABORT_ERR',
]);

function transportCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) break;
    if ('code' in current && typeof current.code === 'string' && transportCodes.has(current.code))
      return current.code;
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

// Decode incrementally: a network frame is not a JSON message or a UTF-8 character.
export async function* readNdjson(
  response: Response,
  idleTimeoutMs = ASR_STREAM_IDLE_TIMEOUT_MS,
): AsyncGenerator<unknown> {
  if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body) {
    throw new Error('ASR streaming response has an invalid content type or empty body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let lastEventAt = Date.now();
  const maxLineLength = 2 * 1024 * 1024;
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const next = reader.read();
      const idle = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('ASR stream timed out waiting for data')),
          Math.max(1, idleTimeoutMs - (Date.now() - lastEventAt)),
        );
      });
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await Promise.race([next, idle]);
      } catch (error: unknown) {
        const code = transportCode(error);
        if (code) throw new Error(`ASR stream interrupted (${code})`);
        if (error instanceof TypeError && error.message === 'terminated')
          throw new Error('ASR stream interrupted (transport cause unavailable)');
        throw error;
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
          // Consumer time (including LLM work) is not ASR idle time. Blank
          // keep-alives preserve transport only; they cannot mask hung inference.
          lastEventAt = Date.now();
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
