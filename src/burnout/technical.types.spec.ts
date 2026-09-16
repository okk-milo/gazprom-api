import {
  parseTechnicalDataset,
  technicalMeasures,
  technicalView,
  type TechnicalDataset,
  type TechnicalFacts,
} from './technical.types';
const facts = (events = 0): TechnicalFacts => ({
  durationSeconds: 120,
  speechMs: 60000,
  words: 100,
  segmentCount: 10,
  events: Array.from({ length: events }, (_, i) => ({
    kind: 'clarification',
    segmentId: String(i),
    quote: 'Уточните, пожалуйста',
    startMs: i * 1000,
    endMs: (i + 1) * 1000,
  })),
});
const dataset = (n = 16): TechnicalDataset => ({
  id: 'ec74553e-2197-4e6c-aaf2-cfe165e783c2',
  version: 'technical-dialogue-v1',
  periodStart: '2026-07-27',
  sources: Array.from({ length: n }, (_, i) => ({
    id: i.toString(16).padStart(64, '0'),
    status: 'measured',
    fingerprint: 'a'.repeat(64),
    model: 'unit-model',
    facts: facts(i % 3),
  })),
});
describe('Technical dialogue scoring and conditional ordering', () => {
  it('keeps missing separate from a measured zero event count', () => {
    expect(technicalMeasures([])).toBeNull();
    expect(technicalMeasures([facts()])?.scores).toEqual({
      repetition: 0,
      correction: 0,
      complaint: 0,
      speechDensity: 50,
    });
  });
  it('normalizes event rates by speech duration, not arbitrary call count', () => {
    const a = facts(1),
      b = { ...facts(2), durationSeconds: 240, speechMs: 120000 };
    expect(technicalMeasures([a])?.scores).toEqual(technicalMeasures([b])?.scores);
    expect(technicalMeasures([a, b])?.rates.repetition).toBe(1);
  });
  it('assigns each measured source once, deterministically, then calculates groups from members', () => {
    const input = parseTechnicalDataset(dataset());
    const view = technicalView(input);
    expect(technicalView({ ...input, sources: input.sources.toReversed() }).weeks).toEqual(
      view.weeks,
    );
    const ids = view.weeks.flatMap((w) => w.sourceIds);
    expect(new Set(ids).size).toBe(16);
    expect(ids).toHaveLength(16);
    for (const week of view.weeks)
      expect(week.measures).toEqual(
        technicalMeasures(
          input.sources
            .filter((s) => s.status === 'measured' && week.sourceIds.includes(s.id))
            .flatMap((s) => (s.status === 'measured' ? [s.facts] : [])),
        ),
      );
    expect(view.ordering).toBe('score_sorted_conditional');
  });
  it('does not invent calls/variation or zeroes for missing weeks', () => {
    const view = technicalView(dataset(2));
    expect(view.weeks.filter((w) => w.measures === null)).toHaveLength(6);
    expect(view.coverage.measured).toBe(2);
  });
  it('excludes failed data from scores and rejects duplicate sources, invalid bounds, dates and evidence', () => {
    const input = dataset(1);
    input.sources.push({ id: 'b'.repeat(64), status: 'failed', reason: 'extraction_failed' });
    const view = technicalView(parseTechnicalDataset(input));
    expect(view.coverage.failed).toBe(1);
    expect(view.sources[1]?.index).toBeNull();
    expect(() =>
      parseTechnicalDataset({ ...input, sources: [...input.sources, input.sources[0]] }),
    ).toThrow();
    expect(() => parseTechnicalDataset({ ...input, periodStart: '2026-02-31' })).toThrow();
    expect(() =>
      parseTechnicalDataset({
        ...input,
        sources: [{ ...input.sources[0], facts: { ...facts(), speechMs: 121000 } }],
      }),
    ).toThrow();
    const event = facts(1).events[0];
    expect(() =>
      parseTechnicalDataset({
        ...input,
        sources: [{ ...input.sources[0], facts: { ...facts(), events: [event, event] } }],
      }),
    ).toThrow();
  });
});
