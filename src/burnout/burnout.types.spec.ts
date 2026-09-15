import { datasetView, parseDataset } from './burnout.types';

const sourceFixture = () => ({
  id: 'a'.repeat(64),
  processedAt: '2026-09-15T10:00:00.000Z',
  durationSeconds: 120,
  scenarioDate: '2026-07-27',
  screening: 'dialogue_candidate',
  screeningState: 'screened',
  review: 'accepted',
});

const fixture = () => ({
  id: '6dca1f5e-16b9-49c2-b164-cadf2e73a615',
  periodStart: '2026-07-27',
  provenance: 'authored_scenario',
  employeeName: 'Сотрудник примера',
  observations: [],
  weeklyScores: Array.from({ length: 8 }, () => ({
    exhaustion: 20,
    distance: 30,
    speechInconsistency: 40,
    workload: 50,
  })),
  sources: [
    {
      id: 'a'.repeat(64),
      processedAt: '2026-09-15T10:00:00.000Z',
      durationSeconds: 120,
      scenarioDate: '2026-07-27',
      screening: 'dialogue_candidate',
      screeningState: 'screened',
      review: 'accepted',
    },
  ],
});

describe('Burnout scenario boundary', () => {
  it('keeps source review and scenario values separate and aggregates accepted duration only', () => {
    const input = fixture();
    input.sources.push({
      ...sourceFixture(),
      id: 'b'.repeat(64),
      scenarioDate: '2026-08-03',
      review: 'pending',
    });
    const view = datasetView(parseDataset(input));
    expect(view.weeklyCoverage).toHaveLength(8);
    expect(view.weeklyCoverage[0]).toEqual({
      index: 0,
      accepted: 1,
      pending: 0,
      excluded: 0,
      audioSeconds: 120,
    });
    expect(view.weeklyCoverage[1]?.audioSeconds).toBe(0);
    expect(view.coverage).toEqual({ total: 2, accepted: 1, pending: 1, excluded: 0 });
  });
  it('rejects invented provenance, unknown fields and invalid calendar dates', () => {
    for (const input of [
      { ...fixture(), provenance: 'inferred_burnout' },
      { ...fixture(), employeeName: 'Real employee' },
      { ...fixture(), extra: true },
      { ...fixture(), periodStart: '2026-02-30' },
      { ...fixture(), weeklyScores: [] },
    ])
      expect(() => parseDataset(input)).toThrow();
  });
  it('rejects duplicates and sources outside the eight weeks', () => {
    const duplicate = fixture();
    duplicate.sources.push(sourceFixture());
    expect(() => parseDataset(duplicate)).toThrow();
    for (const date of ['2026-07-26', '2026-09-21', 'not-a-date']) {
      const input = fixture();
      input.sources[0] = { ...sourceFixture(), scenarioDate: date };
      expect(() => parseDataset(input)).toThrow();
    }
  });
  it('cannot accept non-dialogues as reviewed examples', () => {
    const input = fixture();
    input.sources[0] = { ...sourceFixture(), screening: 'monologue' };
    expect(() => parseDataset(input)).toThrow();
  });
  it('requires traceable, bounded observations and keeps roles unknown', () => {
    const observation = {
      sourceId: 'a'.repeat(64),
      segmentId: '1',
      kind: 'clarification',
      startMs: 1000,
      endMs: 2000,
      quote: 'Уточните вопрос, пожалуйста.',
      review: 'text_checked',
      speaker: 'unknown',
    };
    expect(parseDataset({ ...fixture(), observations: [observation] }).observations).toHaveLength(
      1,
    );
    for (const change of [
      { sourceId: 'b'.repeat(64) },
      { endMs: 121000 },
      { startMs: 3000 },
      { speaker: 'operator' },
      { review: 'model_inferred' },
      { kind: 'exhaustion' },
      { quote: '' },
    ]) {
      expect(() =>
        parseDataset({ ...fixture(), observations: [{ ...observation, ...change }] }),
      ).toThrow();
    }
    expect(() =>
      parseDataset({ ...fixture(), observations: [observation, observation] }),
    ).toThrow();
  });
});
