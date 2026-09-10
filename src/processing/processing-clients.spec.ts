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
});
