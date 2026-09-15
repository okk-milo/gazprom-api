import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { BurnoutController } from './burnout.controller';
import { BurnoutRepository } from './burnout.repository';

@Module({
  controllers: [BurnoutController],
  providers: [AppConfig, DatabaseService, BurnoutRepository],
})
class BurnoutPreviewModule {}

async function main(): Promise<void> {
  // No CallsService, scheduler, S3 clients or antifraud worker in the isolated preview process.
  const app = await NestFactory.create(BurnoutPreviewModule, { logger: ['error', 'warn'] });
  app.enableCors({ origin: app.get(AppConfig).corsOrigins, methods: ['GET'] });
  app.enableShutdownHooks();
  await app.listen(app.get(AppConfig).port);
}

void main().catch(() => {
  process.stderr.write('burnout_preview_start_failed\n');
  process.exitCode = 1;
});
