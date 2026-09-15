import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseDataset, type BurnoutObservation, type BurnoutSource } from './burnout.types';

interface Segment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid input');
  return Object.fromEntries(Object.entries(raw));
}
function asrInput(raw: unknown): { durationSeconds: number; segments: Segment[] } {
  const input = record(raw);
  if (typeof input.durationSeconds !== 'number' || !Array.isArray(input.segments))
    throw new Error('Invalid ASR');
  const segments = input.segments.map((value: unknown): Segment => {
    const segment = record(value);
    if (
      typeof segment.id !== 'string' ||
      typeof segment.text !== 'string' ||
      typeof segment.startMs !== 'number' ||
      typeof segment.endMs !== 'number'
    )
      throw new Error('Invalid segment');
    return { id: segment.id, text: segment.text, startMs: segment.startMs, endMs: segment.endMs };
  });
  return { durationSeconds: input.durationSeconds, segments };
}

// Curated references were checked against the transcript, not against speaker identity.
// No recording text or psychological scores derived from speech are stored in source control.
const selections: Array<{ sourceId: string; segmentId: string; kind: BurnoutObservation['kind'] }> =
  [
    {
      sourceId: '348d9a879d48fd65fc267b5fdbef4bc7a6e0196927f741962b4dbdc7232bc994',
      segmentId: '6',
      kind: 'clarification',
    },
    {
      sourceId: '29c29880f44570346417ccea3150f674242f3c6210c14119a30cef69b47d9d8b',
      segmentId: '21',
      kind: 'repeat_request',
    },
  ];
const authored = {
  exhaustion: [34, 36, 39, 44, 52, 67, 76, 82],
  distance: [38, 35, 41, 40, 49, 59, 68, 73],
  speechInconsistency: [18, 21, 24, 30, 39, 47, 55, 63],
  workload: [32, 36, 40, 50, 57, 71, 82, 89],
};

async function main(): Promise<void> {
  const [inputArg, screeningArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !screeningArg || !outputArg)
    throw new Error('Expected ASR directory, screening directory and output file');
  const inputRoot = path.resolve(inputArg);
  const screeningRoot = path.resolve(screeningArg);
  const sources: BurnoutSource[] = [];
  const observations: BurnoutObservation[] = [];
  const periodStart = '2026-07-27';
  let invalidTimestampSegments = 0;
  for (const name of (await readdir(inputRoot)).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const sourceId = name.slice(0, -5);
    const file = path.join(inputRoot, name);
    const input = asrInput(JSON.parse(await readFile(file, 'utf8')));
    let screening: BurnoutSource['screening'] = 'uncertain';
    let screeningState: BurnoutSource['screeningState'] = 'not_screened';
    try {
      const result = record(JSON.parse(await readFile(path.join(screeningRoot, name), 'utf8')));
      if (
        result.state === 'screened' &&
        (result.kind === 'dialogue_candidate' ||
          result.kind === 'monologue' ||
          result.kind === 'unintelligible' ||
          result.kind === 'uncertain')
      ) {
        screening = result.kind;
        screeningState = 'screened';
      } else screeningState = 'failed';
    } catch (error: unknown) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
    }
    // Round-robin membership is illustrative, independent of content, model scores or file dates.
    const index = sources.length % 8;
    sources.push({
      id: sourceId,
      processedAt: (await stat(file)).mtime.toISOString(),
      durationSeconds: input.durationSeconds,
      scenarioDate: new Date(Date.parse(periodStart) + index * 7 * 86400000)
        .toISOString()
        .slice(0, 10),
      screening,
      screeningState,
      review: 'pending',
    });
    invalidTimestampSegments += input.segments.filter(
      (segment) =>
        segment.startMs < 0 ||
        segment.endMs <= segment.startMs ||
        segment.endMs > Math.round(input.durationSeconds * 1000),
    ).length;
    for (const selection of selections.filter((item) => item.sourceId === sourceId)) {
      const segment = input.segments.find((item) => item.id === selection.segmentId);
      if (!segment) throw new Error('Selected source segment unavailable');
      observations.push({
        ...selection,
        startMs: segment.startMs,
        endMs: segment.endMs,
        quote: segment.text,
        review: 'text_checked',
        speaker: 'unknown',
      });
    }
  }
  if (observations.length !== selections.length) throw new Error('Selected source unavailable');
  const dataset = parseDataset({
    id: '6dca1f5e-16b9-49c2-b164-cadf2e73a615',
    periodStart,
    provenance: 'authored_scenario',
    employeeName: 'Сотрудник примера',
    sources,
    observations,
    weeklyScores: Array.from({ length: 8 }, (_, index) => ({
      exhaustion: authored.exhaustion[index],
      distance: authored.distance[index],
      speechInconsistency: authored.speechInconsistency[index],
      workload: authored.workload[index],
    })),
  });
  // Exclusive creation prevents accidental replacement of an existing reviewed dataset.
  await writeFile(path.resolve(outputArg), JSON.stringify(dataset), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({
      sources: sources.length,
      screened: sources.filter((source) => source.screeningState === 'screened').length,
      observations: observations.length,
      invalidTimestampSegments,
    }),
  );
}

void main().catch(() => {
  process.stderr.write('scenario_preparation_failed\n');
  process.exitCode = 1;
});
