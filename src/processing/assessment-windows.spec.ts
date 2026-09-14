import { type TranscriptSegment } from '../calls/calls.types';
import { buildAssessmentWindows, mergeAssessment } from './assessment-windows';

const segment = (index: number, text = 'Проверочная реплика'): TranscriptSegment => ({
  id: String(index),
  startMs: index * 2000,
  endMs: (index + 1) * 2000,
  text,
  speaker: 'SPEAKER_00',
  highlightRanges: [],
});

describe('assessment windows', () => {
  it('covers all 326 segments in order without duplication or a total length limit', () => {
    const transcript = Array.from({ length: 326 }, (_, index) => segment(index));
    const windows = buildAssessmentWindows(transcript);
    expect(windows.flat()).toEqual(transcript);
    expect(windows.every((window) => window.length <= 32)).toBe(true);
    expect(windows.length).toBeGreaterThan(1);
  });

  it('bounds input characters and elapsed audio independently', () => {
    const longText = Array.from({ length: 10 }, (_, index) => segment(index, 'я'.repeat(1800)));
    expect(
      buildAssessmentWindows(longText).every(
        (window) => window.reduce((n, item) => n + item.text.length, 0) <= 4000,
      ),
    ).toBe(true);
    const withPause = [segment(0), segment(100)];
    expect(buildAssessmentWindows(withPause)).toHaveLength(2);
  });

  it('keeps identical measured scores and never manufactures changing values', () => {
    const first = {
      score: 5,
      factorsFor: [],
      factorsAgainst: [],
      timeline: [{ timestampMs: 1000, score: 5 }],
      modelVersion: 'test',
    };
    const second = { ...first, timeline: [{ timestampMs: 2000, score: 5 }] };
    expect(mergeAssessment(first, second).timeline).toEqual([
      { timestampMs: 1000, score: 5 },
      { timestampMs: 2000, score: 5 },
    ]);
  });
});
