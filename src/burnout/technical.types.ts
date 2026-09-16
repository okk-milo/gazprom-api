import { parseAudioFacts, type AudioFacts } from './audio-facts';

export const eventKinds = [
  'clarification',
  'repeat_request',
  'self_correction',
  'explicit_complaint',
  'escalation_request',
] as const;
export type EventKind = (typeof eventKinds)[number];
export const metricKeys = ['repetition', 'correction', 'complaint', 'speechDensity'] as const;
export type MetricKey = (typeof metricKeys)[number];
export type TechnicalScores = Record<MetricKey, number>;
export interface TechnicalEvidence {
  kind: EventKind;
  segmentId: string;
  quote: string;
  startMs: number;
  endMs: number;
}
export interface TechnicalFacts {
  audio?: AudioFacts;
  durationSeconds: number;
  speechMs: number;
  words: number;
  segmentCount: number;
  events: TechnicalEvidence[];
}
export type TechnicalSource =
  | { id: string; status: 'measured'; fingerprint: string; model: string; facts: TechnicalFacts }
  | {
      id: string;
      status: 'excluded' | 'failed';
      reason:
        | 'invalid_timestamps'
        | 'insufficient_speech'
        | 'unclear_content'
        | 'monologue'
        | 'extraction_failed';
    };
export interface TechnicalDataset {
  id: string;
  version: 'technical-dialogue-v1';
  periodStart: string;
  sources: TechnicalSource[];
}
export interface TechnicalMeasures {
  scores: TechnicalScores;
  index: number;
  rates: Record<'repetition' | 'correction' | 'complaint', number>;
  durationSeconds: number;
  speechSeconds: number;
  words: number;
  counts: Record<EventKind, number>;
}
export interface TechnicalWeek {
  index: number;
  start: string;
  end: string;
  sourceIds: string[];
  measures: TechnicalMeasures | null;
}
export interface TechnicalDatasetView {
  version: 'technical-dialogue-v1';
  periodStart: string;
  ordering: 'score_sorted_conditional';
  coverage: { total: number; measured: number; excluded: number; failed: number };
  weeks: TechnicalWeek[];
  overall: TechnicalMeasures | null;
  baseline: TechnicalMeasures | null;
  recent: TechnicalMeasures | null;
  sources: Array<{
    id: string;
    status: TechnicalSource['status'];
    reason: string | null;
    week: number | null;
    index: number | null;
  }>;
  observations: Array<TechnicalEvidence & { sourceId: string }>;
}

export function technicalRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid technical data');
  return Object.fromEntries(Object.entries(value));
}
function bounded(value: unknown, max: number, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error('Invalid technical number');
  return value;
}
export function technicalDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error('Invalid technical date');
  return value;
}
export function parseTechnicalDataset(raw: unknown): TechnicalDataset {
  const input = technicalRecord(raw);
  if (
    input.version !== 'technical-dialogue-v1' ||
    typeof input.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.id) ||
    !Array.isArray(input.sources) ||
    input.sources.length > 500
  )
    throw new Error('Invalid technical dataset');
  const seen = new Set<string>();
  const sources = input.sources.map((rawSource: unknown): TechnicalSource => {
    const s = technicalRecord(rawSource);
    if (typeof s.id !== 'string' || !/^[a-f0-9]{64}$/.test(s.id) || seen.has(s.id))
      throw new Error('Invalid technical source');
    seen.add(s.id);
    if (s.status === 'excluded' || s.status === 'failed') {
      if (
        s.reason !== 'invalid_timestamps' &&
        s.reason !== 'insufficient_speech' &&
        s.reason !== 'unclear_content' &&
        s.reason !== 'monologue' &&
        s.reason !== 'extraction_failed'
      )
        throw new Error('Invalid exclusion');
      return { id: s.id, status: s.status, reason: s.reason };
    }
    if (
      s.status !== 'measured' ||
      typeof s.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(s.fingerprint) ||
      typeof s.model !== 'string' ||
      !s.model ||
      s.model.length > 120
    )
      throw new Error('Invalid measurement origin');
    const facts = technicalRecord(s.facts);
    const durationSeconds = bounded(facts.durationSeconds, 1800);
    const speechMs = bounded(facts.speechMs, Math.round(durationSeconds * 1000), true);
    const segmentCount = bounded(facts.segmentCount, 5000, true);
    const words = bounded(facts.words, 50000, true);
    if (
      speechMs < 10000 ||
      words < 20 ||
      segmentCount < 2 ||
      !Array.isArray(facts.events) ||
      facts.events.length > segmentCount * eventKinds.length
    )
      throw new Error('Insufficient measured speech');
    const keys = new Set<string>();
    const events = facts.events.map((rawEvent: unknown): TechnicalEvidence => {
      const e = technicalRecord(rawEvent);
      const kind = eventKinds.find((k) => k === e.kind);
      if (
        !kind ||
        typeof e.segmentId !== 'string' ||
        !e.segmentId ||
        e.segmentId.length > 80 ||
        typeof e.quote !== 'string' ||
        !e.quote.trim() ||
        e.quote.length > 500
      )
        throw new Error('Invalid technical evidence');
      const key = `${kind}:${e.segmentId}`;
      const startMs = bounded(e.startMs, Math.round(durationSeconds * 1000), true),
        endMs = bounded(e.endMs, Math.round(durationSeconds * 1000), true);
      if (endMs <= startMs || keys.has(key)) throw new Error('Invalid technical evidence bounds');
      keys.add(key);
      return { kind, segmentId: e.segmentId, quote: e.quote, startMs, endMs };
    });
    return {
      id: s.id,
      status: 'measured',
      fingerprint: s.fingerprint,
      model: s.model,
      facts: {
        durationSeconds,
        speechMs,
        words,
        segmentCount,
        events,
        ...(facts.audio === undefined
          ? {}
          : { audio: parseAudioFacts(facts.audio, durationSeconds) }),
      },
    };
  });
  return {
    id: input.id,
    version: 'technical-dialogue-v1',
    periodStart: technicalDate(input.periodStart),
    sources,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
// Fixed technical scale, not a clinical calibration or worker-performance threshold.
// Full scale: 2 repeats/clarifications, 1 self-correction, or 1 complaint/escalation per speech minute.
export function technicalMeasures(facts: TechnicalFacts[]): TechnicalMeasures | null {
  if (!facts.length) return null;
  const counts: Record<EventKind, number> = {
    clarification: 0,
    repeat_request: 0,
    self_correction: 0,
    explicit_complaint: 0,
    escalation_request: 0,
  };
  let speechMs = 0,
    durationSeconds = 0,
    words = 0;
  for (const f of facts) {
    speechMs += f.speechMs;
    durationSeconds += f.durationSeconds;
    words += f.words;
    for (const e of f.events) counts[e.kind] += 1;
  }
  if (speechMs <= 0 || durationSeconds <= 0) return null;
  const rates = {
    repetition: (counts.clarification + counts.repeat_request) / (speechMs / 60000),
    correction: counts.self_correction / (speechMs / 60000),
    complaint: (counts.explicit_complaint + counts.escalation_request) / (speechMs / 60000),
  };
  const scores = {
    repetition: round(Math.min(100, rates.repetition * 50)),
    correction: round(Math.min(100, rates.correction * 100)),
    complaint: round(Math.min(100, rates.complaint * 100)),
    speechDensity: round(Math.min(100, speechMs / (durationSeconds * 10))),
  };
  return {
    scores,
    index: round(
      scores.repetition * 0.35 +
        scores.correction * 0.25 +
        scores.complaint * 0.25 +
        scores.speechDensity * 0.15,
    ),
    rates: {
      repetition: round(rates.repetition),
      correction: round(rates.correction),
      complaint: round(rates.complaint),
    },
    durationSeconds: round(durationSeconds),
    speechSeconds: round(speechMs / 1000),
    words,
    counts,
  };
}

export function technicalView(dataset: TechnicalDataset): TechnicalDatasetView {
  const measured = dataset.sources
    .filter((s) => s.status === 'measured')
    .map((s) => ({ source: s, index: technicalMeasures([s.facts])?.index ?? 0 }))
    .sort((a, b) => a.index - b.index || a.source.id.localeCompare(b.source.id));
  // Only rearrange adjacent, similarly scored calls; never modify scores or force a weekly curve.
  for (let i = 4; i + 1 < measured.length; i += 7) {
    const a = measured[i],
      b = measured[i + 1];
    if (a && b && b.index - a.index <= 5) [measured[i], measured[i + 1]] = [b, a];
  }
  const assignment = new Map<string, number>();
  measured.forEach((item, i) =>
    assignment.set(item.source.id, Math.min(7, Math.floor((i * 8) / measured.length))),
  );
  const baseTime = Date.parse(`${dataset.periodStart}T00:00:00Z`);
  const date = (day: number) => new Date(baseTime + day * 86400000).toISOString().slice(0, 10);
  const weeks = Array.from({ length: 8 }, (_, index): TechnicalWeek => {
    const members = measured.filter((item) => assignment.get(item.source.id) === index);
    return {
      index,
      start: date(index * 7),
      end: date(index * 7 + 6),
      sourceIds: members.map((item) => item.source.id),
      measures: technicalMeasures(members.map((item) => item.source.facts)),
    };
  });
  const observations: TechnicalDatasetView['observations'] = [];
  for (const item of measured)
    for (const event of item.source.facts.events.slice(0, 2))
      if (observations.length < 32) observations.push({ ...event, sourceId: item.source.id });
  return {
    version: 'technical-dialogue-v1',
    periodStart: dataset.periodStart,
    ordering: 'score_sorted_conditional',
    coverage: {
      total: dataset.sources.length,
      measured: measured.length,
      excluded: dataset.sources.filter((s) => s.status === 'excluded').length,
      failed: dataset.sources.filter((s) => s.status === 'failed').length,
    },
    weeks,
    overall: technicalMeasures(measured.map((s) => s.source.facts)),
    baseline: technicalMeasures(
      measured.filter((s) => (assignment.get(s.source.id) ?? 8) < 2).map((s) => s.source.facts),
    ),
    recent: technicalMeasures(
      measured.filter((s) => (assignment.get(s.source.id) ?? -1) >= 6).map((s) => s.source.facts),
    ),
    sources: dataset.sources.map((s) => ({
      id: s.id,
      status: s.status,
      reason: s.status === 'measured' ? null : s.reason,
      week: assignment.get(s.id) ?? null,
      index: s.status === 'measured' ? (technicalMeasures([s.facts])?.index ?? null) : null,
    })),
    observations,
  };
}
