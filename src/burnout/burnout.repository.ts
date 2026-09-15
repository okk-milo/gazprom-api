import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { type BurnoutDataset, parseDataset } from './burnout.types';

@Injectable()
export class BurnoutRepository {
  private schemaReady: Promise<void> | null = null;

  constructor(@Inject(DatabaseService) private readonly database: Pick<DatabaseService, 'query'>) {}

  private ensureSchema(): Promise<void> {
    this.schemaReady ??= this.database
      .query(
        `CREATE TABLE IF NOT EXISTS burnout_datasets (
      id UUID PRIMARY KEY, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.schemaReady = null;
        throw error;
      });
    return this.schemaReady;
  }

  async latest(): Promise<BurnoutDataset | null> {
    await this.ensureSchema();
    const rows = await this.database.query<{ payload: unknown }>(
      'SELECT payload FROM burnout_datasets ORDER BY updated_at DESC, id DESC LIMIT 1',
    );
    return rows[0] ? parseDataset(rows[0].payload) : null;
  }

  async import(raw: unknown): Promise<BurnoutDataset> {
    const input = parseDataset(raw);
    await this.ensureSchema();
    await this.database.query(
      `INSERT INTO burnout_datasets (id, payload) VALUES ($1, $2::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
      WHERE burnout_datasets.payload IS DISTINCT FROM EXCLUDED.payload`,
      [input.id, JSON.stringify(input)],
    );
    return input;
  }
}
