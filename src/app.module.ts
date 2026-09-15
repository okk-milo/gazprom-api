import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BurnoutController } from './burnout/burnout.controller';
import { BurnoutRepository } from './burnout/burnout.repository';
import { CallsController } from './calls/calls.controller';
import { CallsRepository } from './calls/calls.repository';
import { CallsService } from './calls/calls.service';
import { ProcessingWorker } from './calls/processing.worker';
import { AppConfig } from './config/app-config';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health.controller';
import { ProcessingClients } from './processing/processing-clients';
import { StorageService } from './storage/storage.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [HealthController, CallsController, BurnoutController],
  providers: [
    AppConfig,
    BurnoutRepository,
    DatabaseService,
    CallsRepository,
    CallsService,
    ProcessingClients,
    ProcessingWorker,
    StorageService,
  ],
})
export class AppModule {}
