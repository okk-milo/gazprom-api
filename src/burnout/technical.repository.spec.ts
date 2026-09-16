import { TechnicalRepository } from './technical.repository';

describe('Technical dataset storage isolation', () => {
  it('validates before writing and only touches its own table with idempotent updates', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repo = new TechnicalRepository({ query });
    await expect(repo.import({ version: 'invalid' })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    const input = {
      id: 'ec74553e-2197-4e6c-aaf2-cfe165e783c2',
      version: 'technical-dialogue-v1',
      periodStart: '2026-07-27',
      sources: [],
    };
    await repo.import(input);
    await repo.import(input);
    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) {
      expect(call[0]).toContain('dialogue_technical_datasets');
      expect(call[0]).not.toMatch(/calls|employees|deals|burnout_datasets/);
    }
    expect(query.mock.calls[1][0]).toContain('IS DISTINCT FROM');
    expect(query.mock.calls[1][1]).toEqual([input.id, JSON.stringify(input)]);
  });
  it('retries a failed schema initialization without returning false empty data', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue([]);
    const repo = new TechnicalRepository({ query });
    await expect(repo.latest()).rejects.toThrow('Offline');
    await expect(repo.latest()).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });
});
