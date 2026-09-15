import { type QueryResultRow } from 'pg';
import { CallsRepository } from './calls.repository';

class TestDatabase {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  responses: QueryResultRow[][] = [];

  async query<TRow extends QueryResultRow>(text: string, values: unknown[] = []): Promise<TRow[]> {
    this.calls.push({ text, values });
    const response = this.responses.shift() ?? [];
    return response as TRow[];
  }
}

describe('CallsRepository.deleteEmployee', () => {
  const employeeId = '6e1781c1-9a4b-4e74-aaea-4d8c64726c94';

  it('removes an employee only when they have no related calls or deals', async () => {
    const database = new TestDatabase();
    database.responses = [[{ id: employeeId, name: 'Сотрудник 2' }]];
    const repository = new CallsRepository(database);

    await expect(repository.deleteEmployee(employeeId)).resolves.toBe('deleted');
    expect(database.calls).toEqual([
      expect.objectContaining({
        values: [employeeId],
        text: expect.stringContaining('NOT EXISTS (SELECT 1 FROM deals'),
      }),
    ]);
  });

  it('reports an existing employee with linked data as in use', async () => {
    const database = new TestDatabase();
    database.responses = [[], [{ id: employeeId }]];
    const repository = new CallsRepository(database);

    await expect(repository.deleteEmployee(employeeId)).resolves.toBe('in_use');
  });

  it('reports a missing employee as not found', async () => {
    const database = new TestDatabase();
    database.responses = [[], []];
    const repository = new CallsRepository(database);

    await expect(repository.deleteEmployee(employeeId)).resolves.toBe('not_found');
  });
});

describe('CallsRepository.completeWithoutSpeech', () => {
  it('stores the empty transcript as a terminal result without an assessment', async () => {
    const database = new TestDatabase();
    const repository = new CallsRepository(database);

    await repository.completeWithoutSpeech('e722e2b8-9a64-4cf5-a59f-bd9f7a0a7a2c', []);

    expect(database.calls).toEqual([
      expect.objectContaining({
        values: ['[]', 'e722e2b8-9a64-4cf5-a59f-bd9f7a0a7a2c'],
        text: expect.stringContaining("state = 'no_speech'"),
      }),
    ]);
    expect(database.calls[0]?.text).toContain('analysis = NULL');
  });
});

describe('CallsRepository.saveProgress', () => {
  it('persists speech and risk but never publishes working evidence as final', async () => {
    const database = new TestDatabase();
    const repository = new CallsRepository(database);
    const factor = {
      id: 'factor',
      title: 'Основание',
      description: 'Цитата',
      confidence: 0.8,
      segmentId: 'segment',
    };
    await repository.saveProgress(
      'call',
      [],
      {
        score: 70,
        factorsFor: [factor],
        factorsAgainst: [factor],
        timeline: [{ timestampMs: 10000, score: 70 }],
        modelVersion: 'test',
      },
      20,
    );
    expect(database.calls[0]?.values).toEqual([
      'transcribing',
      '[]',
      JSON.stringify({
        score: 70,
        factorsFor: [],
        factorsAgainst: [],
        timeline: [{ timestampMs: 10000, score: 70 }],
        modelVersion: 'test',
      }),
      20,
      'call',
    ]);
    await repository.saveProgress('call', [], null, 150, true);
    expect(database.calls[1]?.values).toEqual(['analysing', '[]', 'null', 99, 'call']);
  });
});

describe('CallsRepository.listCallHistory', () => {
  it('returns lightweight call history ordered by newest upload', async () => {
    const database = new TestDatabase();
    const createdAt = new Date('2026-09-14T00:19:45.670Z');
    database.responses = [
      [{ total: 1 }],
      [
        {
          id: 'e64dcded-5c04-4ece-be22-845e8e906ae7',
          file_name: 'call.mp3',
          state: 'completed',
          progress: 100,
          score: 72,
          deal_title: 'Демонстрационная сделка',
          employee_name: 'Сотрудник 1',
          created_at: createdAt,
        },
      ],
    ];
    const repository = new CallsRepository(database);

    await expect(repository.listCallHistory(1)).resolves.toEqual({
      items: [
        {
          id: 'e64dcded-5c04-4ece-be22-845e8e906ae7',
          fileName: 'call.mp3',
          state: 'completed',
          progress: 100,
          score: 72,
          dealTitle: 'Демонстрационная сделка',
          employeeName: 'Сотрудник 1',
          createdAt: createdAt.toISOString(),
        },
      ],
      total: 1,
    });
    expect(database.calls[1]?.text).toContain('JOIN deals');
    expect(database.calls[1]?.values).toEqual([5, 0]);
  });
});

describe('CallsRepository.getCall acoustic labels', () => {
  it.each([
    {
      label: 'source speaker',
      metadata: { speakerId: 'SPEAKER_01' },
      expected: { speakerId: 'SPEAKER_01' },
    },
    { label: 'legacy snapshot', metadata: {}, expected: {} },
    { label: 'invalid optional label', metadata: { speakerId: 42 }, expected: {} },
  ])('preserves business role and supports $label', async ({ metadata, expected }) => {
    const database = new TestDatabase();
    const segment = {
      id: 'segment-1',
      startMs: 0,
      endMs: 1000,
      speaker: 'Клиент',
      text: 'Проверочный текст.',
      highlightRanges: [],
    };
    database.responses = [
      [
        {
          id: 'call-1',
          deal_id: 'deal-1',
          employee_id: 'employee-1',
          file_name: 'call.wav',
          state: 'completed',
          revision: 1,
          progress: 100,
          transcript: [{ ...segment, ...metadata }],
          analysis: null,
          error_message: null,
          created_at: new Date('2026-09-14T00:00:00Z'),
          updated_at: new Date('2026-09-14T00:00:00Z'),
        },
      ],
    ];

    const snapshot = await new CallsRepository(database).getCall('call-1');

    expect(snapshot?.transcript).toEqual([{ ...segment, ...expected }]);
  });
});

describe('analysis progress', () => {
  it('persists a partial result and revised transcript below completion', async () => {
    const database = new TestDatabase();
    const repository = new CallsRepository(database);
    const analysis = {
      score: 5,
      factorsFor: [],
      factorsAgainst: [],
      timeline: [],
      modelVersion: 'test',
    };
    await repository.saveAnalysisProgress('call-id', [], analysis, 150);
    expect(database.calls[0]?.text).toContain("state = 'analysing'");
    expect(database.calls[0]?.values).toEqual(['[]', JSON.stringify(analysis), 99, 'call-id']);
  });

  it('does not present a partial assessment as final when a later window fails', async () => {
    const database = new TestDatabase();
    await new CallsRepository(database).fail('call-id', 'invalid assessment');
    expect(database.calls[0]?.text).toContain('analysis = NULL');
    expect(database.calls[0]?.text).not.toContain('transcript =');
  });
});
