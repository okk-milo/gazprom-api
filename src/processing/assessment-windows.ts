import {
  type AnalysisFactor,
  type AntifraudAnalysis,
  type TranscriptSegment,
} from '../calls/calls.types';

// Match the internal LLM window contract, leaving room for instructions and memory.
export function buildAssessmentWindows(transcript: TranscriptSegment[]): TranscriptSegment[][] {
  const windows: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let characters = 0;
  for (const segment of transcript) {
    if (segment.text.length > 2000)
      throw new Error('Speech segment exceeds the analysis window limit');
    const first = current[0];
    if (
      first &&
      (current.length >= 32 ||
        characters + segment.text.length > 4000 ||
        segment.endMs - first.startMs > 120000)
    ) {
      windows.push(current);
      current = [];
      characters = 0;
    }
    current.push(segment);
    characters += segment.text.length;
  }
  if (current.length) windows.push(current);
  return windows;
}

export function mergeEvidence(
  previous: AnalysisFactor[],
  current: AnalysisFactor[],
): AnalysisFactor[] {
  const factors = new Map(previous.map((factor) => [factor.title, factor]));
  for (const factor of current) factors.set(factor.title, factor);
  return [...factors.values()].slice(-5);
}

export function mergeAssessment(
  previous: AntifraudAnalysis | null,
  current: AntifraudAnalysis,
): AntifraudAnalysis {
  return {
    ...current,
    factorsFor: mergeEvidence(previous?.factorsFor ?? [], current.factorsFor),
    factorsAgainst: mergeEvidence(previous?.factorsAgainst ?? [], current.factorsAgainst),
    timeline: [...(previous?.timeline ?? []), ...current.timeline],
  };
}
