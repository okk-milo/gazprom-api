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
