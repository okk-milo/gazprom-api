import { readFile, writeFile } from 'node:fs/promises';
import { parseTechnicalDataset } from './technical.types';
import { conversationReport } from './conversation-report';

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Missing arguments');
  const report = conversationReport(
    parseTechnicalDataset(JSON.parse(await readFile(input, 'utf8')) as unknown),
  );
  await writeFile(
    output,
    JSON.stringify({
      state: report.overall ? 'ready' : 'empty',
      dataset: report.overall ? report : null,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      coverage: report.coverage,
      overall: report.overall,
      weeks: report.weeks.map((w) => ({
        index: w.index,
        values: w.measures?.values,
        workload: w.workload,
      })),
    }),
  );
}
void main().catch(() => {
  process.stderr.write('report_export_failed\n');
  process.exitCode = 1;
});
