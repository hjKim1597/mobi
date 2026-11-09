import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderActionWordingSource, validateActionWordingSource } from './action-wording-source-format.mjs';
export { renderActionWordingSource as makeServerSource };

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(server, '..');
export const MODEL = '@cf/myshell-ai/melotts';
export const LANGUAGE = 'kr';
export const VERSION = 'action-wording-v1';
export const SOURCE_RATE = 44100;
export const TARGET_RATE = 16000;
export const RESAMPLE = 'ffmpeg libswresample (filter_size=64, cutoff=0.95): mono PCM16, 44100 Hz to 16000 Hz';
export const SERVER_TEXTS = {
  not_written_reply: '보내지 않았어요.',
  not_written_calendar: '일정을 추가하지 않았어요.',
  failed_reply: '보내지 못했어요.',
  failed_calendar: '일정을 추가하지 못했어요.',
  unknown_calendar: '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 추가하지 않을게요.',
  offer_reply: '회신 내용을 작성할까요?',
  offer_calendar: '일정 내용을 확인할까요?',
};
const EXTRA_TEXTS = {
  unknown_generic: '처리 결과를 확인하지 못했어요. 중복을 막기 위해 다시 처리하지 않을게요.',
};
const ALL_TEXTS = { ...SERVER_TEXTS, ...EXTRA_TEXTS };
const APP_FILES = {
  not_written_reply: 'action_not_written_reply.wav',
  not_written_calendar: 'action_not_written_calendar.wav',
  failed_reply: 'action_failed_reply.wav',
  failed_calendar: 'action_failed_calendar.wav',
  unknown_calendar: 'action_unknown_calendar.wav',
  unknown_generic: 'action_unknown_generic.wav',
  offer_calendar: 'action_demo_calendar_offer.wav',
  demo_mail: 'action_demo_mail.wav',
};
const APP_STATIC_IDS = Object.keys(APP_FILES).filter(id => id !== 'demo_mail');
const RETIRED_APP_FILES = ['action_cancelled.wav', 'action_decline.wav', 'action_expired.wav'];
const APP_RAW = resolve(root, 'app/app/src/main/res/raw');
const APP_MANIFEST = resolve(root, 'app/e2e/action-wording-audio.json');
const MODULE = resolve(server, 'src/action-wording-audio.ts');
const contextRoot = resolve(root, '.context/actions/wording-melo-build');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };

function readDemoConstant(name) {
  const file = resolve(root, 'app/app/src/main/java/dev/mobi/ui/DemoActions.kt');
  const source = readFileSync(file, 'utf8');
  const match = new RegExp('^\\s*const val ' + name + ' = "((?:[^"\\\\]|\\\\.)*)"\\s*$', 'm').exec(source);
  if (!match) fail(`Missing DemoActions.${name}`);
  return match[1].replaceAll('\\"', '"').replaceAll('\\\\', '\\');
}
function readDemoMailText() {
  const text = readDemoConstant('offerSentences');
  if (!text.endsWith(SERVER_TEXTS.offer_reply)) fail('DemoActions.offerSentences must end with the canonical reply offer');
  return text;
}
function readDemoCalendarOfferText() {
  const text = readDemoConstant('calendarOffer');
  if (text !== SERVER_TEXTS.offer_calendar) fail('DemoActions.calendarOffer must match the canonical calendar offer');
  return text;
}

export function inspectWav(bytes, requiredRate) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1000 || bytes.length > 2 * 1024 * 1024
      || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
      || bytes.readUInt32LE(4) + 8 !== bytes.length) fail('Invalid wording WAV envelope');
  let format, dataSize, at = 12;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) fail('Invalid wording WAV chunks');
    const name = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), start = at + 8;
    const end = start + size + size % 2;
    if (end > bytes.length) fail('Invalid wording WAV chunks');
    if (name === 'fmt ') {
      if (format || size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
          || bytes.readUInt16LE(start + 14) !== 16 || bytes.readUInt16LE(start + 12) !== 2) fail('Expected mono PCM16 wording audio');
      format = { sampleRate: bytes.readUInt32LE(start + 4), byteRate: bytes.readUInt32LE(start + 8) };
    } else if (name === 'data') {
      if (dataSize !== undefined || !size || size % 2) fail('Invalid wording WAV data');
      dataSize = size;
    }
    at = end;
  }
  if (!format || format.sampleRate !== requiredRate || format.byteRate !== requiredRate * 2 || !dataSize
      || dataSize / 2 > requiredRate * 12) fail(`Expected mono PCM16 ${requiredRate} Hz wording audio`);
  return { sampleRate: format.sampleRate, channels: 1, bitsPerSample: 16, durationSeconds: dataSize / 2 / requiredRate };
}

export function validateAsset(asset, text) {
  if (!asset || asset.model !== MODEL || asset.lang !== LANGUAGE || asset.version !== VERSION || asset.text !== text
      || asset.sampleRate !== TARGET_RATE || ![1, 2].includes(asset.sourceAttempt) || asset.sourceSampleRate !== SOURCE_RATE || asset.resample !== RESAMPLE
      || !/^[a-f0-9]{64}$/.test(asset.sourceSha256 ?? '') || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '')
      || typeof asset.data !== 'string') fail('Wrong action wording MeloTTS provenance or metadata');
  const bytes = Buffer.from(asset.data, 'base64');
  inspectWav(bytes, TARGET_RATE);
  if (hash(bytes) !== asset.sha256) fail('Action wording WAV SHA-256 mismatch');
  return asset;
}

export function checkServerSource(source) {
  const assets = validateActionWordingSource(source, SERVER_TEXTS);
  for (const [id, text] of Object.entries(SERVER_TEXTS)) validateAsset(assets[id], text);
  return assets;
}

export function checkShipped() {
  const source = readFileSync(MODULE, 'utf8');
  const assets = checkServerSource(source);
  const manifest = JSON.parse(readFileSync(APP_MANIFEST, 'utf8'));
  if (RETIRED_APP_FILES.some(filename => existsSync(resolve(APP_RAW, filename))
      || Object.hasOwn(manifest.clips ?? {}, filename))) fail('Retired action WAV remains shipped or listed');
  const demoText = readDemoMailText();
  readDemoCalendarOfferText();
  const appExpected = { ...Object.fromEntries(APP_STATIC_IDS.map(id => [APP_FILES[id], ALL_TEXTS[id]])),
    [APP_FILES.demo_mail]: demoText };
  const attemptRows = manifest.attempts;
  const expectedIds = Object.keys({ ...ALL_TEXTS, demo_mail: demoText });
  if (!Array.isArray(attemptRows) || manifest.calls !== attemptRows.reduce((sum, row) => sum + (Number.isInteger(row.calls) ? row.calls : 0), 0)
      || attemptRows.length < 9 || attemptRows.length > 10) fail('Wrong action wording inference attempt count');
  const successfulAttempts = new Map(), seenAttempts = new Set(), failedAttempts = new Map();
  for (const row of attemptRows) {
    const key = `${row.id}:${row.attempt}`;
    if (!expectedIds.includes(row.id) || ![1, 2].includes(row.attempt) || seenAttempts.has(key)
        || row.calls !== 1 || !['failed', 'success', 'audio_recovered'].includes(row.outcome)) fail('Invalid action wording attempt ledger');
    seenAttempts.add(key);
    if (row.outcome === 'success' || row.outcome === 'audio_recovered') {
      if (successfulAttempts.has(row.id)) fail('Multiple successful attempts for one wording ID');
      successfulAttempts.set(row.id, row.attempt);
    } else {
      if (row.attempt !== 1 || failedAttempts.has(row.id)) fail('Invalid failed action wording attempt sequence');
      failedAttempts.set(row.id, row.attempt);
    }
  }
  if (successfulAttempts.size !== expectedIds.length || expectedIds.some(id => {
    const success = successfulAttempts.get(id), failed = failedAttempts.get(id);
    return success === undefined || (failed !== undefined && success !== 2) || (failed === undefined && success !== 1);
  }) || attemptRows.length !== expectedIds.length + failedAttempts.size) fail('Incomplete action wording attempt history');
  if (manifest.model !== MODEL || manifest.lang !== LANGUAGE || manifest.version !== VERSION
      || Object.keys(manifest.clips ?? {}).sort().join() !== Object.keys(appExpected).sort().join()) fail('Wrong app action wording manifest provenance or asset inventory');
  for (const [filename, text] of Object.entries(appExpected)) {
    const entry = manifest.clips[filename], path = resolve(APP_RAW, filename);
    if (!existsSync(path)) fail(`Missing app wording WAV: ${filename}`);
    const bytes = readFileSync(path);
    inspectWav(bytes, SOURCE_RATE);
    if (hash(bytes) !== entry.sha256 || entry.text !== text || entry.model !== MODEL || entry.lang !== LANGUAGE
        || entry.version !== VERSION || entry.sourceAttempt !== successfulAttempts.get(filename === APP_FILES.demo_mail ? 'demo_mail'
          : Object.keys(APP_FILES).find(id => APP_FILES[id] === filename)) || entry.sampleRate !== SOURCE_RATE || entry.channels !== 1
        || entry.bitsPerSample !== 16 || entry.bytePreserved !== true || entry.responseAudioSha256 !== entry.sha256
        || entry.sourceSha256 !== entry.sha256 || entry.sourceSampleRate !== SOURCE_RATE
        || entry.resample !== 'original MeloTTS WAV preserved byte-for-byte at 44100 Hz'
        || entry.textSha256 !== hash(Buffer.from(text, 'utf8'))) fail(`Wrong app wording provenance or hash: ${filename}`);
  }
  console.log(`ACTION_WORDING_AUDIO_OK: seven server and eight app MeloTTS WAV assets verified`);
  return { server: 7, app: 8 };
}

function resample(bytes) {
  const output = resolve(tmpdir(), `action-wording-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  try {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-map_metadata', '-1', '-ac', '1', '-ar', String(TARGET_RATE),
      '-af', 'aresample=resampler=swr:filter_size=64:cutoff=0.95', '-c:a', 'pcm_s16le', '-f', 'wav', output],
    { input: bytes, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0 || !existsSync(output)) fail('Offline wording WAV resampling failed');
    return readFileSync(output);
  } finally { try { unlinkSync(output); } catch {} }
}

function emit(generation) {
  const { assets: existing, attemptRows } = generation;
  const serverAssets = {};
  for (const [id, text] of Object.entries(SERVER_TEXTS)) {
    const original = existing[id];
    const sourceSha256 = hash(original.bytes);
    const bytes = resample(original.bytes);
    const asset = { model: MODEL, lang: LANGUAGE, version: VERSION, text, data: bytes.toString('base64'), sha256: hash(bytes),
      sampleRate: TARGET_RATE, sourceAttempt: original.attempt, sourceSha256, sourceSampleRate: SOURCE_RATE, resample: RESAMPLE };
    validateAsset(asset, text);
    serverAssets[id] = asset;
  }
  const moduleText = renderActionWordingSource(serverAssets);
  writeFileSync(MODULE + '.tmp', moduleText); renameSync(MODULE + '.tmp', MODULE);
  const clips = {};
  for (const [id, filename] of Object.entries(APP_FILES)) {
    const original = existing[id];
    const destination = resolve(APP_RAW, filename);
    writeFileSync(destination + '.tmp', original.bytes); renameSync(destination + '.tmp', destination);
    clips[filename] = { text: original.text, model: MODEL, lang: LANGUAGE, version: VERSION, sampleRate: SOURCE_RATE,
      sourceAttempt: original.attempt, channels: 1, bitsPerSample: 16, bytes: original.bytes.length, durationSeconds: original.wav.durationSeconds,
      textSha256: hash(Buffer.from(original.text, 'utf8')), sha256: hash(original.bytes),
      sourceSha256: hash(original.bytes), sourceSampleRate: SOURCE_RATE,
      resample: 'original MeloTTS WAV preserved byte-for-byte at 44100 Hz',
      responseAudioSha256: hash(original.bytes), bytePreserved: true };
  }
  const calls = attemptRows.reduce((sum, row) => sum + row.calls, 0);
  writeFileSync(APP_MANIFEST, JSON.stringify({ model: MODEL, lang: LANGUAGE, version: VERSION, calls,
    attempts: attemptRows, generatedAt: new Date().toISOString(), clips }, null, 2) + '\n');
  checkShipped();
}

function attemptPaths(id, attempt) {
  const suffix = attempt === 1 ? '' : `.attempt-${attempt}`;
  const key = id + suffix;
  return { request: resolve(contextRoot, 'requests', `${key}.json`), response: resolve(contextRoot, 'responses', `${key}.json`),
    source: resolve(contextRoot, 'source', `${key}.wav`) };
}

function readAttempt(id, text, attempt) {
  const paths = attemptPaths(id, attempt);
  const hasRequest = existsSync(paths.request), hasResponse = existsSync(paths.response);
  if (!hasRequest && !hasResponse) return undefined;
  if (!hasRequest) fail(`Preserved response for ${id} attempt ${attempt} has no pre-request ledger`);
  if (!hasResponse) fail(`Request for ${id} attempt ${attempt} was issued without a preserved response; no retry allowed`);
  const request = JSON.parse(readFileSync(paths.request, 'utf8'));
  if (request.model !== MODEL || request.lang !== LANGUAGE || request.version !== VERSION || request.id !== id || request.text !== text
      || (request.attempt ?? 1) !== attempt) fail(`Wrong pre-request ledger for ${id} attempt ${attempt}`);
  const result = JSON.parse(readFileSync(paths.response, 'utf8'));
  if (result.id !== id || result.calls !== 1) fail(`Invalid preserved MeloTTS response for ${id} attempt ${attempt}`);
  const diagnostic = result.diagnostic && typeof result.diagnostic === 'object'
    ? { name: ['Error', 'TypeError', 'RangeError', 'VoiceHttpError', 'VoiceDeadlineError', 'AudioInputError'].includes(result.diagnostic.name) ? result.diagnostic.name : 'Error',
      stage: ['before-ai', 'provider', 'provider-response'].includes(result.diagnostic.stage) ? result.diagnostic.stage : 'provider',
      ...(Number.isInteger(result.diagnostic.status) && result.diagnostic.status >= 400 && result.diagnostic.status <= 599 ? { status: result.diagnostic.status } : {}),
      ...(Number.isInteger(result.diagnostic.providerCode) && result.diagnostic.providerCode >= 0 && result.diagnostic.providerCode <= 999999
        ? { providerCode: result.diagnostic.providerCode } : {}) }
    : undefined;
  if (typeof result.rawAudioBase64 === 'string') {
    const rawAudio = Buffer.from(result.rawAudioBase64, 'base64');
    mkdirSync(dirname(paths.source), { recursive: true });
    if (existsSync(paths.source)) {
      if (!readFileSync(paths.source).equals(rawAudio)) fail(`Preserved source WAV disagrees with response for ${id} attempt ${attempt}`);
    } else writeFileSync(paths.source, rawAudio, { flag: 'wx' });
  if (result.failed === true) {
      try {
        const wav = inspectWav(rawAudio, SOURCE_RATE);
        return { id, attempt, calls: result.calls, outcome: 'audio_recovered', diagnostic, text, bytes: rawAudio, wav };
      } catch { /* Keep the failed response and raw bytes for diagnosis; never retry automatically. */ }
    }
  }
  if (result.failed === true) return { id, attempt, calls: result.calls, outcome: 'failed', diagnostic };
  if (result.text !== text || result.audio?.mimeType !== 'audio/wav') fail(`Invalid preserved MeloTTS result for ${id} attempt ${attempt}`);
  const bytes = Buffer.from(result.audio.data, 'base64');
  if (typeof result.rawAudioBase64 !== 'string' || !Buffer.from(result.rawAudioBase64, 'base64').equals(bytes)) {
    fail(`Missing or mismatched raw MeloTTS audio for ${id} attempt ${attempt}`);
  }
  mkdirSync(dirname(paths.source), { recursive: true });
  if (existsSync(paths.source)) {
    if (!readFileSync(paths.source).equals(bytes)) fail(`Preserved source WAV disagrees with response for ${id} attempt ${attempt}`);
  } else writeFileSync(paths.source, bytes, { flag: 'wx' });
  const wav = inspectWav(bytes, SOURCE_RATE);
  return { id, attempt, calls: result.calls, outcome: 'success', text, bytes, wav };
}

function loadGeneration() {
  const texts = { ...ALL_TEXTS, demo_mail: readDemoMailText() };
  readDemoCalendarOfferText();
  const assets = {}, attemptRows = [], missing = [], unresolvedFailures = [];
  for (const [id, text] of Object.entries(texts)) {
    const first = readAttempt(id, text, 1);
    const second = readAttempt(id, text, 2);
    if (first?.outcome === 'success' || first?.outcome === 'audio_recovered') {
      if (second) fail(`Unexpected second attempt for successful wording ID ${id}`);
      assets[id] = first; attemptRows.push({ id, attempt: 1, calls: first.calls, outcome: first.outcome,
        ...(first.diagnostic ? { diagnostic: first.diagnostic } : {}) });
      continue;
    }
    if (first?.outcome === 'failed') {
      attemptRows.push({ id, attempt: 1, calls: first.calls, outcome: 'failed', ...(first.diagnostic ? { diagnostic: first.diagnostic } : {}) });
      if (second?.outcome === 'success' || second?.outcome === 'audio_recovered') {
        assets[id] = second; attemptRows.push({ id, attempt: 2, calls: second.calls, outcome: second.outcome,
          ...(second.diagnostic ? { diagnostic: second.diagnostic } : {}) });
      } else if (second?.outcome === 'failed') {
        attemptRows.push({ id, attempt: 2, calls: second.calls, outcome: 'failed', ...(second.diagnostic ? { diagnostic: second.diagnostic } : {}) });
        unresolvedFailures.push(id);
      } else unresolvedFailures.push(id);
      continue;
    }
    if (second) fail(`Attempt 2 exists without a failed attempt 1 for ${id}`);
    missing.push({ id, text });
  }
  return { assets, attemptRows, missing, unresolvedFailures, complete: missing.length === 0 && unresolvedFailures.length === 0 };
}

export function workerSourceFor(voiceImport, texts) {
  return [
    `import { synthesize } from '${voiceImport}';`,
    `const texts=${JSON.stringify(texts)};`,
    "const seen=new Set();",
    "const allowedNames=new Set(['Error','TypeError','RangeError','VoiceHttpError','VoiceDeadlineError','AudioInputError']);",
    "function encode(bytes){let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));return btoa(binary)}",
    "function wavInfo(bytes){if(bytes.length<44||String.fromCharCode(...bytes.subarray(0,4))!=='RIFF'||String.fromCharCode(...bytes.subarray(8,12))!=='WAVE')return null;const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return{format:view.getUint16(20,true),channels:view.getUint16(22,true),sampleRate:view.getUint32(24,true),bitsPerSample:view.getUint16(34,true)}}",
    "function diagnostic(error,stage,status,upstream){const name=allowedNames.has(error?.name)?error.name:'Error';const result={name,stage,...(Number.isInteger(status)?{status}:{}),...(upstream?{upstream}:{})};if(Number.isInteger(error?.code)&&error.code>=0&&error.code<=999999)result.providerCode=error.code;return result}",
    "function decodeAudio(value){try{if(value instanceof Uint8Array)return value;if(value instanceof ArrayBuffer)return new Uint8Array(value);if(typeof value!=='string')return null;value=value.startsWith('data:')?value.slice(value.indexOf(',')+1):value;const binary=atob(value);return Uint8Array.from(binary,char=>char.charCodeAt(0))}catch{return null}}",
    "function captureValue(value,kind){let audio=null;const body=value?.result??value;if(body&&typeof body==='object')audio=decodeAudio(body.audio??body.data);const wav=audio&&audio.length<=2097152?wavInfo(audio):null;return{upstream:{rawKind:kind,...(wav?{wav}:{})},...(wav?{rawAudioBase64:encode(audio)}:{})}}",
    "async function capture(response){const type=response.headers.get('content-type')||'';const contentTypeClass=type.startsWith('audio/')?'audio':type.includes('json')?'json':'other';const upstream={rawKind:'response',status:response.status,contentTypeClass};try{const reader=response.clone().body?.getReader();if(!reader)return{upstream};const chunks=[];let size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>3145728){await reader.cancel();return{upstream}}chunks.push(part.value)}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}let audio=wavInfo(bytes)?bytes:null;if(!audio&&contentTypeClass==='json'){const payload=JSON.parse(new TextDecoder().decode(bytes));const body=payload?.result??payload;audio=decodeAudio(body?.audio??body?.data)}const wav=audio&&audio.length<=2097152?wavInfo(audio):null;return{upstream:{...upstream,...(wav?{wav}:{})},...(wav?{rawAudioBase64:encode(audio)}:{})}}catch{return{upstream}}}",
    `const model=${JSON.stringify(MODEL)};`,
    "export default {async fetch(request,env){const id=new URL(request.url).pathname.slice(1);if(request.method!=='POST'||!(id in texts))return new Response('',{status:404});if(seen.has(id))return new Response('',{status:409});seen.add(id);let calls=0,stage='before-ai',upstreamStatus,captured={};const ai={run:async(...args)=>{if(++calls!==1||args[0]!==model)throw Error('Expected one MeloTTS call');stage='provider';const value=await env.AI.run(...args);stage='provider-response';if(value instanceof Response){upstreamStatus=value.status;captured=await capture(value)}else captured=captureValue(value,'object-audio');return value}};try{const result=await synthesize(ai,texts[id],Date.now()+60000,{reserve:(_stage,call)=>{if(call!=='primary')throw Error('No hedge credit')}});return Response.json({...result,...captured,id,calls})}catch(error){const status=Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:upstreamStatus;return Response.json({failed:true,id,calls,...captured,diagnostic:diagnostic(error,stage,status,captured.upstream)},{status:502})}}};",
  ].join('\n');
}

async function issueAttempts(items, attempt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) fail('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID');
  mkdirSync(resolve(contextRoot, 'requests'), { recursive: true });
  mkdirSync(resolve(contextRoot, 'responses'), { recursive: true });
  const voiceImport = relative(contextRoot, resolve(server, 'src/voice.ts')).replaceAll('\\', '/');
  const texts = Object.fromEntries(items.map(({ id, text }) => [id, text]));
  writeFileSync(resolve(contextRoot, 'worker.ts'), workerSourceFor(voiceImport, texts));
  const configPath = resolve(contextRoot, 'wrangler.jsonc');
  writeFileSync(configPath, JSON.stringify({ name: 'mobi-action-wording-assets', main: 'worker.ts', compatibility_date: '2025-08-29',
    account_id: accountId, ai: { binding: 'AI' }, observability: { enabled: false } }, null, 2));
  const port = 8793;
  const child = spawn('npx', ['--no-install', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--config', configPath],
    { cwd: server, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false, startupFailed = false;
  child.on('error', () => { startupFailed = true; });
  child.stdout.on('data', data => { if (String(data).includes('Ready on')) ready = true; });
  child.stderr.on('data', () => {});
  try {
    for (let i = 0; i < 120 && !ready; i++) {
      if (startupFailed || child.exitCode !== null) fail('Local wording Worker failed to start');
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    if (!ready) fail('Local wording Worker did not become ready');
    for (const { id, text } of items) {
      const paths = attemptPaths(id, attempt);
      if (existsSync(paths.request) || existsSync(paths.response)) fail(`Attempt ${attempt} for ${id} already exists; no retry allowed`);
      writeFileSync(paths.request, JSON.stringify({ model: MODEL, lang: LANGUAGE, version: VERSION, id, text, attempt, issuedAt: new Date().toISOString() }), { flag: 'wx' });
      const response = await fetch(`http://127.0.0.1:${port}/${encodeURIComponent(id)}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(65000) });
      const result = await response.json();
      // Preserve before local validation so embedding/resampling can resume without another inference.
      writeFileSync(paths.response, JSON.stringify(result));
      if (typeof result.rawAudioBase64 === 'string') {
        const rawAudio = Buffer.from(result.rawAudioBase64, 'base64');
        mkdirSync(dirname(paths.source), { recursive: true });
        writeFileSync(paths.source, rawAudio, { flag: 'wx' });
      }
      if (!response.ok || result.id !== id || result.calls !== 1 || result.text !== text || result.audio?.mimeType !== 'audio/wav') {
        const safe = result.diagnostic ? JSON.stringify(result.diagnostic) : 'no diagnostic';
        fail(`MeloTTS generation failed for ${id} attempt ${attempt}; response preserved (${safe}); no retry`);
      }
      const original = Buffer.from(result.audio.data, 'base64');
      if (typeof result.rawAudioBase64 !== 'string' || !Buffer.from(result.rawAudioBase64, 'base64').equals(original)) {
        fail(`Missing or mismatched raw MeloTTS audio for ${id} attempt ${attempt}; response preserved; no retry`);
      }
      inspectWav(original, SOURCE_RATE);
      console.log(`${id} attempt ${attempt}: MeloTTS response preserved (${original.length} bytes)`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise(done => {
      if (child.exitCode !== null || startupFailed) return done();
      child.once('exit', done);
      setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000).unref();
    });
  }
}

async function generate() {
  let state = loadGeneration();
  if (state.unresolvedFailures.length) fail(`Failed wording IDs require an explicit one-time --retry-failed: ${state.unresolvedFailures.join(', ')}`);
  if (state.complete) { emit(state); return; }
  if (state.missing.length) await issueAttempts(state.missing, 1);
  state = loadGeneration();
  if (!state.complete) fail('One or more wording responses are missing');
  emit(state);
}

async function retryFailed(id) {
  const state = loadGeneration();
  if (!Object.hasOwn(ALL_TEXTS, id) && id !== 'demo_mail') fail('Unknown wording ID');
  if (state.unresolvedFailures.length !== 1 || state.unresolvedFailures[0] !== id) fail('Retry requires exactly one unresolved failed ID matching --retry-failed');
  if (state.attemptRows.length >= 10 || state.attemptRows.some(row => row.attempt === 2)) fail('The single bounded retry has already been used');
  const text = id === 'demo_mail' ? readDemoMailText() : ALL_TEXTS[id];
  const prior = readAttempt(id, text, 1);
  const second = readAttempt(id, text, 2);
  if (prior?.outcome !== 'failed' || second) fail('Only a failed first attempt with no second attempt may be retried once');
  await issueAttempts([{ id, text }], 2);
  const recovered = loadGeneration();
  if (recovered.unresolvedFailures.includes(id)) fail(`Retry for ${id} did not produce usable MeloTTS audio; response preserved, no further retry`);
  console.log(`${id} attempt 2 preserved; no additional attempt issued`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--check')) checkShipped();
    else if (process.argv.includes('--generate')) await generate();
    else if (process.argv.includes('--retry-failed')) {
      const at = process.argv.indexOf('--retry-failed');
      if (!process.argv[at + 1]) fail('Use --retry-failed <id> for one explicit retry of a preserved failed first attempt');
      await retryFailed(process.argv[at + 1]);
    }
    else if (process.argv.includes('--embed-existing')) {
      const existing = loadGeneration(); if (!existing.complete) fail('Preserved MeloTTS responses are incomplete'); emit(existing);
    } else fail('Use --check, --generate, --retry-failed <id>, or --embed-existing');
  } catch (error) {
    console.error(`Action wording asset operation failed (${error?.name === 'Error' ? error.message : 'Error'}).`);
    process.exitCode = 1;
  }
}
