import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseAudioFacts } from './audio-facts';
import { parseTechnicalDataset, technicalRecord } from './technical.types';

async function main(): Promise<void> {
  const [source, audioDir, output] = process.argv.slice(2);
  if (!source || !audioDir || !output) throw new Error('Missing arguments');
  const dataset = parseTechnicalDataset(JSON.parse(await readFile(source, 'utf8')) as unknown);
  // A separate snapshot preserves the prior measurement set and allows rollback.
  dataset.id = '599d8b23-24ae-462c-a58a-5e293c31bcec';
  let measured = 0;
  for (const item of dataset.sources) {
    if (item.status !== 'measured') continue;
    const raw = technicalRecord(
      JSON.parse(await readFile(path.join(audioDir, `${item.id}.json`), 'utf8')) as unknown,
    );
    if (raw.sourceId !== item.id) throw new Error('Audio source mismatch');
    item.facts.audio = parseAudioFacts(raw.facts, item.facts.durationSeconds);
    measured++;
  }
  await writeFile(output, JSON.stringify(parseTechnicalDataset(dataset)), {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify({ measured, total: dataset.sources.length }));
}
void main().catch(() => {
  process.stderr.write('audio_enrichment_failed\n');
  process.exitCode = 1;
});
