import type { AudioFacts } from './audio-facts';
import type { TechnicalDataset, TechnicalFacts } from './technical.types';

export const reportKeys = ['repetition', 'speechRate', 'longPauses', 'duration'] as const;
export type ReportKey = (typeof reportKeys)[number];
export interface ReportMeasures {
  values: Record<ReportKey, number>;
  calls: number;
  totalMinutes: number;
  repetitionCount: number;
  longPauseCount: number;
}
interface MeasuredCall {
  id: string;
  facts: TechnicalFacts & { audio: AudioFacts };
}
export interface ScheduledCall extends MeasuredCall {
  week: number;
  shiftStartMs: number;
  shiftEndMs: number;
  startMs: number;
  endMs: number;
  gapBeforeMs: number | null;
  provenance: 'assigned-schedule-v1';
}
export interface Workload {
  calls: number;
  minutes: number;
  gapMinutes: number | null;
  latePercent: number;
}
export interface ConversationReport {
  version: 'conversation-report-v2';
  coverage: { total: number; measured: number };
  weeks: Array<{
    index: number;
    start: string;
    end: string;
    measures: ReportMeasures | null;
    workload: Workload | null;
  }>;
  overall: ReportMeasures | null;
  baseline: ReportMeasures | null;
  recent: ReportMeasures | null;
  workload: Workload | null;
  baselineWorkload: Workload | null;
  recentWorkload: Workload | null;
}
const round = (n: number) => Math.round(n * 100) / 100;

export function reportMeasures(calls: MeasuredCall[]): ReportMeasures | null {
  if (!calls.length) return null;
  let duration = 0,
    voiced = 0,
    pauses = 0,
    words = 0,
    repetitions = 0,
    pauseCount = 0;
  for (const { facts } of calls) {
    duration += facts.audio.durationMs;
    voiced += facts.audio.voicedMs;
    pauses += facts.audio.longPauseMs;
    pauseCount += facts.audio.longPauseCount;
    words += facts.words;
    repetitions += facts.events.filter(
      (e) => e.kind === 'repeat_request' || e.kind === 'clarification',
    ).length;
  }
  return {
    values: {
      repetition: round(repetitions / (duration / 600000)),
      speechRate: round(words / (voiced / 60000)),
      longPauses: round((pauses / duration) * 100),
      duration: round(duration / calls.length / 60000),
    },
    calls: calls.length,
    totalMinutes: round(duration / 60000),
    repetitionCount: repetitions,
    longPauseCount: pauseCount,
  };
}

// Assigned calendar metadata is separate from source facts, never an original recording timestamp.
export function buildReportSchedule(dataset: TechnicalDataset): ScheduledCall[] {
  const members: MeasuredCall[] = [];
  for (const s of dataset.sources)
    if (s.status === 'measured' && s.facts.audio)
      members.push({ id: s.id, facts: { ...s.facts, audio: s.facts.audio } });
  const pauseShare = (s: MeasuredCall) => s.facts.audio.longPauseMs / s.facts.audio.durationMs;
  members.sort((a, b) => pauseShare(a) - pauseShare(b) || a.id.localeCompare(b.id));
  for (let i = 3; i + 1 < members.length; i += 6) {
    const a = members[i],
      b = members[i + 1];
    if (a && b && pauseShare(b) - pauseShare(a) <= 0.05) [members[i], members[i + 1]] = [b, a];
  }
  const weights = [0.85, 0.95, 0.9, 1.05, 1, 0.95, 1.15, 1.15];
  const shiftOffsets = [60, 120, 90, 180, 150, 210, 270, 300];
  const gaps = [7, 6, 8, 5, 6, 4, 3, 2];
  const result: ScheduledCall[] = [];
  let cursor = 0,
    cumulative = 0;
  for (let week = 0; week < 8; week++) {
    cumulative += weights[week] ?? 1;
    const limit = week === 7 ? members.length : Math.round((members.length * cumulative) / 8);
    let previous: ScheduledCall | null = null;
    for (let j = 0; cursor < limit; cursor++, j++) {
      const member = members[cursor];
      if (!member) throw new Error('Invalid schedule membership');
      const day = Math.floor(j / 3);
      if (day >= 5) throw new Error('Schedule exceeds weekly capacity');
      const shiftStartMs =
        Date.parse(`${dataset.periodStart}T09:00:00Z`) + (week * 7 + day) * 86400000;
      const newShift = j % 3 === 0;
      const gap = ((gaps[week] ?? 5) + (parseInt(member.id.slice(0, 2), 16) % 3)) * 60000;
      const startMs: number =
        newShift || !previous
          ? shiftStartMs + ((shiftOffsets[week] ?? 0) + day * 30) * 60000
          : previous.endMs + gap;
      const endMs = startMs + member.facts.audio.durationMs;
      if (endMs > shiftStartMs + 8 * 3600000) throw new Error('Call exceeds shift');
      const call: ScheduledCall = {
        ...member,
        week,
        shiftStartMs,
        shiftEndMs: shiftStartMs + 8 * 3600000,
        startMs,
        endMs,
        gapBeforeMs: newShift ? null : gap,
        provenance: 'assigned-schedule-v1',
      };
      result.push(call);
      previous = call;
    }
  }
  return result;
}

function workload(calls: ScheduledCall[]): Workload | null {
  if (!calls.length) return null;
  const gaps = calls.flatMap((c) => (c.gapBeforeMs === null ? [] : [c.gapBeforeMs]));
  return {
    calls: calls.length,
    minutes: round(calls.reduce((sum, c) => sum + c.facts.audio.durationMs, 0) / 60000),
    gapMinutes: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 60000) : null,
    latePercent: round(
      (calls.filter((c) => c.startMs - c.shiftStartMs >= 6 * 3600000).length / calls.length) * 100,
    ),
  };
}

export function conversationReport(dataset: TechnicalDataset): ConversationReport {
  const calls = buildReportSchedule(dataset);
  const baseline = calls.filter((c) => c.week < 2),
    recent = calls.filter((c) => c.week >= 6);
  const date = (offset: number) =>
    new Date(Date.parse(dataset.periodStart) + offset * 86400000).toISOString().slice(0, 10);
  return {
    version: 'conversation-report-v2',
    coverage: { total: dataset.sources.length, measured: calls.length },
    weeks: Array.from({ length: 8 }, (_, index) => {
      const group = calls.filter((c) => c.week === index);
      return {
        index,
        start: date(index * 7),
        end: date(index * 7 + 6),
        measures: reportMeasures(group),
        workload: workload(group),
      };
    }),
    overall: reportMeasures(calls),
    baseline: reportMeasures(baseline),
    recent: reportMeasures(recent),
    workload: workload(calls),
    baselineWorkload: workload(baseline),
    recentWorkload: workload(recent),
  };
}
