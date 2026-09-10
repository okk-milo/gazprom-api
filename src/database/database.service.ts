import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, type QueryResultRow } from 'pg';
import { AppConfig } from '../config/app-config';

const schemaSql = `
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY,
  deal_id UUID NOT NULL REFERENCES deals(id),
  employee_id UUID NOT NULL REFERENCES employees(id),
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  progress INTEGER NOT NULL DEFAULT 0,
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  analysis JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_state_created_at_idx ON calls (state, created_at);
`;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query<TRow extends QueryResultRow>(text: string, values: unknown[] = []): Promise<TRow[]> {
    await this.ensureSchema();
    const result = await this.pool.query<TRow>(text, values);
    return result.rows;
  }

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(schemaSql).then(() => undefined);
    return this.schemaReady;
  }
}
