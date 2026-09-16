export interface AudioFacts {
  version: 'silero-activity-v1';
  durationMs: number;
  voicedMs: number;
  longPauseMs: number;
  longPauseCount: number;
}

export function parseAudioFacts(raw: unknown, durationSeconds: number): AudioFacts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid audio facts');
  const a = Object.fromEntries(Object.entries(raw));
  const number = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new Error('Invalid audio number');
    return value;
  };
  if (a.version !== 'silero-activity-v1') throw new Error('Unknown audio method');
  const durationMs = number(a.durationMs),
    voicedMs = number(a.voicedMs);
  const longPauseMs = number(a.longPauseMs),
    longPauseCount = number(a.longPauseCount);
  if (
    Math.abs(durationMs - durationSeconds * 1000) > 1000 ||
    voicedMs < 10000 ||
    voicedMs + longPauseMs > durationMs ||
    longPauseMs < longPauseCount * 2000 ||
    (longPauseCount === 0) !== (longPauseMs === 0)
  )
    throw new Error('Invalid audio bounds');
  return { version: a.version, durationMs, voicedMs, longPauseMs, longPauseCount };
}
