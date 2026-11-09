import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkSource, validateAsset } from './generate-action-handoff-audio.mjs';

// Synthetic PCM is only a validator fixture, never a shipping speech asset.
const bytes = Buffer.alloc(3244);
bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40);
const resample = 'ffmpeg libswresample (filter_size=64, cutoff=0.95): mono PCM16, 44100 Hz to 16000 Hz';
const asset = { model: '@cf/myshell-ai/melotts', lang: 'kr', version: 'action-handoff-v2',
  text: '일정 내용을 확인할게요.', data: bytes.toString('base64'),
  sha256: createHash('sha256').update(bytes).digest('hex'), sampleRate: 16000,
  sourceSha256: '1'.repeat(64), sourceSampleRate: 44100, resample };
const provenance = `// Model: @cf/myshell-ai/melotts; lang: kr; version: action-handoff-v2; source SHA-256: ${asset.sourceSha256}; resample: ${resample}.\n`;
const source = value => provenance + 'export const actionHandoffAsset = ' + JSON.stringify(value) + ' as const;\n'
  + "export const actionHandoffSentence = { text: actionHandoffAsset.text, audio: { data: actionHandoffAsset.data, mimeType: 'audio/wav' as const } };\n";
assert.equal(validateAsset(asset), asset);
assert.deepEqual(checkSource(source(asset)), asset);
const unavailable = { ...asset, text: '지금은 일정을 추가할 수 없어요.', version: 'calendar-unavailable-v2' };
assert.equal(validateAsset(unavailable, 'calendar-unavailable'), unavailable);
const unavailableSource = `// Model: @cf/myshell-ai/melotts; lang: kr; version: calendar-unavailable-v2; source SHA-256: ${unavailable.sourceSha256}; resample: ${resample}.\n`
  + 'export const calendarUnavailableAsset = ' + JSON.stringify(unavailable) + ' as const;\n'
  + "export const calendarUnavailableSentence = { text: calendarUnavailableAsset.text, audio: { data: calendarUnavailableAsset.data, mimeType: 'audio/wav' as const } };\n";
assert.deepEqual(checkSource(unavailableSource, undefined, 'calendar-unavailable'), unavailable);
assert.throws(() => checkSource(unavailableSource.replace('Model:', 'Missing:'), undefined, 'calendar-unavailable'), /provenance/);
const hold = { ...asset, text: "취소하려면 '취소'라고 말씀하세요.", version: 'action-hold-v1' };
const holdSource = `// Model: @cf/myshell-ai/melotts; lang: kr; version: action-hold-v1; source SHA-256: ${hold.sourceSha256}; resample: ${resample}.\n`
  + 'export const actionHoldAsset = ' + JSON.stringify(hold) + ' as const;\n'
  + "export const actionHoldSentence = { text: actionHoldAsset.text, audio: { data: actionHoldAsset.data, mimeType: 'audio/wav' as const } };\n";
assert.equal(validateAsset(hold, 'hold'), hold);
assert.deepEqual(checkSource(holdSource, undefined, 'hold'), hold);
assert.throws(() => checkSource(holdSource.replace('Model:', 'Missing:'), undefined, 'hold'), /provenance/);
assert.throws(() => validateAsset({ ...hold, model: 'macOS Yuna' }, 'hold'), /provenance/);
assert.throws(() => validateAsset({ ...hold, text: '다른 안내' }, 'hold'), /provenance/);
assert.throws(() => validateAsset({ ...hold, sha256: '0'.repeat(64) }, 'hold'), /SHA-256/);
assert.throws(() => checkSource(holdSource.replace('text: actionHoldAsset.text', "text: 'wrong'"), undefined, 'hold'), /binding/);
assert.throws(() => checkSource(holdSource.replace('data: actionHoldAsset.data', "data: ''"), undefined, 'hold'), /binding/);
assert.throws(() => checkSource(holdSource.split('\n').filter(line => !line.startsWith('export const actionHoldSentence')).join('\n'), undefined, 'hold'), /binding/);
assert.throws(() => checkSource(holdSource + 'actionHoldSentence.audio.data = "different";\n', undefined, 'hold'), /binding/);
assert.throws(() => checkSource(source(asset).replace(provenance, '')), /provenance/);
assert.throws(() => checkSource('// Generated with macOS Yuna\n'), /metadata/);
assert.throws(() => checkSource(source({ ...asset, model: 'macOS Yuna' })), /provenance/);
assert.throws(() => checkSource(source({ ...asset, lang: 'en' })), /provenance/);
assert.throws(() => checkSource(source({ ...asset, sha256: '0'.repeat(64) })), /SHA-256/);
const wrongRate = Buffer.from(bytes); wrongRate.writeUInt32LE(44100, 24); wrongRate.writeUInt32LE(88200, 28);
assert.throws(() => validateAsset({ ...asset, data: wrongRate.toString('base64'), sampleRate: 44100,
  sha256: createHash('sha256').update(wrongRate).digest('hex') }), /16000 Hz/);
assert.throws(() => checkSource(source({ ...asset, sourceSha256: 'x' })), /provenance/);
assert.throws(() => checkSource(source({ ...asset, sourceSampleRate: 48000 })), /provenance/);
assert.throws(() => checkSource(source({ ...asset, resample: 'unknown' })), /provenance/);
assert.throws(() => checkSource(source(asset), { ...asset, calls: 2 }), /manifest/);
assert.throws(() => checkSource(source(asset), { model: asset.model, lang: 'kr', version: asset.version,
  text: asset.text, calls: 1, sha256: asset.sha256, sampleRate: 16000,
  sourceSha256: '2'.repeat(64), sourceSampleRate: 44100, resample }), /manifest/);
const changed = Buffer.from(bytes); changed[changed.length - 1] = 1;
assert.throws(() => validateAsset({ ...asset, data: changed.toString('base64') }), /SHA-256/);

const script = join(dirname(fileURLToPath(import.meta.url)), 'generate-action-handoff-audio.mjs');
const temp = mkdtempSync(join(tmpdir(), 'fixed-audio-check-'));
const invokeCheck = (ctx, kind) => spawnSync(process.execPath,
  [script, '--check', ...(kind === 'handoff' ? [] : [kind === 'hold' ? '--hold' : '--calendar-unavailable']), '--ctx', ctx], { encoding: 'utf8' });
try {
  for (const [kind, embedded, sourceVersion] of [
    ['handoff', 'actionHandoffAsset', 'action-handoff-v1'],
    ['calendar-unavailable', 'calendarUnavailableAsset', 'calendar-unavailable-v1'],
    ['hold', 'actionHoldAsset', 'action-hold-source-v1'],
  ]) {
    const sourceFile = join(dirname(script), '..', 'src', kind === 'handoff' ? 'action-handoff-audio.ts' : kind === 'hold' ? 'action-hold-audio.ts' : 'calendar-unavailable-audio.ts');
    const sourceText = readFileSync(sourceFile, 'utf8');
    const json = new RegExp('^export const ' + embedded + ' = (.+) as const;$', 'm').exec(sourceText)?.[1];
    assert.ok(json, `missing embedded asset for ${kind}`);
    const shipped = JSON.parse(json);
    const empty = join(temp, `${kind}-empty`); mkdirSync(empty);
    const accepted = invokeCheck(empty, kind);
    assert.equal(accepted.status, 0, accepted.stderr);

    const wrongVersion = join(temp, `${kind}-wrong-version`); mkdirSync(wrongVersion);
    writeFileSync(join(wrongVersion, 'manifest.json'), JSON.stringify({ model: shipped.model, lang: shipped.lang,
      version: 'unexpected-version', text: shipped.text, calls: 1, sha256: shipped.sourceSha256,
      sampleRate: shipped.sourceSampleRate }));
    assert.notEqual(invokeCheck(wrongVersion, kind).status, 0, 'wrong source version must fail --check');

    const wrongHash = join(temp, `${kind}-wrong-hash`); mkdirSync(wrongHash);
    writeFileSync(join(wrongHash, 'manifest.json'), JSON.stringify({ model: shipped.model, lang: shipped.lang,
      version: sourceVersion, text: shipped.text, calls: 1, sha256: '0'.repeat(64),
      sampleRate: shipped.sourceSampleRate }));
    assert.notEqual(invokeCheck(wrongHash, kind).status, 0, 'wrong source hash must fail --check');
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('HANDOFF_CHECK_TESTS_OK: missing/wrong provenance, hash, WAV and manifest rejected without inference');
