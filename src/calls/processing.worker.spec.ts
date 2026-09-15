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
  it.each(['complete', 'asr-error', 'final-role-error'] as const)(
    'publishes reviewed roles and retains them through finalization (%s)',
    async (outcome) => {
      const writes: Array<{ kind: string; ids?: string[]; roles?: string[]; score?: number }> = [];
      const repository = {
        claimNextCall: jest.fn(async () => ({ id: 'call' })),
        saveProgress: jest.fn(
          async (_id: string, segments: TranscriptSegment[], preview: AntifraudAnalysis | null) => {
            writes.push({
              kind: 'progress',
              ids: segments.map((s) => s.id),
              roles: segments.map((s) => s.speaker),
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
          if (outcome === 'asr-error') throw new Error('ASR connection lost');
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
          for (const item of segments) item.speaker = 'Оператор';
          return { analysis, context: { score: analysis.score, summary: '', last_turns: [] } };
        }),
        assess: jest.fn(
          async (
            segments: TranscriptSegment[],
            onProgress?: (
              value: AntifraudAnalysis,
              processed: number,
              total: number,
            ) => Promise<void>,
          ) => {
            writes.push({ kind: 'final', ids: segments.map((s) => s.id) });
            if (segments[0]) segments[0].speaker = 'Клиент';
            // The remaining final transcript still has raw roles at this point.
            await onProgress?.(analysis, 1, segments.length);
            if (outcome === 'final-role-error') throw new Error('Final role assessment failed');
            for (const item of segments) item.speaker = 'Клиент';
            return { ...analysis, score: 10 };
          },
        ),
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
          { kind: 'assess', ids: ['first'] },
          { kind: 'progress', ids: ['first'], roles: ['Оператор'], score: 20 },
        ]);
        for (const write of writes.filter((item) => item.kind === 'progress')) {
          expect(write.roles?.every((role) => role === 'Оператор')).toBe(true);
          expect(write.ids?.some((id) => id.startsWith('final'))).toBe(false);
        }
        if (outcome !== 'complete') {
          expect(repository.fail).toHaveBeenCalledWith(
            'call',
            outcome === 'asr-error' ? 'ASR connection lost' : 'Final role assessment failed',
          );
          if (outcome === 'asr-error') expect(clients.assess).not.toHaveBeenCalled();
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
            [
              expect.objectContaining({ id: 'final-first', speaker: 'Клиент' }),
              expect.objectContaining({ id: 'final-second', speaker: 'Клиент' }),
            ],
          );
          expect(repository.fail).not.toHaveBeenCalled();
        }
      } finally {
        await module.close();
      }
    },
  );
});
