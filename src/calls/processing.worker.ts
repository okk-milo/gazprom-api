import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfig } from '../config/app-config';
import { ProcessingClients, type WindowContext } from '../processing/processing-clients';
import { buildAssessmentWindows } from '../processing/assessment-windows';
import { type AntifraudAnalysis, type RiskPoint, type TranscriptSegment } from './calls.types';
import { CallsRepository } from './calls.repository';
import { CallsService } from './calls.service';
import { DatabaseService, type DatabaseLock } from '../database/database.service';

const ANTIFRAUD_WORKER_LOCK = 614001;

@Injectable()
export class ProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessingWorker.name);
  private isProcessing = false;
  private workerLock: DatabaseLock | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: CallsRepository,
    private readonly callsService: CallsService,
    private readonly clients: ProcessingClients,
    private readonly database: DatabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.callsService.bootstrap();
    this.workerLock = await this.database.tryAcquireLock(ANTIFRAUD_WORKER_LOCK);
    if (!this.workerLock) {
      this.logger.warn('Another antifraud worker owns processing; recovery and processing skipped');
      return;
    }
    const recovered = await this.repository.failInterruptedCalls();
    if (recovered) this.logger.warn(`Marked ${recovered} interrupted calls as failed`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.workerLock?.release();
  }

  private assertOwnership(): void {
    if (!this.workerLock?.isHeld()) throw new Error('Processing interrupted: worker lock lost');
  }

  @Interval(1000)
  async processNextCall(): Promise<void> {
    if (this.isProcessing || !this.workerLock?.isHeld()) {
      return;
    }

    this.isProcessing = true;
    let callId: string | null = null;

    try {
      const call = await this.repository.claimNextCall();

      if (!call) {
        return;
      }

      this.assertOwnership();

      callId = call.id;

      const sourceUrl = this.config.mockProcessingEnabled
        ? 'mock://audio'
        : await this.callsService.getDownloadUrl(call.id);
      await this.processStream(call.id, sourceUrl);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка обработки';
      this.logger.error(message);
      if (callId && this.workerLock?.isHeld()) {
        await this.repository.fail(callId, message);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processStream(callId: string, sourceUrl: string): Promise<void> {
    const transcript: TranscriptSegment[] = [];
    let finalTranscript: TranscriptSegment[] | null = null;
    let preview: AntifraudAnalysis | null = null;
    const previewTimeline: RiskPoint[] = [];
    let context: WindowContext | undefined;
    let durationMs = 0;
    for await (const update of this.clients.streamTranscript(sourceUrl)) {
      this.assertOwnership();
      durationMs = update.durationMs;
      if (update.type === 'complete') {
        finalTranscript = structuredClone(update.segments);
        await this.repository.saveProgress(callId, transcript, preview, 85, true);
        continue;
      }
      const progress = 10 + (70 * update.processedMs) / Math.max(1, update.durationMs);
      for (const fragment of buildAssessmentWindows(update.segments)) {
        const result = await this.clients.assessFragment(fragment, context);
        this.assertOwnership();
        // Role assignment mutates the fragment. Never publish the raw ASR version.
        transcript.push(...fragment);
        context = result.context;
        preview = {
          ...result.analysis,
          timeline: [...previewTimeline],
        };
      }
      if (preview && update.segments.length) {
        previewTimeline.push({ timestampMs: update.processedMs, score: preview.score });
        preview.timeline = [...previewTimeline];
      }
      await this.repository.saveProgress(callId, transcript, preview, progress);
    }
    if (finalTranscript === null) throw new Error('ASR stream ended without a final transcript');
    this.assertOwnership();
    if (finalTranscript.length === 0) {
      await this.repository.completeWithoutSpeech(callId, finalTranscript);
      return;
    }
    // Revisit the full-context transcript in bounded chronological windows. Never
    // overwrite historical preview points with hindsight from the end of the call.
    // Keep the reviewed preview on screen while final roles are being refined.
    const final = await this.clients.assess(finalTranscript, async (_partial, processed, total) => {
      this.assertOwnership();
      await this.repository.saveProgress(
        callId,
        transcript,
        preview,
        85 + (14 * processed) / total,
        true,
      );
    });
    this.assertOwnership();
    const timeline = previewTimeline.filter((point) => point.timestampMs < durationMs);
    timeline.push({ timestampMs: durationMs, score: final.score });
    await this.repository.complete(callId, { ...final, timeline }, finalTranscript);
  }
}
