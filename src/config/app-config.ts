import { Injectable } from '@nestjs/common';

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }

  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }

  return value;
}

@Injectable()
export class AppConfig {
  readonly port = positiveInteger('PORT', 3000);
  readonly databaseUrl = required('DATABASE_URL');
  readonly corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  readonly s3Endpoint = process.env.S3_ENDPOINT?.trim();
  readonly s3Region = process.env.S3_REGION?.trim() ?? 'ru-central1';
  readonly s3AccessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  readonly s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  readonly s3Bucket = process.env.S3_BUCKET?.trim();
  readonly asrInternalUrl = process.env.ASR_INTERNAL_URL?.trim();
  readonly asrInternalToken = process.env.ASR_INTERNAL_TOKEN?.trim();
  readonly llmInternalUrl = process.env.LLM_INTERNAL_URL?.trim();
  readonly llmInternalToken = process.env.LLM_INTERNAL_TOKEN?.trim();
  readonly mockProcessingEnabled = process.env.MOCK_PROCESSING_ENABLED === 'true';
  readonly processingPollIntervalMs = positiveInteger('PROCESSING_POLL_INTERVAL_MS', 1000);
  readonly asrTranscriptionRetryAttempts = positiveInteger('ASR_TRANSCRIPTION_RETRY_ATTEMPTS', 60);
  readonly asrTranscriptionRetryDelayMs = positiveInteger('ASR_TRANSCRIPTION_RETRY_DELAY_MS', 5000);

  get storageConfigured(): boolean {
    return Boolean(
      this.s3Endpoint && this.s3AccessKeyId && this.s3SecretAccessKey && this.s3Bucket,
    );
  }
}
