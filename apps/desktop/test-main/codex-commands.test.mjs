import test from 'node:test';
import assert from 'node:assert/strict';
import { codexCommands, codexCommandPrefix, parseCodexCommand } from '../src/codex-commands.ts';
test('Codex command aliases, model-specific tiers and native command arguments', () => {
  const tiers = [{ name: 'Fast', description: 'Priority inference' }];
  assert.equal(codexCommands('fas', tiers)[0].name, 'fast');
  assert.deepEqual(codexCommands('fas', []), []);
  assert.equal(codexCommands('cwd')[0].name, 'pwd');
  for (const { name } of codexCommands('', tiers))
    assert.equal(parseCodexCommand('/' + name).name, name);
  assert.equal(parseCodexCommand('/remote on').args, 'on');
  assert.equal(parseCodexCommand('/mcp login Example').text, '/mcp login Example');
  assert.equal(codexCommandPrefix.test('/var/log'), false);
  assert.equal(codexCommandPrefix.test('/'), true);
  assert.equal(parseCodexCommand('/var/log'), null);
  assert.equal(parseCodexCommand('/review\nother'), null);
});
