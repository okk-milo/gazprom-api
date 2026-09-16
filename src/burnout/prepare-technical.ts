import { readdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { technicalSourceFromArtifact } from './technical-artifact';
import { parseTechnicalDataset, technicalView, type TechnicalSource } from './technical.types';

async function main(): Promise<void> {
  const [inputArg, resultsArg, outputArg] = process.argv.slice(2);
  if (!inputArg || !resultsArg || !outputArg)
    throw new Error('Expected input/results/output paths');
  const sources: TechnicalSource[] = [];
  for (const name of (await readdir(path.resolve(inputArg)))
    .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
    .sort()) {
    const id = name.slice(0, -5),
      sourceRoot = path.join(path.resolve(resultsArg), id);
    try {
      const fingerprints = (await readdir(sourceRoot)).filter((n) => /^[a-f0-9]{64}$/.test(n));
      if (fingerprints.length !== 1 || !fingerprints[0])
        throw new Error('Ambiguous extraction cache');
      const artifact: unknown = JSON.parse(
        await readFile(path.join(sourceRoot, fingerprints[0], 'complete.json'), 'utf8'),
      );
      sources.push(technicalSourceFromArtifact(artifact, id));
    } catch (error: unknown) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
      sources.push({ id, status: 'failed', reason: 'extraction_failed' });
    }
  }
  const dataset = parseTechnicalDataset({
    id: 'ec74553e-2197-4e6c-aaf2-cfe165e783c2',
    version: 'technical-dialogue-v1',
    periodStart: '2026-07-27',
    sources,
  });
  await writeFile(path.resolve(outputArg), JSON.stringify(dataset), { flag: 'wx', mode: 0o600 });
  const view = technicalView(dataset);
  process.stdout.write(
    JSON.stringify({
      coverage: view.coverage,
      weeks: view.weeks.map((w) => ({
        week: w.index + 1,
        calls: w.sourceIds.length,
        scores: w.measures?.scores ?? null,
      })),
      index: view.overall?.index ?? null,
    }),
  );
}
void main().catch(() => {
  process.stderr.write('technical_preparation_failed\n');
  process.exitCode = 1;
});
