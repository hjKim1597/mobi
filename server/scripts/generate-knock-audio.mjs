import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(server, '..');
const output = resolve(server, 'src/knock-audio.ts');
const texts = {
  '0': '오늘 일정은 없어요.',
  '1-online': '오늘 일정이 한 개 있어요. 들으시겠어요?',
  '1-offline': '오늘 일정이 한 개 있어요. 정차하면 카드로 보여드릴게요.',
  'many-online': '오늘 일정이 여러 개 있어요. 들으시겠어요?',
  'many-offline': '오늘 일정이 여러 개 있어요. 정차하면 카드로 보여드릴게요.',
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const safeError = message => Object.assign(Error(message), { safe: true });
export function formatError(error) {
  if (error?.safe === true && typeof error.message === 'string') return error.message;
  const status = Number.isInteger(error?.status) ? ` HTTP ${error.status}` : '';
  const stage = ['before-ai', 'ai', 'response', 'validate'].includes(error?.stage) ? ` stage ${error.stage}` : '';
  return `Knock asset operation failed${stage}${status} (${error?.name === 'TypeError' ? 'TypeError' : 'Error'}).`;
}
function check() {
  const source = readFileSync(output, 'utf8');
  if (!source.includes('Model: @cf/myshell-ai/melotts; lang: kr; version: knock-v1.')) throw safeError('Wrong embedded asset provenance');
  const manifestPath = resolve(root, '.context/voice-server/knock-build/manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  if (manifest && (manifest.version !== 'knock-v1' || manifest.model !== '@cf/myshell-ai/melotts' || manifest.lang !== 'kr')) throw safeError('Wrong build manifest');
  const assets = JSON.parse(source.slice(source.indexOf(' = ') + 3).trim().replace(/;$/, ''));
  if (Object.keys(assets).sort().join() !== Object.keys(texts).sort().join()) throw safeError('Expected five real knock assets');
  for (const [id, asset] of Object.entries(assets)) {
    const bytes = Buffer.from(asset.data, 'base64');
    if (asset.text !== texts[id] || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
        bytes.length < 1000 || hash(bytes) !== asset.sha256 || (manifest && manifest.assets[id]?.sha256 !== asset.sha256) || bytes.readUInt32LE(24) !== asset.sampleRate) throw safeError('Invalid knock asset: ' + id);
  }
  console.log('KNOCK_ASSETS_OK: five real WAV assets, text and SHA-256 verified');
}
async function generate(ctx) {
  if (!ctx.startsWith(resolve(root, '.context/voice-server') + '/')) throw safeError('CTX must be inside voice-server context');
  mkdirSync(ctx, { recursive: true });
  const voiceImport = relative(ctx, resolve(server, 'src/voice.ts')).replaceAll('\\', '/');
  writeFileSync(resolve(ctx, 'worker.ts'), `import { synthesize } from '${voiceImport}';
const texts=${JSON.stringify(texts)};
const safeError=message=>Object.assign(Error(message),{safe:true});
export default {async fetch(request,env){
 const id=new URL(request.url).pathname.slice(1);if(request.method!=='POST'||!(id in texts))return new Response('',{status:404});
 const start=Date.now();let stage='before-ai',upstream={};
 const ai={run:async(...args)=>{stage='ai';const r=await env.AI.run(...args);stage='response';
 if(r instanceof Response){let b=new Uint8Array(await r.clone().arrayBuffer());if(r.headers.get('content-type')?.includes('application/json')){const p=JSON.parse(new TextDecoder().decode(b));if(typeof p.audio==='string')b=Uint8Array.from(atob(p.audio),c=>c.charCodeAt(0));}const v=new DataView(b.buffer);
 upstream={status:r.status,type:r.headers.get('content-type')?.includes('audio/')?'audio':r.headers.get('content-type')?.includes('json')?'json':'other',bytes:b.length,wav:b.length>=12&&[82,73,70,70].every((x,i)=>b[i]===x)&&[87,65,86,69].every((x,i)=>b[i+8]===x),format:b.length>36?v.getUint16(20,true):null,bits:b.length>36?v.getUint16(34,true):null,declared:b.length>8?v.getUint32(4,true):null};}
 stage='validate';return r;}};
 try{return Response.json(await synthesize(ai,texts[id],Date.now()+4800,{reserve:(_stage,call)=>{if(call!=='primary')throw safeError('Asset generation has no hedge credit');}}));}
 catch(e){return Response.json({errorName:e.name,status:e.status,stage,elapsedMs:Date.now()-start,upstream},{status:502});}
}};\n`);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) throw safeError('CLOUDFLARE_ACCOUNT_ID must be configured as a 32-character account ID');
  writeFileSync(resolve(ctx, 'wrangler.jsonc'), JSON.stringify({ name: 'mobi-dev', main: 'worker.ts', compatibility_date: '2025-08-29',
    account_id: accountId, ai: { binding: 'AI' }, observability: { enabled: false } }, null, 2));
  const budget = await createBudget(root);
  const child = spawn('npx', ['--no-install', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8789', '--config', resolve(ctx, 'wrangler.jsonc')],
    { cwd: server, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  child.stdout.on('data', data => { if (String(data).includes('Ready on')) ready = true; });
  child.stderr.on('data', () => {});
  try {
    for (let i = 0; i < 80 && !ready; i++) {
      if (child.exitCode !== null) throw safeError('Local asset Worker failed to start');
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ready) throw safeError('Local asset Worker did not become ready');
    const assets = {};
    for (const [id, text] of Object.entries(texts)) {
      await budget.reserve('asset-' + id, 10);
      const response = await fetch('http://127.0.0.1:8789/' + id, { method: 'POST', signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        const failure = await response.json();
        const stage = ['before-ai', 'ai', 'response', 'validate'].includes(failure.stage) ? failure.stage : 'unknown';
        throw safeError(`Asset synthesis failed at ${stage} (HTTP ${response.status})`);
      }
      const result = await response.json(), bytes = Buffer.from(result.audio.data, 'base64');
      if (result.text !== text || result.audio.mimeType !== 'audio/wav' || bytes.toString('ascii', 0, 4) !== 'RIFF') throw safeError('Invalid generated asset');
      writeFileSync(resolve(ctx, id + '.wav'), bytes);
      assets[id] = { text: result.text, data: result.audio.data, sha256: hash(bytes), sampleRate: bytes.readUInt32LE(24) };
    }
    const manifest = { version: 'knock-v1', model: '@cf/myshell-ai/melotts', lang: 'kr', generatedAt: new Date().toISOString(),
      assets: Object.fromEntries(Object.entries(assets).map(([id, a]) => [id, { ...a, data: undefined }])) };
    writeFileSync(resolve(ctx, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const source = '// Generated by scripts/generate-knock-audio.mjs; explicit regeneration only. Model: @cf/myshell-ai/melotts; lang: kr; version: knock-v1.\n' +
      'export const knockAssets: Record<string, { text: string; data: string; sha256: string; sampleRate: number }> = ' + JSON.stringify(assets) + ';\n';
    writeFileSync(output + '.tmp', source); renameSync(output + '.tmp', output);
    await budget.snapshot('assets-complete'); check();
  } finally { child.kill('SIGTERM'); await new Promise(r => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(() => { child.kill('SIGKILL'); r(); }, 3000).unref(); } }); }
}
export async function createBudget(worktree = root, task = 'implementation') {
  if (!['implementation', 'performance', 'hedging', 'confirm-threshold'].includes(task)) throw safeError('Unknown budget task');
  const accountedBudget = task === 'hedging' || task === 'confirm-threshold';
  const limit = task === 'performance' ? 1500 : task === 'hedging' ? 800 : task === 'confirm-threshold' ? 200 : 2000;
  if (worktree !== root) throw safeError('Wrong worktree');
  const ctx = resolve(root, task === 'performance' ? '.context/voice-server/perf/live' : task === 'hedging' ? '.context/voice-server/hedge/live' : task === 'confirm-threshold' ? '.context/voice-server/confirm-threshold/live' : '.context/voice-server/live');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account || !/^[a-f0-9]{32}$/i.test(account)) throw safeError('CLOUDFLARE_ACCOUNT_ID must be configured as a 32-character account ID');
  const env = { ...process.env, npm_config_cache: resolve(server, '.npm-cache'), TMPDIR: resolve(server, '.wrangler/tmp') };
  mkdirSync(ctx, { recursive: true });
  // Locked deployment Wrangler 4.43 has no auth-token command. This transient CLI
  // lives only in the worktree npm execution cache; package.json/lockfile do not change.
  // Its only purpose is to read the existing login through Wrangler, without reading/copying its config.
  let auth;
  try { auth = JSON.parse(execFileSync('npx', ['--yes', '--package=wrangler@4.152.0', 'wrangler', 'auth', 'token', '--json'],
    { cwd: server, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { throw safeError('Wrangler could not read the authorized existing login'); }
  if (!auth.token) throw safeError('No authenticated Wrangler API token');
  const api = async (path, body) => {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json',
        ...(accountedBudget && path === '/graphql' ? { 'X-Rate-Limit-Type': 'account-based' } : {}),
      },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    const errorCodes = (data.errors || []).map(x => Number.isInteger(x.code) ? String(x.code) : 'unknown').join(',');
    if (!response.ok || data.errors?.length || data.success === false) {
      const message = 'Cloudflare accounting request failed: HTTP ' + response.status + ', codes ' + errorCodes;
      if (response.status === 429 || (data.errors || []).some(x => /rate limiter budget depleted/i.test(String(x.message || '')))) throw Object.assign(safeError(message), { rateLimited: true });
      throw safeError(message);
    }
    return data;
  };
  const ledger = resolve(ctx, 'usage.jsonl');
  const record = data => appendFileSync(ledger, JSON.stringify({ timestamp: new Date().toISOString(), ...data }) + '\n');
  const entries = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const heldBudget = () => entries().filter(x => x.kind === 'reserve' || (accountedBudget && x.kind === 'reconcile'))
    .reduce((sum, x) => sum + (x.kind === 'reserve' ? x.neurons : x.spentNeurons - x.reservedNeurons), 0);
  const pendingReservations = () => {
    const rows = entries(), gross = rows.filter(x => x.kind === 'reserve').reduce((sum, x) => sum + x.neurons, 0);
    const released = accountedBudget ? rows.filter(x => x.kind === 'reconcile').reduce((sum, x) => sum + x.reservedNeurons, 0) : 0;
    return gross - released;
  };
  const reservations = () => accountedBudget ? heldBudget() : entries()
    .filter(x => x.kind === 'reserve' && x.day === new Date().toISOString().slice(0, 10)).reduce((sum, x) => sum + x.neurons, 0);
  const batchBaseline = row => ({ timestamp: row.timestamp, day: row.day, neurons: row.neurons,
    rows: Object.entries(row.modelCounts).map(([modelId, count]) => ({ dimensions: { modelId }, count, sum: { totalNeurons: 0 } })) });
  let lastObserved;
  const utcDay = timestamp => timestamp.slice(0, 10);
  const modelTotals = rows => {
    const totals = new Map();
    for (const row of rows) {
      const model = row.dimensions?.modelId || '';
      const total = totals.get(model) || { count: 0, neurons: 0 };
      total.count += Number(row.count) || 0;
      total.neurons += Number(row.sum?.totalNeurons) || 0;
      totals.set(model, total);
    }
    return [...totals].map(([modelId, total]) => ({ dimensions: { modelId }, count: total.count, sum: { totalNeurons: total.neurons } }));
  };
  const dayAnchor = day => {
    const all = entries();
    const saved = all.find(x => x.kind === 'day-anchor' && x.day === day);
    if (saved) return saved;
    const prior = all.filter(x => x.kind === 'snapshot' && (x.day || utcDay(x.timestamp)) === day && x.mode !== 'window' && Array.isArray(x.rows))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
    if (!prior) return undefined;
    const anchor = { kind: 'day-anchor', day, timestamp: prior.queryAt || prior.timestamp, capturedAt: prior.timestamp, neurons: prior.neurons, rows: prior.rows };
    record(anchor);
    return anchor;
  };
  const snapshot = async label => {
    let now, start;
    let data;
    let attempt = 0;
    while (!data) {
      now = new Date().toISOString();
      const day = utcDay(now), anchor = accountedBudget ? dayAnchor(day) : undefined;
      start = anchor ? anchor.timestamp : day + 'T00:00:00Z';
      const startFilter = anchor ? `datetime_gt:"${start}"` : `datetime_geq:"${start}"`;
      const sumFields = accountedBudget ? 'totalNeurons' : 'totalNeurons totalInputTokens totalOutputTokens totalAudioSeconds';
      try { data = await api('/graphql', { query: `{viewer{accounts(filter:{accountTag:"${account}"}){aiInferenceAdaptiveGroups(limit:10,filter:{${startFilter},datetime_leq:"${now}"}){count dimensions{modelId} sum{${sumFields}}}}}}` }); }
      catch (error) {
        if (accountedBudget && (error.rateLimited || /rate limiter budget depleted/i.test(error.message))) {
          for (let segment = 1; segment <= 6; segment++) {
            console.log(`Cloudflare usage rate limit; waiting 50s segment ${segment}/6 before read-only retry.`);
            await new Promise(r => setTimeout(r, 50000));
          }
          attempt = 0;
          continue;
        }
        if (attempt++ >= 2) throw error;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    const windowRows = data.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
    if (!Array.isArray(windowRows)) throw safeError('Account usage unavailable');
    const day = utcDay(now), anchor = accountedBudget ? dayAnchor(day) : undefined;
    if (anchor && windowRows.length >= 10) throw safeError('Window usage returned the 10-row limit; model totals may be truncated');
    const rows = anchor ? modelTotals([...anchor.rows, ...windowRows]) : windowRows;
    const neurons = rows.reduce((sum, row) => sum + (Number(row.sum?.totalNeurons) || 0), 0);
    if (accountedBudget) {
      const mode = anchor ? 'window' : 'full-day';
      record({ kind: 'snapshot', day, label, queryAt: now, mode, ...(anchor ? { anchorTimestamp: anchor.timestamp } : {}), neurons, rows });
      if (!anchor) record({ kind: 'day-anchor', day, timestamp: now, neurons, rows });
    } else record({ kind: 'snapshot', label, neurons, rows });
    lastObserved = { timestamp: now, day, neurons, rows };
    return lastObserved;
  };
  const catalog = await api(`/accounts/${account}/ai/models/search?per_page=100`);
  writeFileSync(resolve(ctx, 'catalog.json'), JSON.stringify(catalog, null, 2));
  await snapshot('session-start');
  return {
    snapshot,
    async available() {
      if (!accountedBudget) throw safeError('Available budget inspection is limited to isolated inference ledgers');
      return Math.max(0, limit - reservations());
    },
    async taskBaseline(label) {
      if (!accountedBudget) throw safeError('Task baselines are limited to isolated inference ledgers');
      const prior = entries().find(x => x.kind === 'snapshot' && x.label === label);
      if (prior) return { timestamp: prior.timestamp, day: prior.day, neurons: prior.neurons, rows: prior.rows };
      return snapshot(label);
    },
    async pendingBatches() {
      if (!accountedBudget) throw safeError('Pending batches are limited to isolated inference ledgers');
      const all = entries();
      return all.filter(x => x.kind === 'batch-start' && !all.some(y => y.kind === 'reconcile' && y.batch === x.batch))
        .map(x => ({ batch: x.batch, day: x.day })).sort((a, b) => a.batch.localeCompare(b.batch));
    },
    async batches() {
      if (!accountedBudget) throw safeError('Batch listing is limited to isolated inference ledgers');
      return entries().filter(x => x.kind === 'batch-start').map(x => ({ batch: x.batch, day: x.day })).sort((a, b) => a.batch.localeCompare(b.batch));
    },
    async beginBatch(batch) {
      if (!accountedBudget || !batch) throw safeError('Batch baselines are limited to isolated inference ledgers');
      const rows = entries();
      const settled = rows.find(x => x.kind === 'reconcile' && x.batch === batch);
      const prior = rows.find(x => x.kind === 'batch-start' && x.batch === batch);
      if (settled) return { settled, ...(prior ? { baseline: batchBaseline(prior) } : {}) };
      const today = new Date().toISOString().slice(0, 10);
      if (prior) {
        if (prior.day !== today) throw safeError('Pending hedging batch crossed UTC day; its reservation remains held');
        return { baseline: batchBaseline(prior) };
      }
      const observed = lastObserved;
      if (!observed || observed.day !== today) throw safeError('Current UTC-day account snapshot is unavailable; no inference may start');
      const modelCounts = Object.fromEntries(observed.rows.map(row => [row.dimensions?.modelId || '', Number(row.count) || 0]));
      const data = { kind: 'batch-start', day: today, batch,
        timestamp: observed.timestamp, neurons: observed.neurons, modelCounts };
      record(data);
      return { baseline: batchBaseline(data) };
    },
    async reserveBatch(batch, requested) {
      if (!accountedBudget || !batch || !Array.isArray(requested) || !requested.length) throw safeError('Batch reservations are limited to isolated inference ledgers');
      const today = new Date().toISOString().slice(0, 10), all = entries();
      const started = all.find(x => x.kind === 'batch-start' && x.batch === batch);
      if (!started || started.day !== today) throw safeError('Hedging batch must have a current-day persisted baseline before reservation');
      if (all.some(x => x.kind === 'reconcile' && x.batch === batch)) throw safeError('Hedging batch is already reconciled');
      const observed = lastObserved;
      if (!observed) throw safeError('A fresh batch usage snapshot is required');
      const labels = new Set(), additions = [];
      for (const item of requested) {
        if (!item || typeof item.label !== 'string' || !Number.isFinite(item.neurons) || item.neurons <= 0 || labels.has(item.label)) throw safeError('Invalid hedging reservation batch');
        labels.add(item.label);
        const existing = all.find(x => x.kind === 'reserve' && x.label === item.label);
        if (existing) {
          if (existing.neurons !== item.neurons || existing.batch !== batch) throw safeError('Conflicting hedging reservation retry');
        } else additions.push({ kind: 'reserve', day: today, label: item.label, neurons: item.neurons, batch });
      }
      const added = additions.reduce((sum, x) => sum + x.neurons, 0), held = reservations();
      if (held + added > limit || observed.neurons + pendingReservations() + added >= 10000) throw safeError('Daily AI neuron budget exhausted');
      let total = held;
      const lines = additions.map(item => {
        total += item.neurons;
        return JSON.stringify({ timestamp: new Date().toISOString(), ...item, reservedTotal: total });
      });
      if (lines.length) appendFileSync(ledger, lines.join('\n') + '\n');
      return { addedNeurons: added, heldNeurons: held + added };
    },
    async reserve(label, neurons, batch) {
      if (accountedBudget) {
        const existing = entries().find(x => x.kind === 'reserve' && x.label === label);
        if (existing) {
          if (existing.neurons !== neurons || existing.batch !== batch) throw safeError('Conflicting hedging reservation retry');
          return;
        }
      }
      const observed = lastObserved;
      if (!observed) throw safeError('A fresh batch usage snapshot is required');
      const reserved = reservations();
      const overLimit = accountedBudget ? reserved + neurons > limit : reserved + neurons >= limit;
      const dailyOutstanding = accountedBudget ? pendingReservations() : reserved;
      if (overLimit || observed.neurons + dailyOutstanding + neurons >= 10000) throw safeError('Daily AI neuron budget exhausted');
      record({ kind: 'reserve', day: new Date().toISOString().slice(0, 10), label, neurons, ...(batch ? { batch } : {}), reservedTotal: reserved + neurons });
    },
    async reconcile(batch, baseline, expectedModelCounts) {
      if (!accountedBudget) throw safeError('Neuron reconciliation is limited to isolated inference ledgers');
      if (!batch || !baseline || !Array.isArray(baseline.rows) || !expectedModelCounts || typeof expectedModelCounts !== 'object') throw safeError('Invalid hedging reconciliation request');
      const rows = entries();
      const prior = rows.find(x => x.kind === 'reconcile' && x.batch === batch);
      if (prior) return prior;
      const started = rows.find(x => x.kind === 'batch-start' && x.batch === batch);
      if (!started) throw safeError('Hedging batch baseline was not persisted');
      if (started.day !== new Date().toISOString().slice(0, 10)) throw safeError('Hedging batch crossed UTC day; its reservation remains held');
      if (baseline.day !== started.day) throw safeError('Hedging reconciliation baseline does not match its persisted UTC day');
      const reserved = rows.filter(x => x.kind === 'reserve' && x.batch === batch)
        .reduce((sum, x) => sum + x.neurons, 0);
      if (!reserved) throw safeError('No hedging reservations to reconcile');
      const baselineCounts = Object.fromEntries(baseline.rows.map(row => [row.dimensions?.modelId, Number(row.count) || 0]));
      if (!Object.values(expectedModelCounts).some(count => Number.isInteger(count) && count > 0)) throw safeError('Expected model counts must include at least one started call');
      const satisfied = current => Object.entries(expectedModelCounts).every(([model, count]) => {
        if (!Number.isInteger(count) || count < 0) throw safeError('Invalid expected model count');
        if (!count) return true;
        const currentCount = current.rows.filter(row => row.dimensions?.modelId === model).reduce((sum, row) => sum + (Number(row.count) || 0), 0);
        return currentCount - (baselineCounts[model] || 0) === count;
      });
      let observed = lastObserved?.day === new Date().toISOString().slice(0, 10) && satisfied(lastObserved) ? lastObserved : undefined;
      for (let attempt = 1; !observed && attempt <= 10; attempt++) {
        const candidate = await snapshot(`hedging-reconcile-${batch}-${attempt}`);
        if (satisfied(candidate)) { observed = candidate; break; }
        console.log(`Waiting for Cloudflare usage counts, poll ${attempt}/10; next check in 60s.`);
        if (attempt < 10) await new Promise(r => setTimeout(r, 60000));
      }
      if (!observed || !satisfied(observed)) throw safeError('Cloudflare model call counts have not settled; hedging reservations remain held');
      const spent = Math.max(0, observed.neurons - baseline.neurons);
      const data = { kind: 'reconcile', day: new Date().toISOString().slice(0, 10), batch, reservedNeurons: reserved, spentNeurons: spent,
        expectedModelCounts, observedModelCounts: Object.fromEntries(Object.keys(expectedModelCounts).map(model => [model,
          observed.rows.filter(row => row.dimensions?.modelId === model).reduce((sum, row) => sum + (Number(row.count) || 0), 0) - (baselineCounts[model] || 0)])),
        accountDelta: spent };
      record(data);
      return data;
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {

try {
  if (process.argv.includes('--check')) check();
  else if (process.argv.includes('--generate') && process.argv.includes('--ctx')) await generate(resolve(process.argv[process.argv.indexOf('--ctx') + 1]));
  else throw safeError('Use --check or --generate --ctx <worktree context directory>');
} catch (error) {
  console.error(formatError(error));
  process.exitCode = 1;
}

}
