import { configuredPermissions, memoryPreference } from './codex-account.ts';
import { codexTitle, compactedCodexUsage, titlePrompt } from './codex-session-info.ts';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  codexTokensSchema,
  resolveCodexPermissions,
  type CodexConfig,
  type CodexChoice,
  type CodexTokens,
  type EventPayload,
} from '@cc-desk-tunnel/protocol';
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
  path?: string;
  prompt?: string;
  agentsStates?: unknown;
  success?: boolean;
}
interface Chat {
  runtime: Runtime;
  compact?: boolean;
  generateTitle?: boolean;
  previousReading?: Extract<EventPayload, { type: 'codex.usage' }>;
  choice?: CodexChoice;
  thread?: string;
  message: string;
  skills?: { name: string; path: string }[];
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
  let config: Partial<CodexConfig> & { features?: { memories?: boolean } } = {};
  let model: string | undefined;
  let memoryDefault = false;
  // Time observed on the VPS between usage events, excluding tool execution and approval waits.
  let startedAt: number | null = null,
    elapsed = 0,
    firstText: number | undefined;
  let previousTotal: number | undefined,
    previousContext: number | undefined,
    previousWindow: number | null | undefined;
  let rolloutPath: string | undefined,
    sawCompact = false,
    contextAfterCompact = false;
  let title = '',
    completed = false;
  function publishTitle(raw: unknown) {
    const next = codexTitle(raw);
    if (next && next !== title) {
      title = next;
      emit({ type: 'native.title', title });
    }
  }
  const runningTools = new Set<string>();
  const activeMs = () => elapsed + (startedAt === null ? 0 : performance.now() - startedAt);

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
      timer: setTimeout(
        () => abortWith(new Error('Codex CLI 没有响应 ' + method)),
        method === 'thread/sample' ? 12000 : 30000,
      ),
    });
    write({ id, method, params });
  };
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (completed) {
      child.kill();
      return;
    }
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
      if (done) {
        sawCompact = true;
        contextAfterCompact = false;
        emit({
          type: 'native.compact',
          trigger: chat.compact ? 'manual' : 'auto',
          previousTokens: null,
        });
      }
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
      imageView: ['查看图片', i.path, i.path],
      imageGeneration: ['生成图片', i.prompt, i.status],
      collabAgentToolCall: ['子代理 · ' + (i.tool ?? '任务'), i.prompt, i.agentsStates],
    };
    const entry = fields[i.type];
    if (!entry) return;
    if (!done && !runningTools.size) {
      elapsed = activeMs();
      startedAt = null;
    }
    if (!done) runningTools.add(i.id);
    if (done && runningTools.delete(i.id) && !runningTools.size) startedAt = performance.now();
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
    capabilities: { experimentalApi: !!chat.generateTitle },
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
        if (sent.method === 'thread/sample') {
          if (!frame.error && frame.result?.sourceTurnId === turn) publishTitle(frame.result.text);
          return 'completed';
        }
        if (frame.error)
          throw new Error(sent.method + ' 请求失败：' + print(frame.error.message).slice(0, 600));
        const result = frame.result;
        const open = () => {
          const permissions = resolveCodexPermissions(config, chat.choice?.approval);
          request(thread ? 'thread/resume' : 'thread/start', {
            ...(thread ? { threadId: thread, excludeTurns: true } : {}),
            cwd: runtime.cwd,
            developerInstructions: runtime.instructions,
            model: chat.choice?.model ?? config.model ?? undefined,
            config: {
              ...(memoryDefault && { 'features.memories': true }),
              ...(config.model_auto_compact_token_limit && {
                model_auto_compact_token_limit: config.model_auto_compact_token_limit,
              }),
            },
            sandbox: permissions.sandbox_mode,
            approvalPolicy: permissions.approval_policy,
            approvalsReviewer: permissions.approvals_reviewer,
          });
        };
        switch (sent.method) {
          case 'initialize':
            write({ method: 'initialized' });
            request('config/read', { includeLayers: false });
            break;
          case 'config/read':
            config = configuredPermissions(result);
            memoryDefault = memoryPreference(result) === null;
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
            model = result.model ?? chat.choice?.model ?? config.model ?? undefined;
            thread = result.thread.id;
            if (!thread || !/^[a-f0-9-]{36}$/i.test(thread))
              throw new Error('Codex 返回的会话 ID 无效。');
            chat.bind(thread);
            rolloutPath = result.thread.path;
            publishTitle(result.thread.name);
            if (chat.previousReading?.threadId === thread) {
              previousTotal = chat.previousReading.total.totalTokens;
              previousContext = chat.previousReading.last.totalTokens;
              previousWindow = chat.previousReading.window;
            }
            if (chat.compact) {
              request('thread/compact/start', { threadId: thread });
              break;
            }
            startedAt = performance.now();
            request('turn/start', {
              threadId: thread,
              serviceTierForTurn: chat.choice?.serviceTier ?? undefined,
              effort:
                chat.choice?.effort ??
                (chat.choice?.model && chat.choice.model !== config.model
                  ? undefined
                  : config.model_reasoning_effort) ??
                undefined,
              input: [
                { type: 'text', text: chat.message },
                ...(chat.skills ?? []).map(({ name, path }) => ({ type: 'skill', name, path })),
              ],
              clientUserMessageId: chat.messageId,
            });
            break;
          case 'thread/compact/start':
            emit({ type: 'message.delivery', messageId: chat.messageId, status: 'received' });
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
        case 'thread/name/updated':
          publishTitle(p.threadName);
          break;
        case 'turn/started':
          startedAt ??= performance.now();
          turn = p.turn.id;
          break;
        case 'item/started':
        case 'item/completed':
          item(p.item, frame.method === 'item/completed');
          break;
        case 'item/agentMessage/delta':
        case 'item/plan/delta':
        case 'item/reasoning/summaryTextDelta':
          if (p.delta && startedAt !== null) firstText ??= Math.round(activeMs());
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
        case 'model/rerouted':
          if (typeof p.toModel === 'string') model = p.toModel;
          break;
        case 'thread/tokenUsage/updated': {
          const value = codexTokensSchema.safeParse(p.tokenUsage?.total);
          if (value.success) {
            chat.usage(value.data);
            const last = codexTokensSchema.safeParse(p.tokenUsage.last);
            const window = p.tokenUsage.modelContextWindow ?? null;
            const contextOnly = previousTotal === value.data.totalTokens;
            if (
              last.success &&
              (!contextOnly ||
                (sawCompact && !contextAfterCompact) ||
                previousContext !== last.data.totalTokens ||
                previousWindow !== window)
            ) {
              emit({
                type: 'codex.usage',
                ...(contextOnly
                  ? { contextOnly: true as const }
                  : {
                      promptId: chat.messageId,
                      durationMs: Math.round(activeMs()),
                      ttftMs: firstText,
                    }),
                model,
                threadId: thread,
                total: value.data,
                last: last.data,
                window,
              });
              previousTotal = value.data.totalTokens;
              previousContext = last.data.totalTokens;
              previousWindow = window;
              if (sawCompact) contextAfterCompact = true;
              if (!contextOnly) {
                elapsed = 0;
                firstText = undefined;
                startedAt = runningTools.size ? null : performance.now();
              }
            }
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
          completed = true;
          if (sawCompact && !contextAfterCompact) {
            const reading = await compactedCodexUsage(rolloutPath);
            if (
              reading &&
              (previousTotal === undefined || reading.total.totalTokens === previousTotal)
            )
              emit({ type: 'codex.usage', threadId: thread, model, contextOnly: true, ...reading });
          }
          if (chat.generateTitle && !chat.compact && !title && !signal.aborted) {
            turn = p.turn.id;
            request('thread/sample', {
              threadId: thread,
              expectedTurnId: turn,
              disableMcp: true,
              prompt: titlePrompt,
            });
            break;
          }
          return 'completed';
      }
    }
    if (completed) return 'completed';
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
