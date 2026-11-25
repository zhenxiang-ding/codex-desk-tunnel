import { CodexAccount } from '../src/codex-account.ts';
import { runCodexChat } from '../src/codex-chat.ts';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
// Set CODEX_CLI_TEST_BIN to the pinned CLI executable. All model traffic goes to the loopback fixture.
test(
  'official Codex CLI config, structured replies, token usage and durable resume',
  { skip: !process.env.CODEX_CLI_TEST_BIN, timeout: 100000 },
  async (t) => {
    const cli = resolve(process.env.CODEX_CLI_TEST_BIN),
      root = mkdtempSync(join(tmpdir(), 'cxdt-real-cli-')),
      cwd = join(root, 'work');
    mkdirSync(cwd);
    t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
    const env = {
      SystemRoot: process.env.SystemRoot,
      PATH: process.env.PATH,
      TEMP: root,
      TMP: root,
      USERPROFILE: root,
      HOME: root,
      CODEX_HOME: root,
      NO_PROXY: '127.0.0.1,localhost',
      LOCALAPPDATA: root,
      APPDATA: root,
    };
    const acc = new CodexAccount(
      () => {},
      () => spawn(cli, ['--no-daemon', 'app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] }),
    );
    try {
      const catalog = await acc.models();
      assert.ok(catalog.length > 0 && catalog.some((m) => m.supportedReasoningEfforts.length));
      await acc.configuration({
        'features.memories': true,
        tool_output_token_limit: 5000,
        model_reasoning_summary: 'concise',
        model_auto_compact_token_limit: 43210,
        model: 'gpt-test',
        model_reasoning_effort: 'low',
      });
      const settings = await acc.configuration();
      assert.equal(settings.model_auto_compact_token_limit, 43210);
      assert.equal(settings['features.memories'], true);
      assert.equal(settings.tool_output_token_limit, 5000);
      assert.equal(settings.model_reasoning_summary, 'concise');
      // Keep background memory jobs out of the subsequent two-response chat fixture.
      const reset = await acc.configuration({
        'features.memories': null,
        model_reasoning_summary: null,
      });
      assert.notEqual(reset['features.memories'], true);
      assert.equal(reset.tool_output_token_limit, 5000);
      assert.equal(
        (await acc.configuration({ model_auto_compact_token_limit: null }))
          .model_auto_compact_token_limit,
        null,
      );
    } finally {
      acc.stop();
    }
    let requests = 0;
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
      }
      if (!req.url.endsWith('/responses')) {
        res.writeHead(404);
        res.end();
        return;
      }
      requests++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const response = {
        id: 'resp_' + requests,
        object: 'response',
        model: 'gpt-test',
        created_at: 1,
        status: 'in_progress',
        output: [],
      };
      const item = {
        id: 'msg_' + requests,
        type: 'message',
        role: 'assistant',
        content: [],
        status: 'in_progress',
      };
      const out = (type, data) =>
        res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
      out('response.created', { response });
      out('response.output_item.added', { output_index: 0, item });
      const msg = 'structured response ' + requests;
      out('response.output_text.delta', {
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: msg,
      });
      item.content = [{ type: 'output_text', text: msg }];
      item.status = 'completed';
      out('response.output_item.done', { output_index: 0, item });
      out('response.completed', {
        response: {
          ...response,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        },
      });
      res.end();
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      const args = [
        '--no-daemon',
        '-c',
        'model_provider="fixture"',
        '-c',
        'model_providers.fixture.name="Fixture"',
        '-c',
        'model_providers.fixture.wire_api="responses"',
        '-c',
        'model_providers.fixture.base_url="http://127.0.0.1:' + server.address().port + '/v1"',
      ];
      let thread, usage;
      for (let i = 1; i <= 2; i++) {
        const events = [];
        const saved = thread;
        const result = await runCodexChat({
          runtime: { cwd, env, file: cli, args },
          thread,
          message: 'fixture turn ' + i,
          messageId: randomUUID(),
          signal: AbortSignal.timeout(40000),
          bind: (id) => {
            thread = id;
          },
          usage: (t) => {
            usage = t;
          },
          approve: async () => false,
          emit: (e) => events.push(e),
        });
        assert.equal(result, 'completed');
        if (saved) assert.equal(thread, saved);
        assert.match(
          events
            .filter((e) => e.type === 'text.delta')
            .map((e) => e.text)
            .join(''),
          new RegExp('structured response ' + i),
        );
      }
      assert.ok(usage?.totalTokens > 0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  },
);
