import 'reflect-metadata';
import { AppConfig } from '../config/app-config';
import { DatabaseService } from '../database/database.service';
import { TechnicalRepository } from './technical.repository';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += data.length;
    if (length > 4 * 1024 * 1024) throw new Error('Dataset too large');
    chunks.push(data);
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const database = new DatabaseService(new AppConfig());
  try {
    const result = await new TechnicalRepository(database).import(raw);
    process.stdout.write(JSON.stringify({ sources: result.sources.length, id: result.id }));
  } finally {
    await database.onModuleDestroy();
  }
}
void main().catch(() => {
  process.stderr.write('technical_import_failed\n');
  process.exitCode = 1;
});
