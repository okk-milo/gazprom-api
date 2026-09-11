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
});
