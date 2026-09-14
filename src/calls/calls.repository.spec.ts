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

describe('CallsRepository.listCallHistory', () => {
  it('returns lightweight call history ordered by newest upload', async () => {
    const database = new TestDatabase();
    const createdAt = new Date('2026-09-14T00:19:45.670Z');
    database.responses = [
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

    await expect(repository.listCallHistory()).resolves.toEqual([
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
    ]);
    expect(database.calls[0]?.text).toContain('JOIN deals');
    expect(database.calls[0]?.text).toContain('LIMIT 50');
  });
});
