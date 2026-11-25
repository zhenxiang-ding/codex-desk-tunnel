import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { codexTokensSchema, type CodexTokens, type EventPayload } from '@cc-desk-tunnel/protocol';
import type { codexTerminal } from './codex-terminal.ts';

type Runtime = Pick<ReturnType<typeof codexTerminal>, 'args' | 'file' | 'cwd' | 'env'> & {
  instructions?: string;
};
interface Item {
  type: string;
  id: string;
  text?: string;
  summary?: string[];
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  status?: string;
  changes?: unknown;
  tool?: string;
  server?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  results?: unknown;
  contentItems?: unknown;
  success?: boolean;
}
interface Chat {
  runtime: Runtime;
  thread?: string;
  message: string;
  messageId: string;
  signal: AbortSignal;
  bind: (id: string) => void;
  usage: (tokens: CodexTokens) => void;
  emit: (event: EventPayload) => void;
  approve: (id: string, reason: string) => Promise<boolean>;
}
const print = (value: unknown) =>
  (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).slice(0, 24000);

// One app-server per active turn. The durable Codex thread ID belongs to the Desk session.
export async function runCodexChat(chat: Chat): Promise<'completed' | 'cancelled'> {
  const { runtime, signal, emit } = chat;
  if (signal.aborted) return 'cancelled';
  const child = spawn(runtime.file, [...runtime.args, 'app-server'], {
    cwd: runtime.cwd,
    env: runtime.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  const write = (frame: unknown) => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded)
      child.stdin.write(JSON.stringify(frame) + '\n');
  };
  let config: {
    model?: string;
    model_reasoning_effort?: string;
    model_auto_compact_token_limit?: number;
  } = {};
  const pending = new Map<number, { method: string; timer: ReturnType<typeof setTimeout> }>();
  let seq = 0,
    thread = chat.thread,
    turn: string | undefined,
    failure: Error | undefined;
  const abortWith = (error: Error) => {
    failure = error;
    child.kill();
  };
  child.on('error', () => abortWith(new Error('无法启动 VPS 上的 Codex CLI。')));
  child.stdin.on('error', () => abortWith(new Error('Codex CLI 的连接已结束。')));
  const request = (method: string, params: unknown) => {
    const id = ++seq;
    pending.set(id, {
      method,
      timer: setTimeout(() => abortWith(new Error('Codex CLI 没有响应 ' + method)), 30000),
    });
    write({ id, method, params });
  };
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (thread && turn) {
      request('turn/interrupt', { threadId: thread, turnId: turn });
      stopTimer = setTimeout(() => child.kill(), 2000);
    } else child.kill();
  };
  signal.addEventListener('abort', stop, { once: true });
  const textIds = new Map<string, string>(),
    streamed = new Set<string>(),
    tools = new Set<string>();
  const text = (id: string, type: 'thinking.delta' | 'text.delta', value?: string) => {
    if (!value) return;
    if (!textIds.has(id)) textIds.set(id, randomUUID());
    for (let i = 0; i < value.length; i += 8192)
      emit({ type, messageId: textIds.get(id)!, text: value.slice(i, i + 8192) });
  };
  const tool = (id: string, name: string, input: unknown) => {
    if (tools.has(id)) return;
    tools.add(id);
    emit({ type: 'tool.requested', toolId: id, name, input: print(input), target: 'Linux' });
  };
  const item = (i: Item, done: boolean) => {
    if (i.type === 'agentMessage' || i.type === 'plan' || i.type === 'reasoning') {
      if (done && !streamed.has(i.id))
        text(
          i.id,
          i.type === 'reasoning' ? 'thinking.delta' : 'text.delta',
          i.type === 'reasoning' ? i.summary?.join('\n') : i.text,
        );
      return;
    }
    if (i.type === 'contextCompaction') {
      if (done) emit({ type: 'native.compact', trigger: 'auto', previousTokens: null });
      return;
    }
    const fields: Record<string, [string, unknown, unknown]> = {
      commandExecution: ['Shell', i.command, i.aggregatedOutput],
      fileChange: ['文件修改', i.changes, i.changes],
      mcpToolCall: [
        (i.server ?? 'MCP') + ' / ' + (i.tool ?? '工具'),
        i.arguments,
        i.error ?? i.result,
      ],
      dynamicToolCall: [i.tool ?? '工具', i.arguments, i.contentItems],
      webSearch: ['网页搜索', i.query, i.results],
    };
    const entry = fields[i.type];
    if (!entry) return;
    tool(i.id, entry[0], entry[1]);
    if (done)
      emit({
        type: 'tool.result',
        toolId: i.id,
        status:
          i.status === 'declined'
            ? 'denied'
            : i.status === 'failed' || i.success === false || i.error
              ? 'failed'
              : 'completed',
        exitCode: i.exitCode ?? null,
        output: print(entry[2]),
      });
  };
  request('initialize', {
    clientInfo: { name: 'codex_desk_tunnel', version: '1' },
    capabilities: {},
  });
  try {
    for await (const line of lines) {
      const frame = JSON.parse(line);
      if (frame.method && frame.id != null) {
        const p = frame.params ?? {};
        if (
          p.threadId === thread &&
          (!turn || !p.turnId || p.turnId === turn) &&
          ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(
            frame.method,
          )
        ) {
          const command = frame.method === 'item/commandExecution/requestApproval';
          tool(p.itemId, command ? 'Shell' : '文件修改', p.command ?? p.grantRoot ?? p.reason);
          const reason = print(
            [p.reason, p.command ?? p.grantRoot].filter(Boolean).join('\n'),
          ).slice(0, 4000);
          void chat
            .approve(p.itemId, reason)
            .then((ok) =>
              write({
                id: frame.id,
                result: { decision: ok && !signal.aborted ? 'accept' : 'decline' },
              }),
            )
            .catch(() => write({ id: frame.id, result: { decision: 'decline' } }));
        } else if (frame.method === 'item/permissions/requestApproval')
          write({ id: frame.id, result: { permissions: {}, scope: 'turn' } });
        else
          write({
            id: frame.id,
            error: { code: -32601, message: 'Unsupported interactive request' },
          });
        continue;
      }
      if (frame.id != null) {
        const sent = pending.get(frame.id);
        if (!sent) continue;
        clearTimeout(sent.timer);
        pending.delete(frame.id);
        if (frame.error)
          throw new Error(sent.method + ' 请求失败：' + print(frame.error.message).slice(0, 600));
        const result = frame.result;
        const open = () =>
          request(thread ? 'thread/resume' : 'thread/start', {
            ...(thread ? { threadId: thread, excludeTurns: true } : {}),
            cwd: runtime.cwd,
            developerInstructions: runtime.instructions,
            model: config.model ?? undefined,
            config: config.model_auto_compact_token_limit
              ? { model_auto_compact_token_limit: config.model_auto_compact_token_limit }
              : undefined,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
          });
        switch (sent.method) {
          case 'initialize':
            write({ method: 'initialized' });
            request('config/read', { includeLayers: false });
            break;
          case 'config/read':
            config = result.config;
            if (thread) open();
            else
              request('thread/list', {
                cwd: runtime.cwd,
                limit: 1,
                sourceKinds: ['cli', 'appServer', 'exec'],
                sortKey: 'updated_at',
              });
            break;
          case 'thread/list': {
            const prior = result.data.find((v: { cwd: string }) => v.cwd === runtime.cwd);
            thread = prior?.id;
            open();
            break;
          }
          case 'thread/start':
          case 'thread/resume':
            thread = result.thread.id;
            if (!thread || !/^[a-f0-9-]{36}$/i.test(thread))
              throw new Error('Codex 返回的会话 ID 无效。');
            chat.bind(thread);
            request('turn/start', {
              threadId: thread,
              effort: config.model_reasoning_effort ?? undefined,
              input: [{ type: 'text', text: chat.message }],
              clientUserMessageId: chat.messageId,
            });
            break;
          case 'turn/start':
            turn = result.turn.id;
            emit({ type: 'message.delivery', messageId: chat.messageId, status: 'received' });
            break;
        }
        continue;
      }
      const p = frame.params;
      if (!p || !thread || p.threadId !== thread || (turn && p.turnId && p.turnId !== turn))
        continue;
      switch (frame.method) {
        case 'turn/started':
          turn = p.turn.id;
          break;
        case 'item/started':
        case 'item/completed':
          item(p.item, frame.method === 'item/completed');
          break;
        case 'item/agentMessage/delta':
        case 'item/plan/delta':
        case 'item/reasoning/summaryTextDelta':
          streamed.add(p.itemId);
          text(
            p.itemId,
            frame.method.includes('reasoning') ? 'thinking.delta' : 'text.delta',
            p.delta,
          );
          break;
        case 'item/commandExecution/outputDelta':
          for (let i = 0; i < p.delta.length; i += 8192)
            emit({
              type: 'tool.output',
              toolId: p.itemId,
              stream: 'stdout',
              text: p.delta.slice(i, i + 8192),
            });
          break;
        case 'thread/tokenUsage/updated': {
          const value = codexTokensSchema.safeParse(p.tokenUsage?.total);
          if (value.success) {
            chat.usage(value.data);
            const last = codexTokensSchema.safeParse(p.tokenUsage.last);
            if (last.success)
              emit({
                type: 'codex.usage',
                total: value.data,
                last: last.data,
                window: p.tokenUsage.modelContextWindow ?? null,
              });
          }
          break;
        }
        case 'turn/completed':
          if (turn && p.turn.id !== turn) break;
          if (signal.aborted || p.turn.status === 'interrupted') return 'cancelled';
          if (p.turn.status !== 'completed')
            throw new Error(
              print(p.turn.error?.message || 'Codex 未能完成本轮对话。').slice(0, 600),
            );
          return 'completed';
      }
    }
    if (signal.aborted) return 'cancelled';
    throw failure ?? new Error('Codex 在本轮完成前断开了连接。');
  } finally {
    signal.removeEventListener('abort', stop);
    clearTimeout(stopTimer);
    for (const sent of pending.values()) clearTimeout(sent.timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
