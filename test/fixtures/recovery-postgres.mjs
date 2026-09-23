/* global console */
// Integration test for a disposable PostgreSQL instance, never the live schema.
import assert from 'node:assert/strict';
import pg from 'pg';
import { AppConfig } from '../../dist/config/app-config.js';
import { DatabaseService } from '../../dist/database/database.service.js';
import { CallsRepository } from '../../dist/calls/calls.repository.js';

const config = new AppConfig();
const first = new DatabaseService(config);
const second = new DatabaseService(config);
const client = new pg.Client({ connectionString: config.databaseUrl });
try {
  const lease = await first.tryAcquireLock(614001);
  assert.ok(lease?.isHeld());
  assert.equal(await second.tryAcquireLock(614001), null);
  await lease.release();
  const replacement = await second.tryAcquireLock(614001);
  assert.ok(replacement?.isHeld());
  await client.connect();
  await client.query(`CREATE TEMP TABLE calls (
    id text PRIMARY KEY, state text, progress integer, analysis jsonb,
    transcript jsonb, error_message text, revision integer, updated_at timestamptz
  )`);
  const states = [
    'upload_pending',
    'uploaded',
    'transcribing',
    'analysing',
    'completed',
    'failed',
    'no_speech',
  ];
  for (const state of states) {
    await client.query(
      `INSERT INTO calls VALUES ($1,$1,56,'{"score":95}','[{"text":"test"}]',NULL,5,'2026-01-01Z')`,
      [state],
    );
  }
  const before = (await client.query('SELECT * FROM calls ORDER BY id')).rows;
  const repository = new CallsRepository({
    query: async (sql, values) => (await client.query(sql, values)).rows,
  });
  assert.equal(await repository.failInterruptedCalls(), 2);
  assert.equal(await repository.failInterruptedCalls(), 0);
  const after = (await client.query('SELECT * FROM calls ORDER BY id')).rows;
  for (const original of before) {
    const changed = after.find((row) => row.id === original.id);
    if (['transcribing', 'analysing'].includes(original.state)) {
      assert.equal(changed.state, 'failed');
      assert.equal(changed.analysis, null);
      assert.deepEqual(changed.transcript, original.transcript);
      assert.equal(changed.revision, original.revision + 1);
    } else assert.deepEqual(changed, original);
  }
  console.log(
    JSON.stringify({
      advisoryLockExclusive: true,
      interrupted: 2,
      unchangedStates: 5,
      repeatRecovery: 0,
    }),
  );
} finally {
  await client.end();
  await first.onModuleDestroy();
  await second.onModuleDestroy();
}
