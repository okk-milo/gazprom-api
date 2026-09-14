import { AppConfig } from '../config/app-config';
import { ProcessingClients } from './processing-clients';

describe('ProcessingClients', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.MOCK_PROCESSING_ENABLED = 'true';
  });

  it('returns a score, factors and transcript highlights in mock mode', async () => {
    const clients = new ProcessingClients(new AppConfig());
    const transcript = await clients.transcribe('mock://audio');
    const analysis = await clients.assess(transcript);

    expect(analysis.score).toBe(72);
    expect(analysis.factorsFor).toHaveLength(2);
    expect(analysis.factorsAgainst).toHaveLength(1);
    expect(transcript.some((segment) => segment.highlightRanges.length > 0)).toBe(true);
  });

  it('retries a transient busy ASR response', async () => {
    process.env.MOCK_PROCESSING_ENABLED = 'false';
    process.env.ASR_INTERNAL_URL = 'http://asr.test/internal/v1/transcriptions';
    process.env.ASR_TRANSCRIPTION_RETRY_ATTEMPTS = '2';
    process.env.ASR_TRANSCRIPTION_RETRY_DELAY_MS = '1';

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            segments: [
              {
                start: 1.2,
                end: 2.4,
                text: 'Проверочная фраза',
                speaker_id: 'Клиент',
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const clients = new ProcessingClients(new AppConfig());
    const transcript = await clients.transcribe('https://storage.example/call.wav');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(transcript).toMatchObject([
      {
        startMs: 1200,
        endMs: 2400,
        speaker: 'Клиент',
        text: 'Проверочная фраза',
      },
    ]);

    jest.restoreAllMocks();
    process.env.MOCK_PROCESSING_ENABLED = 'true';
    delete process.env.ASR_INTERNAL_URL;
    delete process.env.ASR_TRANSCRIPTION_RETRY_ATTEMPTS;
    delete process.env.ASR_TRANSCRIPTION_RETRY_DELAY_MS;
  });

  it('retries a transient busy LLM response', async () => {
    process.env.MOCK_PROCESSING_ENABLED = 'false';
    process.env.LLM_INTERNAL_URL = 'http://llm.test/internal/v1/antifraud/assessments';
    process.env.LLM_ASSESSMENT_RETRY_ATTEMPTS = '2';
    process.env.LLM_ASSESSMENT_RETRY_DELAY_MS = '1';

    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            score: 65,
            factors_for: [],
            factors_against: [],
            timeline: [
              { segment_index: 0, score: 34 },
              { segment_index: 1, score: 65 },
            ],
            speaker_roles: [
              { speaker: 'SPEAKER_00', role: 'operator' },
              { speaker: 'SPEAKER_01', role: 'client' },
            ],
            segment_roles: [
              { segment_index: 0, role: 'operator' },
              { segment_index: 1, role: 'client' },
              { segment_index: 2, role: 'client' },
            ],
            summary: 'Клиент описывает перевод и указания третьих лиц.',
            model_version: 'qwen-test',
          }),
          { status: 200 },
        ),
      );

    const clients = new ProcessingClients(new AppConfig());
    const transcript = [
      {
        id: 'a3c4b325-2688-4375-887a-e2749a5d0db1',
        startMs: 0,
        endMs: 2000,
        speaker: 'SPEAKER_00',
        text: 'Здравствуйте, расскажите о переводе.',
        highlightRanges: [],
      },
      {
        id: 'b9bb94d7-61e2-43fe-9e41-93698f59b9fe',
        startMs: 2000,
        endMs: 4000,
        speaker: 'SPEAKER_01',
        text: 'Мне сказали действовать срочно.',
        highlightRanges: [],
      },
      {
        id: '92df024a-6e15-4d65-8b8d-bef8ba204dd6',
        startMs: 4000,
        endMs: 6000,
        speaker: 'Неизвестный',
        text: 'Я перевожу деньги за ремонт квартиры.',
        highlightRanges: [],
      },
    ];
    const analysis = await clients.assess(transcript);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(analysis).toMatchObject({ score: 65, modelVersion: 'qwen-test' });
    expect(analysis.timeline.map((point) => point.score)).toEqual([65]);
    expect(transcript.map((segment) => segment.speaker)).toEqual(['Оператор', 'Клиент', 'Клиент']);

    jest.restoreAllMocks();
    process.env.MOCK_PROCESSING_ENABLED = 'true';
    delete process.env.LLM_INTERNAL_URL;
    delete process.env.LLM_ASSESSMENT_RETRY_ATTEMPTS;
    delete process.env.LLM_ASSESSMENT_RETRY_DELAY_MS;
  });
});

describe('ProcessingClients sequential windows', () => {
  it('processes all 326 segments, carries only previous context, and publishes incremental scores', async () => {
    process.env.MOCK_PROCESSING_ENABLED = 'false';
    process.env.LLM_INTERNAL_URL = 'http://llm.test/internal/v1/antifraud/assessments';
    const requests: Array<Record<string, unknown>> = [];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      expect(url).toBe('http://llm.test/internal/v1/antifraud/assessments/windows');
      const raw: unknown = JSON.parse(String(init?.body));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid test request');
      const body = raw as Record<string, unknown>;
      if (!Array.isArray(body.transcript)) throw new Error('Missing transcript');
      requests.push(body);
      return new Response(
        JSON.stringify({
          score: 5,
          summary: 'Клиент действует самостоятельно.',
          factors_for: [],
          factors_against: [],
          model_version: 'test',
          segment_roles: body.transcript.map((_, segment_index) => ({
            segment_index,
            role: 'operator',
          })),
        }),
        { status: 200 },
      );
    });
    try {
      const transcript = Array.from({ length: 326 }, (_, index) => ({
        id: String(index),
        startMs: index * 2000,
        endMs: (index + 1) * 2000,
        speaker: 'SPEAKER_00',
        text: `Проверочная реплика ${index}`,
        highlightRanges: [],
      }));
      const onProgress = jest.fn(async () => {});
      const result = await new ProcessingClients(new AppConfig()).assess(transcript, onProgress);
      expect(fetchMock).toHaveBeenCalledTimes(11);
      expect(onProgress).toHaveBeenCalledTimes(11);
      expect(requests[0]).not.toHaveProperty('previous');
      expect(requests[1]?.previous).toMatchObject({
        score: 5,
        summary: 'Клиент действует самостоятельно.',
      });
      expect(result.timeline).toHaveLength(11);
      expect(result.timeline.at(-1)?.timestampMs).toBe(652000);
      expect(result.timeline.every((point) => point.score === 5)).toBe(true);
      expect(transcript.every((segment) => segment.speaker === 'Оператор')).toBe(true);
    } finally {
      jest.restoreAllMocks();
      process.env.MOCK_PROCESSING_ENABLED = 'true';
      delete process.env.LLM_INTERNAL_URL;
    }
  });
});
