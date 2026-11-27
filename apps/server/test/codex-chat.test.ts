import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/store.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { runCodexChat } from '../src/codex-chat.ts';
import { compactedCodexUsage, restoreCodexSessionInfo } from '../src/codex-session-info.ts';
import { UsageLog } from '../src/usage.ts';

const script = `
import {createInterface} from 'node:readline';
const thread='10000000-0000-4000-8000-000000000001',turn='test-turn';
const send=v=>console.log(JSON.stringify(v));
let resumed=false;
const note=(method,params)=>send({method,params:{threadId:thread,turnId:turn,...params}});
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params,result}=JSON.parse(line);
 if(id==='approval'){
   const allowed=result.decision==='accept';
   note('item/completed',{item:{id:'shell',type:'commandExecution',command:'ssh device hostname',status:allowed?'completed':'declined',aggregatedOutput:allowed?'test-device':'',exitCode:allowed?0:null}});
   note('item/agentMessage/delta',{itemId:'answer',delta:'你好'});
   note('item/completed',{item:{type:'agentMessage',id:'answer',text:'你好'}});
   note('thread/tokenUsage/updated',{tokenUsage:{modelContextWindow:10000,last:{inputTokens:8,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1,totalTokens:11},total:{inputTokens:8,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1,totalTokens:11}}});
   note('item/completed',{item:{id:'compact',type:'contextCompaction'}});
   const corrected={modelContextWindow:10000,last:{inputTokens:3,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:3},total:{inputTokens:8,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1,totalTokens:11}};
   note('thread/tokenUsage/updated',{tokenUsage:corrected});
   note('thread/tokenUsage/updated',{tokenUsage:corrected});
   note('turn/completed',{turn:{id:turn,status:'completed'}});return;
 }
 if(method==='initialized')return;
 if(method==='initialize')return send({id,result:{}});
 if(method==='thread/sample' && params.threadId===thread && params.expectedTurnId===turn)return send({id,result:{text:'检查设备名称',sourceTurnId:turn}});
 if(method==='config/read')return send({id,result:{config:{model:'fixture-model',model_reasoning_effort:'low',approvals_reviewer:'user'}}});
 if(method==='thread/list')return send({id,result:{data:[]}});
 if(method==='thread/start'||method==='thread/resume'){
   resumed=method==='thread/resume';
   if(params.config?.['features.memories']!==true)return process.exit(9);
   if(params.model!==(method==='thread/resume'?'second-model':'fixture-model')||params.approvalsReviewer!==(resumed?'user':'auto_review')||params.sandbox!=='workspace-write'||params.approvalPolicy!=='on-request'||(method==='thread/resume'&&params.threadId!==thread))return process.exit(7);
   return send({id,result:{thread:{id:thread,name:resumed?'原生会话标题':null}}});
 }
 if(method==='turn/start'){
  if(params.input[1]?.type!=='skill'||params.input[1].name!=='fixture-skill')return process.exit(6);
  if(params.effort!==(resumed?'high':'low'))return process.exit(8);
  if(params.serviceTierForTurn!==process.env.EXPECT_TIER)return process.exit(10);
  send({id,result:{turn:{id:turn}}});
  note('item/started',{item:{id:'shell',type:'commandExecution',command:'ssh device hostname'}});
  send({method:'item/commandExecution/requestApproval',id:'approval',params:{threadId:thread,turnId:turn,itemId:'shell',reason:'test approval',command:'ssh device hostname'}});
 }
 if(method==='turn/interrupt'){send({id,result:{}});note('turn/completed',{turn:{id:turn,status:'interrupted'}});}
});`;
function fixture(
  signal: AbortSignal,
  approve: () => Promise<boolean>,
  thread?: string,
  serviceTier?: string,
) {
  const events: EventPayload[] = [];
  let bound = '';
  const done = runCodexChat({
    runtime: {
      file: process.execPath,
      args: ['--input-type=module', '-e', script, '--'],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '',
        TERM: 'xterm-256color',
        ...(serviceTier && { EXPECT_TIER: serviceTier }),
      },
    },
    thread,
    generateTitle: true,
    choice: thread
      ? { model: 'second-model', effort: 'high', serviceTier }
      : { approval: 'approve-for-me', serviceTier },
    skills: [{ name: 'fixture-skill', path: '/tmp/fixture-skill/SKILL.md' }],
    message: 'test',
    messageId: randomUUID(),
    signal,
    emit: (e) => events.push(e),
    approve,
    usage: (u) => assert.equal(u.totalTokens, 11),
    bind: (id) => {
      bound = id;
    },
  });
  return { events, done, bound: () => bound };
}
test('structured Codex turns resume, keep tool decisions and deliver streamed text once', async () => {
  let thread: string | undefined;
  for (const allowed of [true, false]) {
    const chat = fixture(
      AbortSignal.timeout(5000),
      async () => allowed,
      thread,
      allowed ? 'priority' : 'default',
    );
    assert.equal(await chat.done, 'completed');
    thread = chat.bound();
    assert.ok(
      chat.events.some((e) => e.type === 'tool.requested' && e.input.includes('ssh device')),
    );
    assert.ok(
      chat.events.some(
        (e) => e.type === 'tool.result' && e.status === (allowed ? 'completed' : 'denied'),
      ),
    );
    assert.deepEqual(
      chat.events.filter((e) => e.type === 'text.delta').map((e) => e.text),
      ['你好'],
    );
    assert.ok(chat.events.some((e) => e.type === 'codex.usage' && e.total.totalTokens === 11));
    assert.deepEqual(
      chat.events.filter((e) => e.type === 'native.title').map((e) => e.title),
      [allowed ? '检查设备名称' : '原生会话标题'],
    );
    assert.deepEqual(
      chat.events
        .filter((e) => e.type === 'codex.usage')
        .map((e) => [e.last.totalTokens, !!e.contextOnly]),
      [
        [11, false],
        [3, true],
      ],
    );
  }
});

test('restore the real post-compaction count without billing a model request or moving the session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cxdt-compacted-'));
  const store = new SessionStore(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  new UsageLog(store.database, 35, 200000, true);
  const session = store.create(randomUUID(), '新会话', 'C:/work', {
    id: randomUUID(),
    name: 'test',
  });
  const make = (n: number) => ({
    input_tokens: n,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: n,
  });
  const count = (last: number) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: make(last),
          total_token_usage: make(4303442),
          model_context_window: 258400,
        },
      },
    });
  const file = join(dir, 'rollout.jsonl');
  writeFileSync(file, [count(108203), '{"type":"compacted"}', count(22836)].join('\n'));
  const recovered = await compactedCodexUsage(file);
  assert.ok(recovered);
  assert.equal(recovered.last.totalTokens, 22836);
  store.append(session.id, randomUUID(), { type: 'codex.usage', contextOnly: true, ...recovered });
  assert.equal(store.lastCodexEvent(session.id, 'codex.usage')?.payload.type, 'codex.usage');
  assert.equal(store.get(session.id).session.updatedAt, session.updatedAt);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM api_requests').get()?.n, 0);
  assert.deepEqual(store.recentCodexUsage(), []);
  const run = randomUUID(),
    thread = randomUUID();
  store.bindCodexThread(session.id, thread);
  store.append(session.id, run, {
    type: 'message.user',
    messageId: randomUUID(),
    text: '帮我找出压缩后的上下文为什么没有更新。',
    scenario: 'chat',
  });
  store.append(session.id, run, {
    type: 'codex.usage',
    threadId: thread,
    ...recovered,
    last: { ...recovered.last, totalTokens: 108203 },
  });
  store.append(session.id, run, {
    type: 'native.compact',
    trigger: 'manual',
    previousTokens: null,
  });
  const before = store.get(session.id).session.updatedAt;
  let summaries = 0;
  const account = {
    threadInfo: async (id: string) => ({ id, path: file }),
    summarizeThread: async () => {
      summaries++;
      return '修复压缩后的上下文圆环';
    },
  };
  const repair = () =>
    restoreCodexSessionInfo(
      store,
      account,
      () => {},
      (...args) => store.append(...args),
      () => false,
    );
  await repair();
  await repair();
  assert.equal(summaries, 1);
  assert.equal(store.get(session.id).session.title, '修复压缩后的上下文圆环');
  assert.equal(store.get(session.id).session.updatedAt, before);
  const last = store.lastCodexEvent(session.id, 'codex.usage')!.payload;
  assert.ok(last.type === 'codex.usage' && last.contextOnly && last.last.totalTokens === 22836);
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM api_requests').get()?.n, 1);
  store.rename(session.id, '我的标题');
  await repair();
  assert.equal(store.get(session.id).session.title, '我的标题');
  writeFileSync(file, [count(108203), '{"type":"compacted"}'].join('\n'));
  assert.equal(await compactedCodexUsage(file), undefined);
});
test('stop interrupts an active Codex turn waiting on a tool decision', async () => {
  const controller = new AbortController();
  const chat = fixture(controller.signal, () => {
    controller.abort();
    return new Promise(() => {});
  });
  assert.equal(await chat.done, 'cancelled');
});

test('Codex thread bindings and cumulative usage survive restart without counting repeated reports twice', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cxdt-usage-'));
  let store = new SessionStore(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const device = { id: randomUUID(), name: 'fixture' };
  const first = store.create(randomUUID(), 'First', 'C:/fixture', device);
  const second = store.create(randomUUID(), 'Second', 'C:/fixture', device);
  const id = randomUUID();
  store.bindCodexThread(first.id, id);
  const tokens = {
    inputTokens: 8,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningOutputTokens: 1,
    totalTokens: 11,
  };
  store.configure(first.id, first.permissionMode, undefined, undefined, {
    model: 'm',
    effort: 'high',
    serviceTier: 'priority',
  });
  store.configure(first.id, first.permissionMode, undefined, undefined, { approval: 'on-request' });
  store.codexUsage(first.id, tokens);
  store.bindCodexThread(first.id, id);
  store.codexUsage(first.id, tokens);
  store.bindCodexThread(second.id, randomUUID());
  store.close();
  store = new SessionStore(root);
  assert.deepEqual(store.get(first.id).session.codex, {
    model: 'm',
    effort: 'high',
    approval: 'on-request',
    serviceTier: 'priority',
  });
  assert.equal(store.codexThread(first.id), id);
  assert.deepEqual(store.codexUsageSummary(), { sessions: 1, totals: tokens });
});
