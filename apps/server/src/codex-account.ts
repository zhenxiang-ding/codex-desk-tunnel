import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { titlePrompt } from './codex-session-info.ts';
import type { Readable, Writable } from 'node:stream';
import {
  codexModelSchema,
  type CodexModel,
  codexConfigSchema,
  type CodexConfig,
  type AccountState,
} from '@cc-desk-tunnel/protocol';

type Process = ChildProcessByStdio<Writable, Readable, null>;
type Limits = NonNullable<AccountState['codexLimits']>;
type LimitBucket = Limits & { limitId?: string | null };
export function subscriptionLimits(response: {
  rateLimits?: LimitBucket;
  rateLimitsByLimitId?: Record<string, LimitBucket> | null;
}): Limits | undefined {
  const main = response.rateLimitsByLimitId?.codex;
  const legacy = response.rateLimits;
  const windows = [main, legacy?.limitId && legacy.limitId !== 'codex' ? undefined : legacy]
    .flatMap((bucket) => [bucket?.primary, bucket?.secondary])
    .filter((w) => !!w);
  if (!windows.length) return undefined;
  const primary = windows.find((w) => w.windowDurationMins === 300) ?? windows[0];
  const secondary = windows.find(
    (w) => w !== primary && w.windowDurationMins !== primary.windowDurationMins,
  );
  return { primary, secondary };
}
// config/read materializes the CLI's built-in false even for an empty profile.
export function memoryPreference(read: {
  config: { features?: { memories?: boolean } };
  origins?: Record<string, unknown>;
}) {
  if (
    read.origins &&
    !Object.hasOwn(read.origins, 'features.memories') &&
    !Object.hasOwn(read.origins, 'features')
  )
    return null;
  return read.config.features?.memories ?? null;
}
// The CLI also returns built-in defaults. Only user/project/managed overrides should
// take precedence over Desk Tunnel's default permission preset.
export function configuredPermissions(read: {
  config: Partial<CodexConfig>;
  origins?: Record<string, unknown>;
}) {
  const { config, origins } = read;
  const keys = ['sandbox_mode', 'approval_policy', 'approvals_reviewer'] as const;
  if (
    !origins ||
    Object.hasOwn(origins, 'permissions') ||
    Object.hasOwn(origins, 'default_permissions')
  )
    return config;
  const explicit = { ...config };
  for (const key of keys) {
    if (!Object.hasOwn(origins, key)) explicit[key] = null;
  }
  return explicit;
}
type Challenge = { loginId: string; url: string; deviceCode: string };

type Flow = {
  owner: object;
  challenge?: Challenge;
  completed?: { loginId: string; success: boolean };
};

// Only account RPCs are issued on this private stdio connection. The CLI owns credential storage.
export class CodexAccount {
  private child?: Process;
  private ready?: Promise<unknown>;
  private sequence = 0;
  private pending = new Map<number, (value: unknown, error?: Error) => void>();
  private login?: Flow;
  private changed: (notice?: string) => void;
  private launch: () => Process;
  constructor(
    changed: (notice?: string) => void,
    launch: () => Process = () =>
      spawn('codex', ['--no-daemon', 'app-server'], { stdio: ['pipe', 'pipe', 'ignore'] }),
  ) {
    this.changed = changed;
    this.launch = launch;
  }

  private start() {
    if (this.ready) return this.ready;
    const child = this.launch();
    this.child = child;
    const lost = () => {
      if (this.child !== child) return;
      const active = !!this.login;
      this.child = this.ready = this.login = undefined;
      for (const finish of this.pending.values()) finish(null, new Error('Codex CLI 连接已结束。'));
      if (active) this.changed('设备登录已结束，请重新登录。');
    };
    child.on('error', lost);
    child.on('close', lost);
    child.stdin.on('error', lost);
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child !== child) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (typeof msg.id === 'number' && !msg.method) {
        this.pending.get(msg.id)?.(
          msg.result,
          msg.error ? new Error('Codex CLI 未能完成此请求。') : undefined,
        );
      } else if (
        msg.method === 'account/login/completed' &&
        this.login &&
        typeof msg.params?.loginId === 'string'
      ) {
        const { loginId, success } = msg.params;
        if (!this.login.challenge) this.login.completed = { loginId, success: success === true };
        else if (this.login.challenge.loginId === loginId) this.complete(success === true);
      }
    });
    this.ready = this.rpc('initialize', {
      clientInfo: { name: 'codex_desk_tunnel', version: '1' },
      capabilities: { experimentalApi: true },
    })
      .then(() => child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'))
      .catch((error) => {
        if (this.child === child) this.stop();
        throw error;
      });
    return this.ready;
  }
  private complete(success: boolean) {
    this.login = undefined;
    this.changed(success ? undefined : '设备授权未完成或已过期，请重新登录。');
  }

  private rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(null, new Error('Codex CLI 请求超时。')), 30_000);
      const finish = (value: unknown, error?: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value as T);
      };
      this.pending.set(id, finish);
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async threadInfo(threadId: string) {
    await this.start();
    const { thread } = await this.rpc<{
      thread: { id: string; name?: string; preview?: string; path?: string };
    }>('thread/read', { threadId, includeTurns: false });
    return thread.id === threadId ? thread : undefined;
  }
  async summarizeThread(threadId: string) {
    await this.start();
    await this.rpc('thread/resume', { threadId, excludeTurns: true });
    try {
      const { data } = await this.rpc<{ data: { id: string; status: string }[] }>(
        'thread/turns/list',
        {
          threadId,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        },
      );
      const turn = data[0];
      if (turn?.status !== 'completed') return;
      const result = await this.rpc<{ text: string | null; sourceTurnId: string }>(
        'thread/sample',
        {
          threadId,
          expectedTurnId: turn.id,
          disableMcp: true,
          prompt: titlePrompt,
        },
      );
      return result.sourceTurnId === turn.id ? result.text : undefined;
    } finally {
      await this.rpc('thread/unsubscribe', { threadId }).catch(() => {});
    }
  }
  async skills(cwd: string) {
    await this.start();
    const result = await this.rpc<{
      data: {
        skills: {
          name: string;
          path: string;
          enabled: boolean;
          description: string;
          shortDescription?: string | null;
        }[];
      }[];
    }>('skills/list', { cwds: [cwd] });
    return result.data.flatMap((entry) =>
      entry.skills
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          name: skill.name,
          path: skill.path,
          description: skill.shortDescription || skill.description,
        })),
    );
  }
  async models(): Promise<CodexModel[]> {
    await this.start();
    const models: CodexModel[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: unknown[]; nextCursor: string | null } = await this.rpc<{
        data: unknown[];
        nextCursor: string | null;
      }>('model/list', { cursor, limit: 100, includeHidden: false });
      for (const raw of page.data) {
        const parsed = codexModelSchema.safeParse(raw);
        if (parsed.success && !models.some((row) => row.model === parsed.data.model))
          models.push(parsed.data);
      }
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('模型列表分页重复。');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return models;
  }
  async configuration(edits?: Partial<CodexConfig>): Promise<CodexConfig> {
    await this.start();
    if (edits && Object.keys(edits).length)
      await this.rpc('config/batchWrite', {
        edits: Object.entries(codexConfigSchema.partial().parse(edits)).map(([keyPath, value]) => ({
          keyPath,
          value,
          mergeStrategy: 'replace',
        })),
        reloadUserConfig: true,
      });
    const read = await this.rpc<{
      config: Partial<CodexConfig> & { features?: { memories?: boolean } };
      origins?: Record<string, unknown>;
    }>('config/read', {
      includeLayers: false,
    });
    const config = configuredPermissions(read);
    const flat: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(codexConfigSchema.shape)) {
      const value = key
        .split('.')
        .reduce<unknown>(
          (obj, k) => (obj && typeof obj === 'object' ? Reflect.get(obj, k) : null),
          config,
        );
      const normalized = schema.safeParse(value ?? null);
      flat[key] = normalized.success ? normalized.data : null;
    }
    return codexConfigSchema.parse({
      ...flat,
      'features.memories': memoryPreference(read),
      model: config.model ?? null,
      model_reasoning_effort: config.model_reasoning_effort ?? null,
      model_auto_compact_token_limit: config.model_auto_compact_token_limit ?? null,
    });
  }
  private quotaRead?: { key: string; time: number; result: Promise<Limits | undefined> };
  async state(owner?: object, readLimits = false, automatic = false): Promise<AccountState> {
    await this.start();
    const { account } = await this.rpc<{
      account: null | { type: string; email?: string; planType?: string; workspaceName?: string };
    }>('account/read', { refreshToken: false });

    let codexLimits: Limits | undefined, codexLimitsAt: string | undefined;
    if (readLimits && account?.type === 'chatgpt') {
      const key = JSON.stringify([account.email, account.workspaceName, account.planType]);
      if (!automatic || this.quotaRead?.key !== key || Date.now() - this.quotaRead.time >= 60000) {
        const result = this.rpc<Parameters<typeof subscriptionLimits>[0]>('account/rateLimits/read')
          .then(subscriptionLimits)
          .catch(() => undefined);
        this.quotaRead = { key, time: Date.now(), result };
      }
      const read = this.quotaRead;
      codexLimits = await read.result;
      if (codexLimits) codexLimitsAt = new Date(read.time).toISOString();
    } else if (!account) this.quotaRead = undefined;
    const provider = account
      ? await this.rpc<{ config: { model_provider?: string | null } }>('config/read', {
          includeLayers: false,
        })
          .then((r) => r.config?.model_provider ?? undefined)
          .catch(() => undefined)
      : undefined;
    const challenge = owner && this.login?.owner === owner ? this.login.challenge : undefined;
    return {
      loggedIn: !!account,
      authMethod: account?.type,
      email: account?.email ?? undefined,
      organization: account?.workspaceName ?? undefined,
      subscriptionType: account?.planType ?? undefined,
      login: challenge ? { url: challenge.url, deviceCode: challenge.deviceCode } : null,
      codexLimits,
      codexProvider: provider,
      codexLimitsAt,
    };
  }
  async begin(owner: object) {
    if (this.login) throw new Error('已有设备登录正在进行。');
    const flow: Flow = { owner };
    this.login = flow;
    try {
      await this.start();
      if (this.login !== flow) return;
      const challenge = await this.rpc<{
        loginId: string;
        verificationUrl: string;
        userCode: string;
      }>('account/login/start', { type: 'chatgptDeviceCode' });
      if (this.login !== flow) return;
      const url = new URL(challenge.verificationUrl);
      if (
        url.username ||
        url.password ||
        url.protocol !== 'https:' ||
        !['auth.openai.com', 'chatgpt.com'].includes(url.host) ||
        !challenge.loginId ||
        !challenge.userCode
      )
        throw new Error('Codex 返回了无效的设备授权信息。');
      flow.challenge = {
        loginId: challenge.loginId,
        url: url.href,
        deviceCode: challenge.userCode,
      };
      if (flow.completed?.loginId === challenge.loginId) this.complete(flow.completed.success);
    } catch (error) {
      if (this.login === flow) this.stop();
      throw error;
    }
  }
  cancel(owner: object) {
    if (this.login?.owner === owner) this.stop();
  }
  async logout() {
    this.stop();
    await this.start();
    await this.rpc('account/logout');
  }
  stop() {
    this.login = undefined;
    const child = this.child;
    this.child = this.ready = undefined;
    for (const finish of this.pending.values()) finish(null, new Error('Codex 请求已取消。'));
    child?.stdin.end();
    child?.kill();
  }
}
