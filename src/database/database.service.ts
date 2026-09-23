import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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

export interface DatabaseLock {
  isHeld(): boolean;
  release(): Promise<void>;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;
  private readonly locks = new Set<DatabaseLock>();
  private readonly logger = new Logger(DatabaseService.name);

  constructor(config: AppConfig) {
    this.pool = new Pool({ connectionString: config.databaseUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.locks].map((lock) => lock.release()));
    await this.pool.end();
  }

  async tryAcquireLock(key: number): Promise<DatabaseLock | null> {
    const client = await this.pool.connect();
    let held = false;
    let released = false;
    let connectionLost = false;
    const onError = () => {
      connectionLost = true;
      held = false;
      this.logger.error('Database worker lock connection lost; processing disabled');
    };
    client.on('error', onError);
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [key],
      );
      held = result.rows[0]?.acquired === true && !connectionLost;
      if (!held) {
        client.removeListener('error', onError);
        client.release(connectionLost);
        return null;
      }
    } catch (error) {
      client.release(true);
      throw error;
    }
    const lock: DatabaseLock = {
      isHeld: () => held,
      release: async () => {
        if (released) return;
        released = true;
        held = false;
        try {
          if (!connectionLost) await client.query('SELECT pg_advisory_unlock($1)', [key]);
        } finally {
          // Destroy the connection so a failed unlock cannot leak a session lock.
          client.release(true);
          this.locks.delete(lock);
        }
      },
    };
    this.locks.add(lock);
    return lock;
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
