import {
  eventKinds,
  technicalRecord,
  type TechnicalSource,
  type TechnicalEvidence,
} from './technical.types';

export function technicalSourceFromArtifact(raw: unknown, id: string): TechnicalSource {
  const input = technicalRecord(raw);
  if (
    input.version !== 'technical-events-v2-explicit-markers' ||
    input.sourceId !== id ||
    typeof input.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.fingerprint) ||
    typeof input.durationSeconds !== 'number' ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    input.durationSeconds > 1800 ||
    !Array.isArray(input.segments) ||
    !Array.isArray(input.windows) ||
    !input.windows.length
  )
    throw new Error('Invalid extraction artifact');
  if (
    typeof input.invalidSegments !== 'number' ||
    !Number.isInteger(input.invalidSegments) ||
    input.invalidSegments < 0
  )
    throw new Error('Invalid segment accounting');
  if (input.invalidSegments) return { id, status: 'excluded', reason: 'invalid_timestamps' };
  const segments = new Map<string, { startMs: number; endMs: number; text: string }>();
  for (const rawSegment of input.segments) {
    const s = technicalRecord(rawSegment);
    if (
      typeof s.id !== 'string' ||
      !s.id ||
      segments.has(s.id) ||
      typeof s.text !== 'string' ||
      !s.text.trim() ||
      typeof s.startMs !== 'number' ||
      typeof s.endMs !== 'number' ||
      !Number.isInteger(s.startMs) ||
      !Number.isInteger(s.endMs) ||
      s.startMs < 0 ||
      s.endMs <= s.startMs ||
      s.endMs > Math.round(input.durationSeconds * 1000)
    )
      throw new Error('Invalid extraction segment');
    segments.set(s.id, { text: s.text, startMs: s.startMs, endMs: s.endMs });
  }
  const covered = new Set<string>(),
    eventKeys = new Set<string>();
  const events: TechnicalEvidence[] = [];
  let model = '',
    conversations = 0,
    unclear = 0;
  for (const rawWindow of input.windows) {
    const w = technicalRecord(rawWindow),
      result = technicalRecord(w.result);
    if (
      w.version !== input.version ||
      typeof w.model !== 'string' ||
      !w.model ||
      (model && model !== w.model) ||
      !Array.isArray(w.segmentIds) ||
      !w.segmentIds.length ||
      !Array.isArray(result.events) ||
      result.validationVersion !== 'technical-markers-v4' ||
      result.events.length > 48 ||
      typeof result.discardedEvents !== 'number' ||
      !Number.isInteger(result.discardedEvents) ||
      result.discardedEvents < 0
    )
      throw new Error('Invalid extraction window');
    model = w.model;
    if (result.contentType === 'conversation') conversations += 1;
    else if (result.contentType === 'unclear') unclear += 1;
    else if (result.contentType !== 'monologue') throw new Error('Invalid content classification');
    for (const key of w.segmentIds) {
      if (typeof key !== 'string' || !segments.has(key) || covered.has(key))
        throw new Error('Overlapping extraction windows');
      covered.add(key);
    }
    for (const rawEvent of result.events) {
      const e = technicalRecord(rawEvent),
        kind = eventKinds.find((k) => k === e.kind);
      const segment = typeof e.segmentId === 'string' ? segments.get(e.segmentId) : null;
      if (
        !kind ||
        typeof e.segmentId !== 'string' ||
        !w.segmentIds.includes(e.segmentId) ||
        !segment ||
        typeof e.quote !== 'string' ||
        e.quote.trim().length < 3 ||
        e.quote.length > 500 ||
        !segment.text.includes(e.quote) ||
        eventKeys.has(`${kind}:${e.segmentId}`)
      )
        throw new Error('Invalid extraction quote');
      eventKeys.add(`${kind}:${e.segmentId}`);
      events.push({
        kind,
        segmentId: e.segmentId,
        quote: e.quote,
        startMs: segment.startMs,
        endMs: segment.endMs,
      });
    }
  }
  if (covered.size !== segments.size) throw new Error('Incomplete extraction coverage');
  if (unclear) return { id, status: 'excluded', reason: 'unclear_content' };
  if (!conversations) return { id, status: 'excluded', reason: 'monologue' };
  let speechMs = 0,
    end = 0,
    words = 0;
  for (const s of [...segments.values()].sort((a, b) => a.startMs - b.startMs)) {
    speechMs += Math.max(0, s.endMs - Math.max(s.startMs, end));
    end = Math.max(end, s.endMs);
    words += s.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  }
  if (speechMs < 10000 || words < 20 || segments.size < 2)
    return { id, status: 'excluded', reason: 'insufficient_speech' };
  return {
    id,
    status: 'measured',
    fingerprint: input.fingerprint,
    model,
    facts: {
      durationSeconds: input.durationSeconds,
      speechMs,
      words,
      segmentCount: segments.size,
      events,
    },
  };
}
