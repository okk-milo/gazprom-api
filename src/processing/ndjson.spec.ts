import { readNdjson } from './ndjson';

function stream(parts: Uint8Array[], contentType = 'application/x-ndjson'): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    { headers: { 'Content-Type': contentType } },
  );
}
async function collect(response: Response): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const item of readNdjson(response)) result.push(item);
  return result;
}
describe('readNdjson', () => {
  it('does not let keep-alives hide stalled inference indefinitely', async () => {
    let timer: ReturnType<typeof setInterval>;
    const cancel = jest.fn(() => clearInterval(timer));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode('\n')), 5);
        },
        cancel,
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
    await expect(readNdjson(response, 40).next()).rejects.toThrow('timed out');
    expect(cancel).toHaveBeenCalled();
  });
  it('does not count a slow consumer as idle ASR time', async () => {
    const response = stream([
      new TextEncoder().encode('{"n":1}\n'),
      new TextEncoder().encode('{"n":2}\n'),
    ]);
    const iterator = readNdjson(response, 20);
    expect((await iterator.next()).value).toEqual({ n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await iterator.next()).value).toEqual({ n: 2 });
    expect((await iterator.next()).done).toBe(true);
  });
  it('preserves a known nested transport code without leaking messages or URLs', async () => {
    const secret = 'https://private.test/audio?token=secret';
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(
            new TypeError('terminated', {
              cause: Object.assign(new Error(secret), { code: 'UND_ERR_BODY_TIMEOUT' }),
            }),
          );
        },
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
    await expect(collect(response)).rejects.toThrow(
      'ASR stream interrupted (UND_ERR_BODY_TIMEOUT)',
    );
  });
  it('does not expose arbitrary cause codes as diagnostic text', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('terminated', { cause: { code: 'private-token' } }));
        },
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } },
    );
    await expect(collect(response)).rejects.toThrow(
      'ASR stream interrupted (transport cause unavailable)',
    );
  });
  it('bounds an idle connection and cancels its reader', async () => {
    const cancel = jest.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
    const iterator = readNdjson(response, 5);
    await expect(iterator.next()).rejects.toThrow('timed out');
    expect(cancel).toHaveBeenCalled();
  });
  it('decodes fragmented UTF-8, multiple events and CRLF without buffering the whole response', async () => {
    const bytes = new TextEncoder().encode('{"text":"Привет"}\r\n\n{"type":"complete"}\n');
    await expect(
      collect(stream(Array.from(bytes, (byte) => Uint8Array.of(byte)))),
    ).resolves.toEqual([{ text: 'Привет' }, { type: 'complete' }]);
  });
  it('rejects truncated, malformed, oversized and non-streaming responses', async () => {
    const encode = (text: string) => [new TextEncoder().encode(text)];
    await expect(collect(stream(encode('{"type":"complete"}')))).rejects.toThrow(
      'inside a message',
    );
    await expect(collect(stream(encode('{bad}\n')))).rejects.toThrow();
    await expect(collect(stream(encode('x'.repeat(2 * 1024 * 1024 + 1))))).rejects.toThrow(
      'too large',
    );
    await expect(collect(stream(encode('{}\n'), 'application/json'))).rejects.toThrow(
      'content type',
    );
  });
});
