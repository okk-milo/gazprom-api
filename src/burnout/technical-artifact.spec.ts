import { technicalSourceFromArtifact } from './technical-artifact';
import { parseTechnicalDataset } from './technical.types';
const id = 'a'.repeat(64),
  version = 'technical-events-v2-explicit-markers';
function artifact() {
  return {
    sourceId: id,
    version,
    fingerprint: 'b'.repeat(64),
    durationSeconds: 60,
    invalidSegments: 0,
    segments: [
      {
        id: 's1',
        startMs: 0,
        endMs: 20000,
        text: 'Повторите, пожалуйста, вопрос. Я хочу проверить номер обращения и записать его правильно.',
      },
      {
        id: 's2',
        startMs: 10000,
        endMs: 30000,
        text: 'Номер обращения двадцать, дата обращения вторник. Пожалуйста, проверьте, что обращение зарегистрировано и ожидает ответа.',
      },
    ],
    windows: [
      {
        version,
        model: 'unit-model',
        segmentIds: ['s1', 's2'],
        result: {
          contentType: 'conversation',
          validationVersion: 'technical-markers-v5',
          discardedEvents: 0,
          events: [{ kind: 'repeat_request', segmentId: 's1', quote: 'Повторите, пожалуйста' }],
        },
      },
    ],
  };
}
describe('Technical extraction artifacts', () => {
  it('binds evidence to original segment and unions overlapping speech intervals', () => {
    const source = technicalSourceFromArtifact(artifact(), id);
    expect(source.status).toBe('measured');
    if (source.status !== 'measured') throw new Error('Expected measurement');
    expect(source.facts.speechMs).toBe(30000);
    expect(source.facts.events[0]).toMatchObject({
      segmentId: 's1',
      quote: 'Повторите, пожалуйста',
      startMs: 0,
      endMs: 20000,
    });
    expect(
      parseTechnicalDataset({
        id: 'ec74553e-2197-4e6c-aaf2-cfe165e783c2',
        version: 'technical-dialogue-v1',
        periodStart: '2026-07-27',
        sources: [source],
      }).sources,
    ).toHaveLength(1);
  });
  it('does not score timestamps known to be invalid, monologues or unclear windows', () => {
    expect(technicalSourceFromArtifact({ ...artifact(), invalidSegments: 1 }, id)).toEqual({
      id,
      status: 'excluded',
      reason: 'invalid_timestamps',
    });
    for (const [contentType, reason] of [
      ['monologue', 'monologue'],
      ['unclear', 'unclear_content'],
    ] as const) {
      const input = artifact();
      const window = input.windows[0];
      if (!window) throw new Error('Missing fixture window');
      window.result.contentType = contentType;
      expect(technicalSourceFromArtifact(input, id)).toMatchObject({ status: 'excluded', reason });
    }
  });
  it('rejects incomplete coverage, duplicate windows, unknown source IDs and fabricated quotes', () => {
    expect(() => technicalSourceFromArtifact(artifact(), 'c'.repeat(64))).toThrow();
    const missing = artifact();
    const missingWindow = missing.windows[0];
    if (!missingWindow) throw new Error('Missing fixture window');
    missingWindow.segmentIds = ['s1'];
    expect(() => technicalSourceFromArtifact(missing, id)).toThrow();
    const duplicate = artifact();
    const duplicateWindow = duplicate.windows[0];
    if (!duplicateWindow) throw new Error('Missing fixture window');
    duplicate.windows.push(duplicateWindow);
    expect(() => technicalSourceFromArtifact(duplicate, id)).toThrow();
    const fake = artifact();
    const fakeEvent = fake.windows[0]?.result.events[0];
    if (!fakeEvent) throw new Error('Missing fixture event');
    fakeEvent.quote = 'несуществующая цитата';
    expect(() => technicalSourceFromArtifact(fake, id)).toThrow();
    const stale = artifact();
    const staleWindow = stale.windows[0];
    if (!staleWindow) throw new Error('Missing fixture window');
    staleWindow.version = 'old-version';
    expect(() => technicalSourceFromArtifact(stale, id)).toThrow();
    const unreviewed = artifact();
    const unreviewedWindow = unreviewed.windows[0];
    if (!unreviewedWindow) throw new Error('Missing fixture window');
    unreviewedWindow.result.validationVersion = 'technical-markers-v2';
    expect(() => technicalSourceFromArtifact(unreviewed, id)).toThrow();
  });
});
