import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { codexTerminal } from '../src/codex-terminal.ts';
import { environmentConfig } from '../src/config.ts';

test('Codex uses the Desk session directory and SSH wrapper without Claude provider settings', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-desk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = { id: 'one', projectPath: "E:\\项目 O'Brien" };
  const launch = codexTerminal(
    root,
    session,
    { platform: 'win32', shells: ['pwsh'] },
    '/wrappers',
    {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'private',
      PROXY_TOKEN: 'private',
    },
  );
  assert.equal(launch.file, 'codex');
  assert.equal(launch.cwd, join(root, 'codex', 'one'));
  assert.ok(existsSync(launch.cwd));
  assert.equal(launch.env.PATH, ['/wrappers', '/bin'].join(delimiter));
  assert.equal('ANTHROPIC_API_KEY' in launch.env, false);
  assert.equal('PROXY_TOKEN' in launch.env, false);
  const prompt = launch.args.find((value) => value.startsWith('developer_instructions='))!;
  assert.match(JSON.parse(prompt.slice(prompt.indexOf('=') + 1)), /device-pwsh/);
  assert.ok(JSON.parse(prompt.slice(prompt.indexOf('=') + 1)).includes("O''Brien"));
});

test('the server default selects Codex for an unmodified upstream terminal client', () => {
  assert.equal(
    environmentConfig({ PROXY_TERMINAL_RUNTIME: 'codex' }, '/state').options.terminalRuntime,
    'codex',
  );
  assert.equal(environmentConfig({}, '/state').options.terminalRuntime, undefined);
});

test('Codex terminal applies the same named presets as a structured chat', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cxdt-presets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = [
    [undefined, 'workspace-write', 'on-request', 'auto_review'],
    ['ask-for-approval', 'workspace-write', 'on-request', 'user'],
    ['approve-for-me', 'workspace-write', 'on-request', 'auto_review'],
    ['read-only', 'read-only', 'on-request', 'user'],
    ['full-access', 'danger-full-access', 'never', 'user'],
    ['untrusted', 'read-only', 'on-request', 'user'],
  ] as const;
  for (const [approval, sandbox, policy, reviewer] of cases) {
    const { args } = codexTerminal(
      root,
      { id: 'test', projectPath: 'C:/repo', codex: { approval } },
      { platform: 'win32', shells: ['pwsh'] },
      '/ssh',
      {},
      {},
    );
    assert.equal(args[args.indexOf('--sandbox') + 1], sandbox);
    assert.equal(args[args.indexOf('--ask-for-approval') + 1], policy);
    assert.ok(args.includes('approvals_reviewer=' + JSON.stringify(reviewer)));
  }
});
