import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

interface Segment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}
const version = 'technical-events-v2-explicit-markers';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_record');
  return Object.fromEntries(Object.entries(value));
}
function segmentsFrom(raw: unknown): {
  durationSeconds: number;
  segments: Segment[];
  invalid: number;
} {
  const input = record(raw);
  if (
    typeof input.durationSeconds !== 'number' ||
    !Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 ||
    input.durationSeconds > 1800 ||
    !Array.isArray(input.segments)
  )
    throw new Error('invalid_asr');
  const segments: Segment[] = [];
  const ids = new Set<string>();
  let invalid = 0;
  for (const rawSegment of input.segments) {
    const s = record(rawSegment);
    if (
      typeof s.id !== 'string' ||
      !s.id ||
      ids.has(s.id) ||
      typeof s.text !== 'string' ||
      !s.text.trim() ||
      s.text.length > 1500 ||
      typeof s.startMs !== 'number' ||
      typeof s.endMs !== 'number' ||
      !Number.isInteger(s.startMs) ||
      !Number.isInteger(s.endMs) ||
      s.startMs < 0 ||
      s.endMs <= s.startMs ||
      s.endMs > Math.round(input.durationSeconds * 1000)
    ) {
      invalid += 1;
      continue;
    }
    ids.add(s.id);
    segments.push({ id: s.id, startMs: s.startMs, endMs: s.endMs, text: s.text });
  }
  return {
    durationSeconds: input.durationSeconds,
    segments: segments.sort((a, b) => a.startMs - b.startMs),
    invalid,
  };
}
function invoke(cli: string, input: { segments: Segment[] }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 260000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > 256000) child.kill('SIGTERM');
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('extraction_process_failed'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('extraction_process_failed'));
        return;
      }
      try {
        resolve(JSON.parse(out) as unknown);
      } catch {
        reject(new Error('invalid_extraction_json'));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
async function main(): Promise<void> {
  const [inputArg, outputArg, cliArg, ...sourceIds] = process.argv.slice(2);
  if (!inputArg || !outputArg || !cliArg || sourceIds.some((s) => !/^[a-f0-9]{64}$/.test(s)))
    throw new Error('invalid_arguments');
  const inputDir = path.resolve(inputArg),
    outputDir = path.resolve(outputArg),
    cli = path.resolve(cliArg);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const names = (await readdir(inputDir))
    .filter(
      (n) =>
        /^[a-f0-9]{64}\.json$/.test(n) && (!sourceIds.length || sourceIds.includes(n.slice(0, -5))),
    )
    .sort();
  for (const name of names) {
    const started = Date.now();
    const rawText = await readFile(path.join(inputDir, name), 'utf8');
    const fingerprint = createHash('sha256')
      .update(version)
      .update(process.env.OLLAMA_MODEL ?? '')
      .update(rawText)
      .digest('hex');
    const callDir = path.join(outputDir, name.slice(0, -5), fingerprint);
    await mkdir(callDir, { recursive: true, mode: 0o700 });
    try {
      const input = segmentsFrom(JSON.parse(rawText) as unknown);
      if (!input.segments.length) throw new Error('no_valid_speech');
      const windows: Segment[][] = [];
      let current: Segment[] = [],
        chars = 0;
      for (const segment of input.segments) {
        if (current.length && (current.length >= 80 || chars + segment.text.length > 7500)) {
          windows.push(current);
          current = [];
          chars = 0;
        }
        current.push(segment);
        chars += segment.text.length;
      }
      if (current.length) windows.push(current);
      const results: unknown[] = [];
      let cached = 0;
      for (const [index, segments] of windows.entries()) {
        const file = path.join(callDir, `${index}.json`);
        let response: unknown;
        try {
          response = JSON.parse(await readFile(file, 'utf8')) as unknown;
          cached += 1;
        } catch (error: unknown) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
            throw error;
          response = await invoke(cli, { segments });
          await writeFile(file, JSON.stringify(response), { flag: 'wx', mode: 0o600 });
        }
        const envelope = record(response);
        if (envelope.version !== version || typeof envelope.model !== 'string')
          throw new Error('invalid_extraction_version');
        results.push({ segmentIds: segments.map((s) => s.id), ...envelope });
      }
      const artifact = {
        version,
        sourceId: name.slice(0, -5),
        fingerprint,
        durationSeconds: input.durationSeconds,
        invalidSegments: input.invalid,
        segments: input.segments,
        windows: results,
        processingMs: Date.now() - started,
      };
      await writeFile(path.join(callDir, 'complete.json'), JSON.stringify(artifact), {
        mode: 0o600,
      });
      process.stdout.write(
        JSON.stringify({
          sourceId: name.slice(0, 8),
          state: 'complete',
          windows: windows.length,
          cached,
          invalidSegments: input.invalid,
          processingMs: Date.now() - started,
        }) + '\n',
      );
    } catch {
      process.stdout.write(
        JSON.stringify({
          sourceId: name.slice(0, 8),
          state: 'failed',
          processingMs: Date.now() - started,
        }) + '\n',
      );
    }
  }
}
void main().catch(() => {
  process.stderr.write('technical_batch_failed\n');
  process.exitCode = 1;
});
