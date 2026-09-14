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
    ];
    const analysis = await clients.assess(transcript);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(analysis).toMatchObject({ score: 65, modelVersion: 'qwen-test' });
    expect(analysis.timeline.map((point) => point.score)).toEqual([34, 65]);
    expect(transcript.map((segment) => segment.speaker)).toEqual(['Оператор', 'Клиент']);

    jest.restoreAllMocks();
    process.env.MOCK_PROCESSING_ENABLED = 'true';
    delete process.env.LLM_INTERNAL_URL;
    delete process.env.LLM_ASSESSMENT_RETRY_ATTEMPTS;
    delete process.env.LLM_ASSESSMENT_RETRY_DELAY_MS;
  });
});
