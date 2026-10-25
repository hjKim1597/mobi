import {describe,it,expect,vi,afterEach} from 'vitest';
import {handleTurn,VoiceHttpError} from '../src/voice';
import {bytesToBase64} from '../src/audio';
import {failureSentences} from '../src/failure-audio';
import type {TodayCalendar} from '../src/calendar';
const wav=()=>{const b=new Uint8Array(684),v=new DataView(b.buffer);const s=(p:number,t:string)=>[...t].forEach((c,i)=>b[p+i]=c.charCodeAt(0));s(0,'RIFF');v.setUint32(4,b.length-8,true);s(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);s(36,'data');v.setUint32(40,640,true);for(let i=44;i<b.length;i+=2)v.setInt16(i,2000,true);return b;};
const input={tripId:'trip',audio:{data:bytesToBase64(wav()),mimeType:'audio/wav' as const}};
const freshInput=()=>({...input,audio:{...input.audio}});
const cal:TodayCalendar={date:'2026-10-25',timeZone:'Asia/Seoul',events:[]};
const later=<T>(ms:number,value:T)=>new Promise<T>(r=>setTimeout(()=>r(value),ms));
const init=()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-25T01:00:00Z'));};
const context=(ai:Ai)=>({ai,deadlineAt:Date.now()+4800,responseReadyAt:Date.now()+3900,readCalendar:async()=>cal,check:async()=>{}});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe('three-day bounded question pipeline',()=>{
 it('answers an exact Calendar intent without an LLM and still transcribes',async()=>{
  init();const run=vi.fn((model:string)=>model.includes('whisper')?{text:'오늘 일정 몇 개야'}:new Response(wav()));
  const result=await handleTurn(freshInput(),context({run}as unknown as Ai));
  expect(result.transcript).toBe('오늘 일정 몇 개야');expect(result.sentences[0].text).toBe('오늘 일정은 없어요.');
  expect(run.mock.calls.map(c=>c[0])).toEqual(['@cf/openai/whisper-large-v3-turbo','@cf/myshell-ai/melotts']);
 });
 it('uses compatible existing audio without new synthesis and returns fresh turn IDs',async()=>{
  init();const run=vi.fn(()=>({text:'오늘 일정 몇 개야'}));const audio={data:bytesToBase64(wav()),mimeType:'audio/wav' as const};
  const readCached=vi.fn(async()=>({audio,expiresAt:Date.now()+30000}));const ctx={...context({run}as unknown as Ai),readCached};
  const a=await handleTurn(freshInput(),ctx),b=await handleTurn(freshInput(),ctx);
  expect(a.turnId).not.toBe(b.turnId);expect(a.transcript).toBe('오늘 일정 몇 개야');expect(a.sentences[0].audio).toEqual(audio);expect(run).toHaveBeenCalledTimes(2);expect(readCached).toHaveBeenCalledTimes(2);
 });
 it('declines to start an LLM without 2300ms response-ready headroom',async()=>{
  init();const run=vi.fn((_model:string)=>later(1700,{text:'지원되지 않는 긴 질문'}));const pending=handleTurn(freshInput(),context({run}as unknown as Ai));
  await vi.advanceTimersByTimeAsync(1700);const result=await pending;
  expect(result.sentences).toEqual([failureSentences.question]);expect(run.mock.calls.every(c=>(c[0] as string).includes('whisper'))).toBe(true);
 });
 it.each(['calendar','llm','tts'] as const)('returns cached failure by the cutoff for hung %s after valid STT',async(stage)=>{
  init();const never=new Promise<never>(()=>{});
  const run=vi.fn((model:string)=>model.includes('whisper')?{text:stage==='llm'?'지원되지 않는 질문':'오늘 일정 몇 개야'}:stage==='tts'?never:new Response(wav()));
  const ctx={...context({run}as unknown as Ai),...(stage==='calendar'?{readCalendar:()=>never}:{}),...(stage==='llm'?{provider:{respond:()=>never}}:{})};
  const pending=handleTurn(freshInput(),ctx);await vi.advanceTimersByTimeAsync(3900);const result=await pending;
  expect(result.transcript).not.toBe('');expect(result.sentences).toEqual([failureSentences.question]);
  const calls=run.mock.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(run).toHaveBeenCalledTimes(calls);
 });
 it('does not invent a transcript when STT hangs',async()=>{
  init();const run=vi.fn((_model:string)=>new Promise<never>(()=>{}));const pending=handleTurn(freshInput(),context({run}as unknown as Ai));const rejected=expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(3900);await rejected;expect(run.mock.calls.every(c=>(c[0] as string).includes('whisper'))).toBe(true);
 });
 it('never degrades across failed epoch validation',async()=>{
  init();const ai={run:vi.fn(()=>({text:'오늘 일정 몇 개야'}))}as unknown as Ai;
  await expect(handleTurn(freshInput(),{...context(ai),check:async()=>{throw new VoiceHttpError(403);}})).rejects.toMatchObject({status:403});
 });
 it('leaves silence semantics intact without Calendar or inference',async()=>{
  init();const bytes=wav();bytes.fill(0,44);const run=vi.fn(),readCalendar=vi.fn(async()=>cal);
  const result=await handleTurn({...input,audio:{data:bytesToBase64(bytes),mimeType:'audio/wav'}},{...context({run}as unknown as Ai),readCalendar});
  expect(result.transcript).toBe('');expect(result.sentences).toEqual([]);expect(run).not.toHaveBeenCalled();expect(readCalendar).not.toHaveBeenCalled();
 });
});

describe('post-reservation stage admission',()=>{
 it.each(['llm','tts'] as const)('does not start %s inference after a slow reservation consumes its headroom',async(stage)=>{
  init();const run=vi.fn((model:string)=>model.includes('whisper')?{text:stage==='llm'?'지원되지 않는 질문':'오늘 일정 몇 개야'}:model.includes('gpt-oss')?{response:JSON.stringify({tool:'calendar_today',sentence:'일정이 있어요.'})}:new Response(wav()));
  const pending=handleTurn(freshInput(),{...context({run}as unknown as Ai),hedge:{reserve:(s)=>s===stage?later(stage==='llm'?1800:3000,undefined):undefined}});
  await vi.advanceTimersByTimeAsync(3900);const result=await pending;
  expect(result.sentences).toEqual([failureSentences.question]);
  expect(run.mock.calls.some(c=>c[0].includes(stage==='llm'?'gpt-oss':'melotts'))).toBe(false);
 });
});

describe('late stages and final authorization',()=>{
 it('discards late LLM output without starting TTS after cached degradation',async()=>{
  init();const run=vi.fn((_model:string)=>({text:'지원되지 않는 질문'}));const provider={respond:()=>later(5000,{text:'늦은 응답.',toolCalls:[]})};
  const pending=handleTurn(freshInput(),{...context({run}as unknown as Ai),provider});
  await vi.advanceTimersByTimeAsync(3900);expect((await pending).sentences).toEqual([failureSentences.question]);
  await vi.advanceTimersByTimeAsync(5000);expect(run).toHaveBeenCalledOnce();
 });
 it('does not return a failure WAV across hung authorization checks',async()=>{
  init();const run=vi.fn((_model:string)=>({text:'오늘 일정 몇 개야'}));
  const pending=handleTurn(freshInput(),{...context({run}as unknown as Ai),check:()=>new Promise<never>(()=>{})});const rejected=expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(3900);await rejected;expect(run).toHaveBeenCalledOnce();
 });
 it('rejects a newly stale next answer instead of playing it after the event starts',async()=>{
  init();const start=new Date(Date.now()+100).toISOString(),end=new Date(Date.now()+60000).toISOString();
  const run=vi.fn((model:string)=>model.includes('whisper')?{text:'다음 일정 뭐야'}:later(500,new Response(wav())));
  const pending=handleTurn(freshInput(),{...context({run}as unknown as Ai),readCalendar:async()=>({...cal,events:[{id:'next',title:'회의',start:{dateTime:start},end:{dateTime:end}}]})});
  await vi.advanceTimersByTimeAsync(500);expect((await pending).sentences).toEqual([failureSentences.question]);
 });
});


describe('only deadline or admission-time failures degrade', () => {
 it.each(['calendar', 'llm', 'tts'] as const)('preserves a non-timeout %s failure after STT', async(stage) => {
  init();const failure=new VoiceHttpError(502);
  const run=vi.fn((model:string)=>model.includes('whisper')?{text:stage==='llm'?'지원되지 않는 질문':'오늘 일정 몇 개야'}:Promise.reject(failure));
  const ctx={...context({run}as unknown as Ai),...(stage==='calendar'?{readCalendar:async()=>{throw failure;}}:{}),...(stage==='llm'?{provider:{respond:async()=>{throw failure;}}}:{})};
  const rejected=expect(handleTurn(freshInput(),ctx)).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(650);await rejected;
 });
});


describe('Calendar lifetime beyond the question cutoff', () => {
 it('retains the full underlying Calendar read after returning deadline degradation', async () => {
  init();
  let finishRead!: (calendar: TodayCalendar) => void;
  const read = new Promise<TodayCalendar>(resolve => { finishRead = resolve; });
  const work: Promise<unknown>[] = [];
  const run = vi.fn(() => ({ text: '오늘 일정 몇 개야' }));
  const pending = handleTurn(freshInput(), { ...context({ run } as unknown as Ai), readCalendar: () => read,
   defer: promise => { work.push(promise); } });
  await vi.advanceTimersByTimeAsync(3900);
  expect((await pending).sentences).toEqual([failureSentences.question]);
  let lifetimeFinished = false;
  const lifetime = Promise.all(work).then(() => { lifetimeFinished = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(lifetimeFinished).toBe(false);
  finishRead(cal);
  await lifetime;
  expect(lifetimeFinished).toBe(true);
 });
});
