import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { parseTechnicalDataset, type TechnicalDataset } from './technical.types';

@Injectable()
export class TechnicalRepository {
  private ready: Promise<void> | null = null;
  constructor(@Inject(DatabaseService) private readonly database: Pick<DatabaseService, 'query'>) {}
  private async ensureSchema(): Promise<void> {
    this.ready ??= this.database
      .query(
        'CREATE TABLE IF NOT EXISTS dialogue_technical_datasets (id UUID PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.ready = null;
        throw error;
      });
    await this.ready;
  }
  async latest(): Promise<TechnicalDataset | null> {
    await this.ensureSchema();
    const rows = await this.database.query<{ payload: unknown }>(
      'SELECT payload FROM dialogue_technical_datasets ORDER BY updated_at DESC, id DESC LIMIT 1',
    );
    return rows[0] ? parseTechnicalDataset(rows[0].payload) : null;
  }
  async import(raw: unknown): Promise<TechnicalDataset> {
    const dataset = parseTechnicalDataset(raw);
    await this.ensureSchema();
    await this.database.query(
      'INSERT INTO dialogue_technical_datasets (id,payload) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now() WHERE dialogue_technical_datasets.payload IS DISTINCT FROM EXCLUDED.payload',
      [dataset.id, JSON.stringify(dataset)],
    );
    return dataset;
  }
}
