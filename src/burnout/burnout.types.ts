export const scaleKeys = ['exhaustion', 'distance', 'speechInconsistency', 'workload'] as const;
export type ScaleKey = (typeof scaleKeys)[number];
export type WeeklyScores = Record<ScaleKey, number>;

export interface BurnoutSource {
  id: string;
  processedAt: string;
  durationSeconds: number;
  scenarioDate: string;
  screening: 'dialogue_candidate' | 'monologue' | 'unintelligible' | 'uncertain';
  screeningState: 'not_screened' | 'screened' | 'failed';
  review: 'accepted' | 'excluded' | 'pending';
}

export const observationKinds = [
  'clarification',
  'repeat_request',
  'self_correction',
  'explicit_complaint',
  'escalation_request',
  'procedure_explanation',
] as const;
export interface BurnoutObservation {
  sourceId: string;
  segmentId: string;
  kind: (typeof observationKinds)[number];
  startMs: number;
  endMs: number;
  quote: string;
  review: 'text_checked';
  speaker: 'unknown';
}

export interface BurnoutDataset {
  id: string;
  periodStart: string;
  provenance: 'authored_scenario';
  employeeName: 'Сотрудник примера';
  weeklyScores: WeeklyScores[];
  sources: BurnoutSource[];
  observations: BurnoutObservation[];
}

export interface BurnoutDatasetView extends BurnoutDataset {
  weeklyCoverage: Array<{
    index: number;
    accepted: number;
    pending: number;
    excluded: number;
    audioSeconds: number;
  }>;
  coverage: { accepted: number; pending: number; excluded: number; total: number };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error('Unexpected dataset fields');
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}

export function dateMillis(value: unknown): number {
  const date = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date format');
  const millis = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid calendar date');
  }
  return millis;
}

function score(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('Score outside 0–100');
  }
  return value;
}

export function parseDataset(raw: unknown): BurnoutDataset {
  const input = object(raw);
  exactKeys(input, [
    'id',
    'periodStart',
    'provenance',
    'employeeName',
    'weeklyScores',
    'sources',
    'observations',
  ]);
  const id = text(input.id);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error('Invalid dataset ID');
  }
  const periodStart = text(input.periodStart);
  const start = dateMillis(periodStart);
  if (input.provenance !== 'authored_scenario' || input.employeeName !== 'Сотрудник примера') {
    throw new Error('Only a fictional scenario dataset is supported');
  }
  if (!Array.isArray(input.weeklyScores) || input.weeklyScores.length !== 8)
    throw new Error('Expected eight weeks');
  const weeklyScores = input.weeklyScores.map((rawWeek: unknown): WeeklyScores => {
    const week = object(rawWeek);
    exactKeys(week, [...scaleKeys]);
    return {
      exhaustion: score(week.exhaustion),
      distance: score(week.distance),
      speechInconsistency: score(week.speechInconsistency),
      workload: score(week.workload),
    };
  });
  if (!Array.isArray(input.sources) || input.sources.length > 500)
    throw new Error('Invalid source count');
  const seen = new Set<string>();
  const sources = input.sources.map((rawSource: unknown): BurnoutSource => {
    const source = object(rawSource);
    exactKeys(source, [
      'id',
      'processedAt',
      'durationSeconds',
      'scenarioDate',
      'screening',
      'screeningState',
      'review',
    ]);
    const sourceId = text(source.id);
    if (!/^[a-f0-9]{64}$/.test(sourceId) || seen.has(sourceId))
      throw new Error('Invalid or duplicate source');
    seen.add(sourceId);
    const processedAt = text(source.processedAt);
    const processedMillis = Date.parse(processedAt);
    if (
      !Number.isFinite(processedMillis) ||
      new Date(processedMillis).toISOString() !== processedAt
    )
      throw new Error('Invalid processing timestamp');
    const durationSeconds = source.durationSeconds;
    if (
      typeof durationSeconds !== 'number' ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > 1800
    ) {
      throw new Error('Invalid audio duration');
    }
    const scenarioDate = text(source.scenarioDate);
    const offset = dateMillis(scenarioDate) - start;
    if (offset < 0 || offset >= 56 * 86400000) throw new Error('Source outside the scenario');
    const screening = source.screening;
    if (
      screening !== 'dialogue_candidate' &&
      screening !== 'monologue' &&
      screening !== 'unintelligible' &&
      screening !== 'uncertain'
    ) {
      throw new Error('Invalid screening');
    }
    const review = source.review;
    const screeningState = source.screeningState;
    if (
      screeningState !== 'not_screened' &&
      screeningState !== 'screened' &&
      screeningState !== 'failed'
    )
      throw new Error('Invalid screening state');
    if (screeningState !== 'screened' && (screening !== 'uncertain' || review !== 'pending'))
      throw new Error('Unscreened sources cannot be accepted or excluded');
    if (review !== 'accepted' && review !== 'excluded' && review !== 'pending')
      throw new Error('Invalid review');
    if (review === 'accepted' && screening !== 'dialogue_candidate')
      throw new Error('Only reviewed dialogue candidates may be accepted');
    return {
      id: sourceId,
      processedAt,
      durationSeconds,
      scenarioDate,
      screening,
      screeningState,
      review,
    };
  });
  if (!Array.isArray(input.observations) || input.observations.length > 32)
    throw new Error('Invalid observation count');
  const observed = new Set<string>();
  const observations = input.observations.map((rawObservation: unknown): BurnoutObservation => {
    const item = object(rawObservation);
    exactKeys(item, [
      'sourceId',
      'segmentId',
      'kind',
      'startMs',
      'endMs',
      'quote',
      'review',
      'speaker',
    ]);
    const sourceId = text(item.sourceId);
    const source = sources.find((candidate) => candidate.id === sourceId);
    const segmentId = text(item.segmentId);
    const kind = observationKinds.find((candidate) => candidate === item.kind);
    const key = `${sourceId}:${segmentId}:${String(kind)}`;
    const startMs = item.startMs;
    const endMs = item.endMs;
    const quote = text(item.quote);
    if (
      !source ||
      !kind ||
      !segmentId ||
      segmentId.length > 80 ||
      observed.has(key) ||
      item.review !== 'text_checked' ||
      item.speaker !== 'unknown' ||
      !quote.trim() ||
      quote.length > 1500 ||
      typeof startMs !== 'number' ||
      typeof endMs !== 'number' ||
      !Number.isInteger(startMs) ||
      !Number.isInteger(endMs) ||
      startMs < 0 ||
      endMs <= startMs ||
      endMs > Math.round(source.durationSeconds * 1000)
    )
      throw new Error('Invalid source observation');
    observed.add(key);
    return {
      sourceId,
      segmentId,
      kind,
      startMs,
      endMs,
      quote,
      review: 'text_checked',
      speaker: 'unknown',
    };
  });
  return {
    id,
    periodStart,
    provenance: 'authored_scenario',
    employeeName: 'Сотрудник примера',
    weeklyScores,
    sources,
    observations,
  };
}

export function datasetView(dataset: BurnoutDataset): BurnoutDatasetView {
  const weeklyCoverage = Array.from({ length: 8 }, (_, index) => ({
    index,
    accepted: 0,
    pending: 0,
    excluded: 0,
    audioSeconds: 0,
  }));
  const coverage = { accepted: 0, pending: 0, excluded: 0, total: dataset.sources.length };
  for (const source of dataset.sources) {
    const index = Math.floor(
      (dateMillis(source.scenarioDate) - dateMillis(dataset.periodStart)) / (7 * 86400000),
    );
    const week = weeklyCoverage[index];
    if (!week) throw new Error('Invalid week');
    week[source.review] += 1;
    coverage[source.review] += 1;
    if (source.review === 'accepted') week.audioSeconds += source.durationSeconds;
  }
  return { ...dataset, weeklyCoverage, coverage };
}
