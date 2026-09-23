import { AppConfig } from '../config/app-config';
import { Agent } from 'undici';
import { createServer } from 'node:http';
import { ProcessingClients, type TranscriptionUpdate } from './processing-clients';

const progress = {
  type: 'progress',
  sequence: 0,
  processed_ms: 10000,
  duration_ms: 20000,
  segments: [{ start: 0, end: 9, text: 'Здравствуйте.' }],
};
const complete = { ...progress, type: 'complete', sequence: 1, processed_ms: 20000 };

describe('progressive ASR client', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
    process.env.MOCK_PROCESSING_ENABLED = 'false';
    process.env.ASR_INTERNAL_URL = 'http://asr.test/internal/v1/transcriptions';
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('retries a network failure before receiving the ASR stream without duplicating events', async () => {
    process.env.ASR_TRANSCRIPTION_RETRY_ATTEMPTS = '2';
    process.env.ASR_TRANSCRIPTION_RETRY_DELAY_MS = '1';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new TypeError('private connection details'))
      .mockResolvedValueOnce(
        new Response([progress, complete].map((event) => JSON.stringify(event)).join('\n') + '\n', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
      );
    const updates: TranscriptionUpdate[] = [];
    for await (const update of new ProcessingClients(new AppConfig()).streamTranscript(
      'https://storage.test/file.wav',
    ))
      updates.push(update);
    expect(updates.map((update) => update.sequence)).toEqual([0, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('reads real HTTP keep-alives and completion with a slow consumer and releases the connection', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', Connection: 'close' });
      response.write(JSON.stringify(progress) + '\n');
      const heartbeat = setInterval(() => response.write('\n'), 10);
      const completion = setTimeout(() => response.end(JSON.stringify(complete) + '\n'), 80);
      response.on('close', () => {
        clearInterval(heartbeat);
        clearTimeout(completion);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    process.env.ASR_INTERNAL_URL = `http://127.0.0.1:${address.port}/internal/v1/transcriptions`;
    const clients = new ProcessingClients(new AppConfig());
    try {
      const iterator = clients.streamTranscript('https://storage.test/file.wav');
      expect((await iterator.next()).value).toMatchObject({ type: 'progress', sequence: 0 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect((await iterator.next()).value).toMatchObject({ type: 'complete', sequence: 1 });
      expect((await iterator.next()).done).toBe(true);
    } finally {
      await clients.onModuleDestroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('retries a stateless LLM connection failure and bounds repeated failures', async () => {
    const deadline = jest.spyOn(AbortSignal, 'timeout');
    process.env.LLM_INTERNAL_URL = 'http://llm.test/assessments';
    process.env.LLM_ASSESSMENT_RETRY_ATTEMPTS = '2';
    process.env.LLM_ASSESSMENT_RETRY_DELAY_MS = '1';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new TypeError('private connection details'))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            score: 5,
            summary: 'Проверка.',
            factors_for: [],
            factors_against: [],
            model_version: 'test',
            segment_roles: [{ segment_index: 0, role: 'operator' }],
          }),
        ),
      );
    const clients = new ProcessingClients(new AppConfig());
    const transcript = [
      {
        id: '1',
        startMs: 0,
        endMs: 9000,
        text: 'Здравствуйте.',
        speaker: 'Неизвестный',
        highlightRanges: [],
      },
    ];
    await expect(clients.assessFragment(transcript)).resolves.toMatchObject({
      analysis: { score: 5 },
    });
    expect(deadline).toHaveBeenCalledWith(120000);
    fetchMock.mockReset().mockRejectedValue(new TypeError('private connection details'));
    await expect(clients.assessFragment(transcript)).rejects.toThrow('LLM connection failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  async function run(events: unknown[]): Promise<TranscriptionUpdate[]> {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(events.map((event) => JSON.stringify(event)).join('\n') + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
    );
    const updates: TranscriptionUpdate[] = [];
    for await (const update of new ProcessingClients(new AppConfig()).streamTranscript(
      'https://storage.test/file.wav',
    ))
      updates.push(update);
    return updates;
  }
  it('uses the streaming contract and maps absolute times without adding future speech', async () => {
    const updates = await run([progress, complete]);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      type: 'progress',
      processedMs: 10000,
      durationMs: 20000,
      segments: [{ startMs: 0, endMs: 9000, text: 'Здравствуйте.', speaker: 'Неизвестный' }],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://asr.test/internal/v1/transcriptions/stream',
      expect.objectContaining({
        body: JSON.stringify({
          source_url: 'https://storage.test/file.wav',
          profile: 'fast',
          step_seconds: 10,
        }),
        dispatcher: expect.any(Agent),
      }),
    );
  });
  it('ignores transport keep-alives without publishing extra progress or shifting sequence', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('\n' + JSON.stringify(progress) + '\n\n\n' + JSON.stringify(complete) + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
    );
    const clients = new ProcessingClients(new AppConfig());
    const updates: TranscriptionUpdate[] = [];
    try {
      for await (const update of clients.streamTranscript('https://storage.test/file.wav'))
        updates.push(update);
      expect(updates.map((update) => update.sequence)).toEqual([0, 1]);
    } finally {
      await clients.onModuleDestroy();
    }
  });
  it('accepts overlapping words and the one-second boundary tail in the next interval', async () => {
    const updates = await run([
      progress,
      {
        ...progress,
        sequence: 1,
        processed_ms: 20000,
        segments: [
          { start: 9, end: 12, text: 'Продолжение.' },
          { start: 11, end: 13, text: 'Ответ.' },
        ],
      },
      { ...complete, sequence: 2 },
    ]);
    expect(updates[1]?.segments).toHaveLength(2);
  });
  it.each([
    [progress],
    [progress, { type: 'error', code: 'private info' }],
    [{ ...progress, sequence: 1 }, complete],
    [progress, progress, complete],
    [progress, { ...progress, sequence: 1, processed_ms: 15000 }, { ...complete, sequence: 2 }],
    [progress, { ...complete, duration_ms: 30000 }],
    [{ ...progress, segments: [{ start: 8, end: 11, text: 'Будущее.' }] }, complete],
    [progress, complete, complete],
  ])('rejects incomplete, failed or inconsistent stream %#', async (...events) => {
    await expect(run(events)).rejects.toThrow();
  });
});
