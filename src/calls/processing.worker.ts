import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfig } from '../config/app-config';
import { ProcessingClients } from '../processing/processing-clients';
import { CallsRepository } from './calls.repository';
import { CallsService } from './calls.service';

@Injectable()
export class ProcessingWorker implements OnModuleInit {
  private readonly logger = new Logger(ProcessingWorker.name);
  private isProcessing = false;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: CallsRepository,
    private readonly callsService: CallsService,
    private readonly clients: ProcessingClients,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.callsService.bootstrap();
  }

  @Interval(1000)
  async processNextCall(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    let callId: string | null = null;

    try {
      const call = await this.repository.claimNextCall();

      if (!call) {
        return;
      }

      callId = call.id;

      const sourceUrl = this.config.mockProcessingEnabled
        ? 'mock://audio'
        : await this.callsService.getDownloadUrl(call.id);
      const transcript = await this.clients.transcribe(sourceUrl);
      const analysis = await this.clients.assess(transcript);
      await this.repository.saveTranscript(call.id, transcript);
      await this.repository.complete(call.id, analysis);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка обработки';
      this.logger.error(message);
      if (callId) {
        await this.repository.fail(callId, message);
      }
    } finally {
      this.isProcessing = false;
    }
  }
}
