import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { once, EventEmitter } from 'node:events';
import { serverMessageSchema } from '@cc-desk-tunnel/protocol';
import { CodexAccount } from '../src/codex-account.ts';

// Exercise the wire protocol over a real pair of pipes without starting an OAuth grant.
function fixture(mode = 'pending') {
  const events = new EventEmitter();
  const account = new CodexAccount(
    (notice) => events.emit('change', notice),
    () =>
      spawn(process.execPath, ['--input-type=module', '-e', SCRIPT, mode], {
        stdio: ['pipe', 'pipe', 'ignore'],
      }),
  );
  return { account, events };
}
const SCRIPT = `
import { createInterface } from 'node:readline';
let authorized = process.argv[1] === 'authorized';
const send = (message) => console.log(JSON.stringify(message));
createInterface({ input: process.stdin }).on('line', (line) => {
  const {method, id, params} = JSON.parse(line);
  if (method === 'initialized') return;
  let result = {};
  if (method === 'account/read') result = {account: authorized ? {type:'chatgpt',email:'test@example.com',planType:'plus'} : null};
  else if (method === 'config/read') result={config:{model_provider:null}};
  else if (method === 'account/rateLimits/read') result = {rateLimits:{primary:{usedPercent:12,windowDurationMins:300,resetsAt:123456},secondary:null}};
  else if (method === 'account/login/start' && params.type === 'chatgptDeviceCode') {
    result = {type:params.type,loginId:'fixture-id',userCode:'TEST-CODE',verificationUrl:process.argv[1] === 'invalid' ? 'https://example.org/' : 'https://auth.openai.com/codex/device'};
    if (process.argv[1] === 'complete') {
      authorized = true;
      send({id,result});
      send({method:'account/login/completed',params:{loginId:result.loginId,success:true}});
      return;
    }
  } else if (method === 'account/logout') authorized = false;
  else if (method !== 'initialize') return send({id,error:{message:'unexpected method'}});
  send({id,result});
});`;

test('only the initiating desktop receives the device code or can cancel its flow', async (t) => {
  const { account } = fixture();
  t.after(() => account.stop());
  const owner = {},
    other = {};
  await account.begin(owner);
  account.cancel(other);
  assert.equal((await account.state(owner)).login?.deviceCode, 'TEST-CODE');
  assert.equal((await account.state(other)).login, null);
  assert.equal((await account.state()).login, null);
  await assert.rejects(account.begin(other));
  account.cancel(owner);
  assert.equal((await account.state(owner)).login, null);
});
test('completion clears the challenge and refreshes the CLI account and limits', async (t) => {
  const { account, events } = fixture('complete');
  t.after(() => account.stop());
  const changed = once(events, 'change');
  const owner = {};
  await account.begin(owner);
  await changed;
  const state = await account.state(owner, true);
  assert.equal(state.codexProvider, undefined);
  for (const provider of [undefined, null, 'openai'])
    assert.ok(
      serverMessageSchema.safeParse({ type: 'account.state', ...state, codexProvider: provider })
        .success,
    );
  assert.equal(state.email, 'test@example.com');
  assert.equal(state.login, null);
  assert.equal(state.codexLimits?.primary?.usedPercent, 12);
});
test('logout uses the CLI and unexpected verification sites are rejected', async (t) => {
  const signed = fixture('authorized').account,
    invalid = fixture('invalid').account;
  t.after(() => {
    signed.stop();
    invalid.stop();
  });
  assert.equal((await signed.state()).loggedIn, true);
  await signed.logout();
  assert.equal((await signed.state()).loggedIn, false);
  await assert.rejects(invalid.begin({}));
  assert.equal((await invalid.state()).login, null);
});
