import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AccountState } from '@cc-desk-tunnel/protocol';

type Process = ChildProcessByStdio<Writable, Readable, null>;
type Limits = NonNullable<AccountState['codexLimits']>;
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
      capabilities: {},
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
  async state(owner?: object, readLimits = false): Promise<AccountState> {
    await this.start();
    const { account } = await this.rpc<{
      account: null | { type: string; email?: string; planType?: string; workspaceName?: string };
    }>('account/read', { refreshToken: false });

    let codexLimits: Limits | undefined;
    if (readLimits && account?.type === 'chatgpt') {
      const result = await this.rpc<{ rateLimits: Limits }>('account/rateLimits/read').catch(
        () => null,
      );
      if (result?.rateLimits) {
        const { primary, secondary } = result.rateLimits;
        codexLimits = { primary, secondary };
      }
    }
    const challenge = owner && this.login?.owner === owner ? this.login.challenge : undefined;
    return {
      loggedIn: !!account,
      authMethod: account?.type,
      email: account?.email ?? undefined,
      organization: account?.workspaceName ?? undefined,
      subscriptionType: account?.planType ?? undefined,
      login: challenge ? { url: challenge.url, deviceCode: challenge.deviceCode } : null,
      codexLimits,
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
