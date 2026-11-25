import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';

test('the embedded Codex terminal relays keys, acknowledges rendered output and closes its own PTY', async ({
  page,
}) => {
  const sessionId = randomUUID();
  const terminalId = randomUUID();
  const calls: {
    type: string;
    data?: string;
    bytes?: number;
    terminalId?: string;
    runtime?: string;
  }[] = [];
  await page.routeWebSocket('**/codex-terminal-test', (socket) => {
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      calls.push(frame);
      const send = (message: object) => socket.send(JSON.stringify(message));
      if (frame.type === 'auth')
        return send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.1.0',
          connectionId: randomUUID(),
          sessions: [],
          projects: [],
          adapter: 'simulation',
        });
      if (frame.type === 'terminal.open') {
        send({ type: 'terminal.opened', sessionId, terminalId });
        send({ type: 'terminal.data', sessionId, terminalId, data: '就绪', bytes: 6 });
      }
      if (frame.requestId)
        send({ type: 'response', ok: true, requestId: frame.requestId, sessionId });
    });
  });
  await page.goto('/');
  await page.evaluate(async (id) => {
    const componentPath = '/src/CodexTerminal.tsx';
    const clientPath = '/src/client.ts';
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { default: CodexTerminal } = await import(componentPath);
    const { ProxyClient } = await import(clientPath);
    const client = new ProxyClient();
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const unsubscribe = client.subscribe(() => {
      if (client.state.status !== 'connected') return;
      unsubscribe();
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(CodexTerminal, {
            client,
            session: { id, title: '测试' },
            close: () => root.unmount(),
          }),
        ),
      );
    });
    client.connect(
      'ws://127.0.0.1:15173/codex-terminal-test',
      'offline-test-token-123456789',
      { id: crypto.randomUUID(), name: 'windows' },
      false,
    );
  }, sessionId);
  await expect
    .poll(() => calls.filter((f) => f.type === 'terminal.ack').map((f) => f.bytes))
    .toEqual([6]);
  expect(calls.filter((f) => f.type === 'terminal.open').map((f) => f.runtime)).toEqual(['codex']);
  await page.keyboard.type('hello');
  await page.keyboard.press('Escape');
  await expect
    .poll(() =>
      calls
        .filter((f) => f.type === 'terminal.input')
        .map((f) => f.data)
        .join(''),
    )
    .toBe('hello\x1b');
  await page.getByRole('dialog').getByRole('button', { name: '关闭' }).click();
  await expect
    .poll(() => calls.filter((f) => f.type === 'terminal.close').map((f) => f.terminalId))
    .toEqual([terminalId]);
});
