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
