import 'reflect-metadata';
import { BurnoutRepository } from './burnout.repository';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { parseDataset } from './burnout.types';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.length;
    if (length > 1024 * 1024) throw new Error('Dataset too large');
    chunks.push(buffer);
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const dataset = parseDataset(raw);
  const database = new DatabaseService(new AppConfig());
  try {
    await new BurnoutRepository(database).import(dataset);
    process.stdout.write(
      JSON.stringify({ id: dataset.id, importedSources: dataset.sources.length }),
    );
  } finally {
    await database.onModuleDestroy();
  }
}

void main().catch(() => {
  process.stderr.write('burnout_dataset_import_failed\n');
  process.exitCode = 1;
});
