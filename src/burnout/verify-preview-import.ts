import 'reflect-metadata';
import { BurnoutRepository } from './burnout.repository';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';

async function main(): Promise<void> {
  const config = new AppConfig();
  const target = new URL(config.databaseUrl);
  if (target.hostname !== 'dev615-db-preview' || target.pathname !== '/dev615')
    throw new Error('Only the isolated DEV-615 database is allowed');
  const database = new DatabaseService(config);
  try {
    const repository = new BurnoutRepository(database);
    const dataset = await repository.latest();
    if (!dataset) throw new Error('Dataset missing');
    const state = async () =>
      database.query<{ signature: string }>(
        `SELECT json_build_object('datasets', (SELECT count(*) FROM burnout_datasets), 'calls', (SELECT count(*) FROM calls), 'employees', (SELECT count(*) FROM employees), 'created', created_at, 'updated', updated_at)::text AS signature FROM burnout_datasets WHERE id = $1`,
        [dataset.id],
      );
    const before = await state();
    await repository.import(dataset);
    await repository.import(dataset);
    const after = await state();
    if (!before[0] || before[0].signature !== after[0]?.signature)
      throw new Error('Import changed timestamps or unrelated records');
    process.stdout.write(
      JSON.stringify({
        idempotent: true,
        antifraudRecordsUnchanged: true,
        sources: dataset.sources.length,
      }),
    );
  } finally {
    await database.onModuleDestroy();
  }
}
void main().catch(() => {
  process.stderr.write('preview_import_verification_failed\n');
  process.exitCode = 1;
});
