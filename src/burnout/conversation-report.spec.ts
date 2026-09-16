import { buildReportSchedule, conversationReport, reportMeasures } from './conversation-report';
import { parseAudioFacts } from './audio-facts';
import { parseTechnicalDataset, type TechnicalDataset } from './technical.types';

function fixture(n = 48): TechnicalDataset {
  return {
    id: '599d8b23-24ae-462c-a58a-5e293c31bcec',
    version: 'technical-dialogue-v1',
    periodStart: '2026-07-27',
    sources: Array.from({ length: n }, (_, i) => ({
      id: i.toString(16).padStart(64, '0'),
      status: 'measured',
      model: 'unit-model',
      fingerprint: 'f'.repeat(64),
      facts: {
        durationSeconds: 120,
        speechMs: 119000,
        words: 120,
        segmentCount: 12,
        events: [],
        audio: {
          version: 'silero-activity-v1',
          durationMs: 120000,
          voicedMs: 60000,
          longPauseMs: i * 1000,
          longPauseCount: Math.floor(i / 2),
        },
      },
    })),
  };
}
describe('Conversation report and assigned calendar', () => {
  it('calculates speech and pauses from audio, not recogniser segment coverage', () => {
    const schedule = buildReportSchedule(fixture(1));
    expect(reportMeasures(schedule)).toMatchObject({
      calls: 1,
      totalMinutes: 2,
      values: { speechRate: 120, longPauses: 0, duration: 2, repetition: 0 },
    });
    expect(reportMeasures([])).toBeNull();
  });
  it('preserves facts, assigns every source once, keeps gaps/end times consistent and inside a shift', () => {
    const d = fixture(),
      original = JSON.stringify(d),
      schedule = buildReportSchedule(d);
    expect(buildReportSchedule(d)).toEqual(schedule);
    expect(JSON.stringify(d)).toBe(original);
    expect(new Set(schedule.map((c) => c.id)).size).toBe(48);
    for (const c of schedule) {
      expect(c.endMs - c.startMs).toBe(c.facts.audio.durationMs);
      expect(c.startMs).toBeGreaterThanOrEqual(c.shiftStartMs);
      expect(c.endMs).toBeLessThanOrEqual(c.shiftEndMs);
      expect(c.provenance).toBe('assigned-schedule-v1');
    }
    const sorted = [...schedule].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1],
        current = sorted[i];
      if (!previous || !current) throw new Error('Missing fixture');
      expect(current.startMs).toBeGreaterThanOrEqual(previous.endMs);
      if (current.gapBeforeMs !== null)
        expect(current.startMs - previous.endMs).toBe(current.gapBeforeMs);
    }
  });
  it('aggregates raw denominators after assignment with non-uniform counts, without arbitrary overall score', () => {
    const report = conversationReport(fixture());
    expect(report.weeks).toHaveLength(8);
    expect(report.weeks.reduce((sum, w) => sum + (w.measures?.calls ?? 0), 0)).toBe(48);
    expect(new Set(report.weeks.map((w) => w.measures?.calls)).size).toBeGreaterThan(1);
    expect(report.overall?.values.speechRate).toBe(120);
    expect(report.overall).not.toHaveProperty('index');
    expect(report.baselineWorkload?.gapMinutes).toBeGreaterThan(
      report.recentWorkload?.gapMinutes ?? 0,
    );
    expect(report.recentWorkload?.latePercent).toBeGreaterThan(0);
  });
  it('does not turn missing audio measurement into zero', () => {
    const d = fixture(1),
      s = d.sources[0];
    if (!s || s.status !== 'measured') throw new Error('Missing fixture');
    delete s.facts.audio;
    expect(conversationReport(d).overall).toBeNull();
    expect(conversationReport(d).coverage.measured).toBe(0);
  });
  it('rejects invalid audio facts and preserves valid additions through import parsing', () => {
    const audio = {
      version: 'silero-activity-v1',
      durationMs: 120000,
      voicedMs: 60000,
      longPauseMs: 4000,
      longPauseCount: 1,
    };
    expect(parseAudioFacts(audio, 120)).toEqual(audio);
    for (const patch of [
      { voicedMs: 120001 },
      { longPauseMs: 1000 },
      { longPauseCount: 0 },
      { durationMs: 125000 },
      { voicedMs: NaN },
      { version: 'other' },
    ])
      expect(() => parseAudioFacts({ ...audio, ...patch }, 120)).toThrow();
    expect(parseTechnicalDataset(fixture(1))).toEqual(fixture(1));
  });
});
