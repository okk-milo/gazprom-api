import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('ASR transport socket-end regression (isolated child)', () => {
  it.each(['eof', 'length', 'chunked', 'truncated-length', 'truncated-chunked'])(
    'survives FIN while body reading is paused: %s',
    (mode) => {
      const child = spawnSync(
        process.execPath,
        [resolve('test/fixtures/asr-socket-end.mjs'), mode],
        {
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
      const result: unknown = JSON.parse(child.stdout);
      expect(result).toMatchObject({ mode, processAlive: true });
      expect(result).toMatchObject(
        mode.startsWith('truncated') ? { expectedTruncation: true } : { bytes: 65536 },
      );
    },
  );
});
