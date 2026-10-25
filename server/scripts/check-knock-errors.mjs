import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as tool from './generate-knock-audio.mjs';

test('CLI explains its own usage error', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./generate-knock-audio.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use --check or --generate --ctx/);
});

test('only explicitly safe errors disclose their messages', () => {
  assert.equal(tool.formatError(tool.safeError('Local validation failed')), 'Local validation failed');
  const marker = 'PRIVATE_UPSTREAM_TRANSCRIPT_TOKEN';
  for (const error of [Error(marker), new TypeError(marker), { message: marker }, marker]) {
    assert.ok(!tool.formatError(error).includes(marker));
  }
});

test('local budget validation errors are marked safe before external calls', async () => {
  await assert.rejects(tool.createBudget('', 'unknown-task'), error => error.safe === true && tool.formatError(error) === 'Unknown budget task');
});
