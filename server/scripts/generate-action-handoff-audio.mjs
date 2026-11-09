import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { safeError, formatError } from './generate-knock-audio.mjs';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(server, '..');
const model = '@cf/myshell-ai/melotts';
const specs = {
  handoff: { file: 'action-handoff-audio.ts', text: '일정 내용을 확인할게요.', version: 'action-handoff-v2', sourceVersion: 'action-handoff-v1',
    assetName: 'actionHandoffAsset', sentenceName: 'actionHandoffSentence', context: 'handoff-melo-build' },
  'calendar-unavailable': { file: 'calendar-unavailable-audio.ts', text: '지금은 일정을 추가할 수 없어요.', version: 'calendar-unavailable-v2', sourceVersion: 'calendar-unavailable-v1',
    assetName: 'calendarUnavailableAsset', sentenceName: 'calendarUnavailableSentence', context: 'calendar-unavailable-melo-build' },
  hold: { file: 'action-hold-audio.ts', text: "취소하려면 '취소'라고 말씀하세요.", version: 'action-hold-v1', sourceVersion: 'action-hold-source-v1',
    assetName: 'actionHoldAsset', sentenceName: 'actionHoldSentence', context: 'hold-melo-build', mode: 'reply_readback' },
};
function specFor(kind) {
  if (!Object.hasOwn(specs, kind)) throw safeError('Unknown fixed action audio kind');
  return specs[kind];
}
const sourceRate = 44100;
const targetRate = 16000;
const resample = 'ffmpeg libswresample (filter_size=64, cutoff=0.95): mono PCM16, 44100 Hz to 16000 Hz';
const provenanceFor = (version, sourceSha256) => `Model: ${model}; lang: kr; version: ${version}; source SHA-256: ${sourceSha256}; resample: ${resample}.`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function convertWav(input) {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'mobi-fixed-audio-'));
  const output = resolve(tempDir, 'resampled.wav');
  try {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map_metadata', '-1', '-ac', '1', '-ar', String(targetRate),
      '-af', 'aresample=resampler=swr:filter_size=64:cutoff=0.95', '-c:a', 'pcm_s16le', '-f', 'wav', output],
    { input, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0 || !existsSync(output)) throw safeError('Offline ffmpeg resampling failed');
    return readFileSync(output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function validateAsset(asset, kind = 'handoff') {
  const { text, version } = specFor(kind);
  if (!asset || asset.model !== model || asset.lang !== 'kr' || asset.version !== version || asset.text !== text
      || asset.sourceSampleRate !== sourceRate || asset.resample !== resample || !/^[a-f0-9]{64}$/.test(asset.sourceSha256 ?? '')) {
    throw safeError('Wrong handoff MeloTTS provenance or text');
  }
  if (typeof asset.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data)) {
    throw safeError('Invalid handoff audio encoding');
  }
  const bytes = Buffer.from(asset.data, 'base64');
  if (bytes.length < 1000 || bytes.length > 2 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF'
      || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length
      || hash(bytes) !== asset.sha256) throw safeError('Invalid handoff WAV or SHA-256');
  let rate, frames = 0, at = 12;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw safeError('Invalid handoff WAV chunks');
    const name = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), start = at + 8;
    const end = start + size + size % 2;
    if (end > bytes.length) throw safeError('Invalid handoff WAV chunks');
    if (name === 'fmt ') {
      if (rate || size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
          || bytes.readUInt16LE(start + 14) !== 16 || bytes.readUInt16LE(start + 12) !== 2) throw safeError('Expected mono PCM16 handoff');
      rate = bytes.readUInt32LE(start + 4);
      if (rate !== targetRate || bytes.readUInt32LE(start + 8) !== rate * 2) throw safeError('Expected 16000 Hz handoff WAV');
    } else if (name === 'data') {
      if (frames || !size || size % 2) throw safeError('Invalid handoff PCM data');
      frames = size / 2;
    }
    at = end;
  }
  if (rate !== asset.sampleRate || !frames || frames > rate * 10) throw safeError('Invalid handoff duration or sample rate');
  return asset;
}

export function checkSource(source, manifest, kind = 'handoff') {
  const { text, version, assetName, sentenceName } = specFor(kind);
  const match = new RegExp('^export const ' + assetName + ' = (.+) as const;$', 'm').exec(source);
  if (!match) throw safeError('Missing handoff asset metadata');
  const asset = validateAsset(JSON.parse(match[1]), kind);
  if (!source.includes(provenanceFor(version, asset.sourceSha256))) throw safeError('Missing handoff MeloTTS/resample provenance');
  const binding = `export const ${sentenceName} = { text: ${assetName}.text, audio: { data: ${assetName}.data, mimeType: 'audio/wav' as const } };`;
  const code = source.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('//'));
  if (code.length !== 2 || code[0] !== match[0] || code[1] !== binding) throw safeError('Invalid fixed audio sentence binding');
  if (manifest && (manifest.model !== model || manifest.lang !== 'kr' || manifest.version !== version
      || manifest.text !== text || manifest.calls !== 1 || manifest.sha256 !== asset.sha256
      || manifest.sourceSha256 !== asset.sourceSha256 || manifest.sourceSampleRate !== sourceRate
      || manifest.resample !== resample || manifest.sampleRate !== targetRate)) throw safeError('Wrong handoff build manifest');
  return asset;
}

function validateSourceManifest(manifest, kind, sourceSha256) {
  if (!manifest) throw safeError('Missing original MeloTTS build manifest');
  const { text, sourceVersion } = specFor(kind);
  if (manifest.model !== model || manifest.lang !== 'kr' || manifest.version !== sourceVersion
      || manifest.text !== text || manifest.calls !== 1 || manifest.sampleRate !== sourceRate
      || manifest.sha256 !== sourceSha256) throw safeError('Mismatched original MeloTTS build manifest');
}

export function checkContext(ctx, kind = 'handoff') {
  const output = resolve(server, 'src', specFor(kind).file);
  const manifestPath = resolve(ctx, 'resampled', 'manifest.json');
  const sourceManifestPath = resolve(ctx, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : undefined;
  const sourceManifest = existsSync(sourceManifestPath) ? JSON.parse(readFileSync(sourceManifestPath, 'utf8')) : undefined;
  const asset = checkSource(readFileSync(output, 'utf8'), manifest, kind);
  if (sourceManifest) validateSourceManifest(sourceManifest, kind, asset.sourceSha256);
  if (manifest && sourceManifest && sourceManifest.sha256 !== manifest.sourceSha256) throw safeError('Original and resampled build manifests disagree');
  return asset;
}

function check(ctx, kind = 'handoff') {
  checkContext(ctx, kind);
  console.log(`${kind.replaceAll('-', '_').toUpperCase()}_MELO_OK: MeloTTS provenance, fixed text, PCM16 WAV and SHA-256 verified`);
}

function resampleExisting(ctx, kind = 'handoff') {
  const { text, version, file, assetName, sentenceName } = specFor(kind);
  const result = JSON.parse(readFileSync(resolve(ctx, 'response.json'), 'utf8'));
  if (result.calls !== 1 || result.text !== text || result.audio?.mimeType !== 'audio/wav') throw safeError('Invalid preserved MeloTTS response');
  const original = Buffer.from(result.audio.data, 'base64');
  if (original.toString('ascii', 0, 4) !== 'RIFF' || original.readUInt32LE(24) !== sourceRate) throw safeError('Expected original 44100 Hz MeloTTS WAV');
  const sourceSha256 = hash(original), sourceManifest = JSON.parse(readFileSync(resolve(ctx, 'manifest.json'), 'utf8'));
  validateSourceManifest(sourceManifest, kind, sourceSha256);
  const bytes = convertWav(original);
  const asset = validateAsset({ model, lang: 'kr', version, text, data: bytes.toString('base64'), sha256: hash(bytes),
    sampleRate: targetRate, sourceSha256, sourceSampleRate: sourceRate, resample }, kind);
  const manifest = { model, lang: 'kr', version, text, calls: 1, sha256: asset.sha256, sampleRate: targetRate,
    sourceSha256, sourceSampleRate: sourceRate, resample, generatedAt: new Date().toISOString() };
  const derived = resolve(ctx, 'resampled'); mkdirSync(derived, { recursive: true });
  writeFileSync(resolve(derived, 'audio.wav'), bytes);
  writeFileSync(resolve(derived, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const source = `// Generated by scripts/generate-action-handoff-audio.mjs; explicit regeneration only. ${provenanceFor(version, sourceSha256)}\n`
    + `export const ${assetName} = ` + JSON.stringify(asset) + ' as const;\n'
    + `export const ${sentenceName} = { text: ${assetName}.text, audio: { data: ${assetName}.data, mimeType: 'audio/wav' as const } };\n`;
  checkSource(source, manifest, kind);
  const output = resolve(server, 'src', file);
  writeFileSync(output + '.tmp', source); renameSync(output + '.tmp', output);
  check(ctx, kind);
  return { sourceBytes: original.length, outputBytes: bytes.length, sourceSha256, sha256: asset.sha256 };
}

async function generate(ctx, kind = 'handoff') {
  const { text, version, file, assetName, sentenceName, mode = 'general' } = specFor(kind);
  const output = resolve(server, 'src', file);
  if (!ctx.startsWith(resolve(root, '.context/actions') + '/')) throw safeError('CTX must be inside actions context');
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) throw safeError('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID');
  mkdirSync(ctx, { recursive: true });
  const ledgerPath = resolve(ctx, 'request.json');
  if (existsSync(ledgerPath)) throw safeError('Handoff synthesis was already issued; no automatic retry is allowed');
  const route = randomUUID(), port = 8791;
  const voiceImport = relative(ctx, resolve(server, 'src/voice.ts')).replaceAll('\\', '/');
  writeFileSync(resolve(ctx, 'worker.ts'), `import { synthesize } from '${voiceImport}';
let issued=false,calls=0;
export default {async fetch(request,env){
 if(request.method!=='POST'||new URL(request.url).pathname!=='/${route}')return new Response('',{status:404});
 if(issued)return new Response('',{status:409});issued=true;
 const ai={run:(...args)=>{if(++calls!==1||args[0]!==${JSON.stringify(model)})throw Error('One MeloTTS call only');return env.AI.run(...args);}};
 try {const result=await synthesize(ai,${JSON.stringify(text)},Date.now()+60000,{reserve:(_stage,call)=>{if(call!=='primary')throw Error('No hedge credit');}},${JSON.stringify(mode)});
 return Response.json({...result,calls});}catch{return Response.json({failed:true,calls},{status:502});}
}};
`);
  writeFileSync(resolve(ctx, 'wrangler.jsonc'), JSON.stringify({ name: 'mobi-handoff-asset', main: 'worker.ts',
    compatibility_date: '2025-08-29', account_id: accountId, ai: { binding: 'AI' }, observability: { enabled: false } }, null, 2));
  // Same local Wrangler/remote AI binding as the knock generator. Authentication
  // stays inside the already logged-in CLI; never read, print or copy its token.
  const child = spawn('npx', ['--no-install', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--config', resolve(ctx, 'wrangler.jsonc')],
    { cwd: server, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false, startupFailed = false;
  child.on('error', () => { startupFailed = true; });
  child.stdout.on('data', data => { if (String(data).includes('Ready on')) ready = true; });
  child.stderr.on('data', () => {});
  try {
    for (let i = 0; i < 120 && !ready; i++) {
      if (startupFailed || child.exitCode !== null) throw safeError('Local handoff asset Worker failed to start');
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ready) throw safeError('Local handoff asset Worker did not become ready');
    const ledger = { model, lang: 'kr', version, text, mode, requests: 1, issuedAt: new Date().toISOString(), outcome: 'pending' };
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx' });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/${route}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(65000) });
      if (!response.ok) throw safeError(`Handoff synthesis failed (HTTP ${response.status}); no retry issued`);
      const result = await response.json();
      // Preserve the one authorized response before local validation; a local
      // validation fix must not require another provider call.
      writeFileSync(resolve(ctx, 'response.json'), JSON.stringify(result));
      if (result.calls !== 1 || result.text !== text || result.audio?.mimeType !== 'audio/wav') throw safeError('Invalid handoff synthesis response');
      const original = Buffer.from(result.audio.data, 'base64');
      if (original.toString('ascii', 0, 4) !== 'RIFF' || original.readUInt32LE(24) !== sourceRate) throw safeError('Expected original 44100 Hz MeloTTS WAV');
      const sourceSha256 = hash(original), bytes = convertWav(original);
      const sourceManifest = { model, lang: 'kr', version: specFor(kind).sourceVersion, text, calls: 1, sha256: sourceSha256, sampleRate: sourceRate };
      const originalManifestPath = resolve(ctx, 'manifest.json');
      if (existsSync(originalManifestPath)) {
        const existingManifest = JSON.parse(readFileSync(originalManifestPath, 'utf8'));
        validateSourceManifest(existingManifest, kind, sourceSha256);
      } else writeFileSync(originalManifestPath, JSON.stringify(sourceManifest, null, 2));
      const asset = validateAsset({ model, lang: 'kr', version, text, data: bytes.toString('base64'), sha256: hash(bytes),
        sampleRate: targetRate, sourceSha256, sourceSampleRate: sourceRate, resample }, kind);
      const manifest = { model, lang: 'kr', version, text, calls: 1, sha256: asset.sha256, sampleRate: targetRate,
        sourceSha256, sourceSampleRate: sourceRate, resample, generatedAt: new Date().toISOString() };
      const derived = resolve(ctx, 'resampled'); mkdirSync(derived, { recursive: true });
      writeFileSync(resolve(derived, 'audio.wav'), bytes);
      writeFileSync(resolve(derived, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const source = `// Generated by scripts/generate-action-handoff-audio.mjs; explicit regeneration only. ${provenanceFor(version, sourceSha256)}\n`
        + `export const ${assetName} = ` + JSON.stringify(asset) + ' as const;\n'
        + `export const ${sentenceName} = { text: ${assetName}.text, audio: { data: ${assetName}.data, mimeType: 'audio/wav' as const } };\n`;
      checkSource(source, manifest, kind);
      writeFileSync(output + '.tmp', source); renameSync(output + '.tmp', output);
      writeFileSync(ledgerPath, JSON.stringify({ ...ledger, outcome: 'complete', calls: 1, sha256: asset.sha256 }, null, 2));
      check(ctx, kind);
    } catch (error) {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      writeFileSync(ledgerPath, JSON.stringify({ ...ledger, outcome: 'failed_or_unknown' }, null, 2));
      throw error;
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => {
      if (child.exitCode !== null || startupFailed) return r();
      child.once('exit', r);
      setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000).unref();
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--hold') && process.argv.includes('--calendar-unavailable')) throw safeError('Choose only one fixed audio kind');
    const kind = process.argv.includes('--hold') ? 'hold' : process.argv.includes('--calendar-unavailable') ? 'calendar-unavailable' : 'handoff';
    const ctxFlag = process.argv.indexOf('--ctx');
    const ctx = ctxFlag >= 0 ? resolve(process.argv[ctxFlag + 1]) : resolve(root, '.context/actions', specFor(kind).context);
    if (process.argv.includes('--check')) check(ctx, kind);
    else if (process.argv.includes('--resample-existing')) {
      const result = resampleExisting(ctx, kind);
      console.log(`${kind} resampled offline: ${result.sourceBytes} -> ${result.outputBytes} bytes; source SHA-256 ${result.sourceSha256}; output SHA-256 ${result.sha256}`);
    }
    else if (process.argv.includes('--generate')) await generate(ctx, kind);
    else throw safeError('Use --check, --resample-existing, or --generate [--hold|--calendar-unavailable] [--ctx <actions context directory>]');
  } catch (error) {
    console.error(formatError(error).replace('Knock asset operation', 'Handoff asset operation'));
    process.exitCode = 1;
  }
}
