import { Test } from '@nestjs/testing';
import { AppConfig } from '../config/app-config';
import { ProcessingClients, type TranscriptionUpdate } from '../processing/processing-clients';
import { CallsRepository } from './calls.repository';
import { CallsService } from './calls.service';
import { ProcessingWorker } from './processing.worker';
import { type AntifraudAnalysis, type TranscriptSegment } from './calls.types';

function segment(id: string, start: number): TranscriptSegment {
  return {
    id,
    startMs: start,
    endMs: start + 9000,
    speaker: 'Неизвестный',
    text: 'Проверочная фраза.',
    highlightRanges: [],
  };
}
const analysis: AntifraudAnalysis = {
  score: 20,
  factorsFor: [],
  factorsAgainst: [],
  timeline: [],
  modelVersion: 'test',
};

describe('ProcessingWorker progressive pipeline', () => {
  it.each([false, true])(
    'publishes speech first and finalizes only a complete stream (failure=%s)',
    async (fail) => {
      const writes: Array<{ kind: string; ids?: string[]; score?: number }> = [];
      const repository = {
        claimNextCall: jest.fn(async () => ({ id: 'call' })),
        saveProgress: jest.fn(
          async (_id: string, segments: TranscriptSegment[], preview: AntifraudAnalysis | null) => {
            writes.push({
              kind: 'progress',
              ids: segments.map((s) => s.id),
              ...(preview ? { score: preview.score } : {}),
            });
          },
        ),
        complete: jest.fn(async () => {
          writes.push({ kind: 'complete' });
        }),
        completeWithoutSpeech: jest.fn(),
        fail: jest.fn(),
      };
      const clients = {
        async *streamTranscript(): AsyncGenerator<TranscriptionUpdate> {
          yield {
            type: 'progress',
            sequence: 0,
            processedMs: 10000,
            durationMs: 20000,
            segments: [segment('first', 0)],
          };
          if (fail) throw new Error('ASR connection lost');
          yield {
            type: 'progress',
            sequence: 1,
            processedMs: 20000,
            durationMs: 20000,
            segments: [segment('second', 10000)],
          };
          yield {
            type: 'complete',
            sequence: 2,
            processedMs: 20000,
            durationMs: 20000,
            segments: [segment('final-first', 0), segment('final-second', 10000)],
          };
        },
        assessFragment: jest.fn(async (segments: TranscriptSegment[]) => {
          writes.push({ kind: 'assess', ids: segments.map((s) => s.id) });
          return { analysis, context: { score: analysis.score, summary: '', last_turns: [] } };
        }),
        assess: jest.fn(async (segments: TranscriptSegment[]) => {
          writes.push({ kind: 'final', ids: segments.map((s) => s.id) });
          return { ...analysis, score: 10 };
        }),
      };
      const module = await Test.createTestingModule({
        providers: [
          ProcessingWorker,
          { provide: AppConfig, useValue: { mockProcessingEnabled: true } },
          { provide: CallsRepository, useValue: repository },
          { provide: CallsService, useValue: {} },
          { provide: ProcessingClients, useValue: clients },
        ],
      }).compile();
      try {
        await module.get(ProcessingWorker).processNextCall();
        expect(writes.slice(0, 2)).toEqual([
          { kind: 'progress', ids: ['first'] },
          { kind: 'assess', ids: ['first'] },
        ]);
        if (fail) {
          expect(repository.fail).toHaveBeenCalledWith('call', 'ASR connection lost');
          expect(clients.assess).not.toHaveBeenCalled();
          expect(repository.complete).not.toHaveBeenCalled();
        } else {
          expect(
            clients.assessFragment.mock.calls.map(([segments]) => segments.map((s) => s.id)),
          ).toEqual([['first'], ['second']]);
          expect(writes).toContainEqual({ kind: 'final', ids: ['final-first', 'final-second'] });
          expect(repository.complete).toHaveBeenCalledWith(
            'call',
            expect.objectContaining({
              score: 10,
              timeline: [
                { timestampMs: 10000, score: 20 },
                { timestampMs: 20000, score: 10 },
              ],
            }),
          );
          expect(repository.fail).not.toHaveBeenCalled();
        }
      } finally {
        await module.close();
      }
    },
  );
});
