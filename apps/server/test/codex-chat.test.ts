import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/store.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { runCodexChat } from '../src/codex-chat.ts';

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
   note('turn/completed',{turn:{id:turn,status:'completed'}});return;
 }
 if(method==='initialized')return;
 if(method==='initialize')return send({id,result:{}});
 if(method==='config/read')return send({id,result:{config:{model:'fixture-model',model_reasoning_effort:'low'}}});
 if(method==='thread/list')return send({id,result:{data:[]}});
 if(method==='thread/start'||method==='thread/resume'){
   resumed=method==='thread/resume';
   if(params.model!==(method==='thread/resume'?'second-model':'fixture-model')||params.approvalsReviewer!==(method==='thread/resume'?'auto_review':'user')||params.sandbox!=='workspace-write'||params.approvalPolicy!=='on-request'||(method==='thread/resume'&&params.threadId!==thread))return process.exit(7);
   return send({id,result:{thread:{id:thread}}});
 }
 if(method==='turn/start'){
  if(params.effort!==(resumed?'high':'low'))return process.exit(8);
  send({id,result:{turn:{id:turn}}});
  note('item/started',{item:{id:'shell',type:'commandExecution',command:'ssh device hostname'}});
  send({method:'item/commandExecution/requestApproval',id:'approval',params:{threadId:thread,turnId:turn,itemId:'shell',reason:'test approval',command:'ssh device hostname'}});
 }
 if(method==='turn/interrupt'){send({id,result:{}});note('turn/completed',{turn:{id:turn,status:'interrupted'}});}
});`;
function fixture(signal: AbortSignal, approve: () => Promise<boolean>, thread?: string) {
  const events: EventPayload[] = [];
  let bound = '';
  const done = runCodexChat({
    runtime: {
      file: process.execPath,
      args: ['--input-type=module', '-e', script, '--'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' },
    },
    thread,
    choice: thread ? { model: 'second-model', effort: 'high', approval: 'auto_review' } : undefined,
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
    const chat = fixture(AbortSignal.timeout(5000), async () => allowed, thread);
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
  }
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
  });
  assert.equal(store.codexThread(first.id), id);
  assert.deepEqual(store.codexUsageSummary(), { sessions: 1, totals: tokens });
});
