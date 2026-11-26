import { useState, useEffect } from 'react';
import type { AccountState, Command } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { CopyButton } from './copy.tsx';
import { UserRound, ListOrdered, LogOut, RefreshCw } from 'lucide-react';
import { usePrefs, setPrefs } from './prefs.ts';
import type { UsageSummary } from '@cc-desk-tunnel/protocol';
import UsagePanel, { dollars, tokens } from './UsagePanel.tsx';
import { Page, Row, Switch } from './ui.tsx';

export default function CodexAccountPanel({
  client,
  account,
  connected,
  browser,
}: {
  client: ProxyClient;
  account: AccountState | null;
  connected: boolean;
  browser: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { quotaReads } = usePrefs();
  const [log, setLog] = useState(false);
  const identity = JSON.stringify([
    account?.email,
    account?.organization,
    account?.subscriptionType,
  ]);
  const [reading, setReading] = useState<{ identity: string; value: UsageSummary } | null>(null);
  const summary = reading?.identity === identity ? reading.value : null;
  useEffect(() => {
    let active = true;
    if (!connected || browser || !account?.loggedIn) {
      setReading(null);
      return;
    }
    client.fetch({ type: 'usage.summary' }).then(
      (value) => {
        if (active) setReading({ identity, value });
      },
      (e) => {
        if (active) setError(e.message);
      },
    );
    return () => {
      active = false;
    };
  }, [connected, browser, client, account, identity, log]);
  async function run(
    command: Extract<
      Command,
      { type: 'account.login' | 'account.logout' | 'account.cancel' | 'account.status' }
    >['type'],
  ) {
    setBusy(true);
    setError('');
    try {
      await client.request({ type: command });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  const login = account?.login;
  const limits = [account?.codexLimits?.primary, account?.codexLimits?.secondary].filter(
    (w) => !!w,
  );
  const durations = [
    ...new Set([
      ...(account?.subscriptionType?.toLowerCase() === 'plus' ? [300, 10080] : []),
      ...limits.map((w) => w.windowDurationMins ?? 0),
      ...(summary?.windows.map((w) => (w.name === 'five_hour' ? 300 : 10080)) ?? []),
    ]),
  ].sort((a, b) => a - b);
  if (log && connected && !browser && account?.loggedIn)
    return (
      <UsagePanel
        codex
        client={client}
        summary={summary}
        initial="today"
        back={() => setLog(false)}
      />
    );
  return (
    <Page
      title="账号与额度"
      label="Codex 账号"
      intro="VPS 上的 Codex 账号和订阅额度。"
      actions={
        !browser && (
          <button
            type="button"
            className="icon-button"
            aria-label="刷新账号与额度"
            disabled={!connected || busy}
            onClick={() => void run('account.status')}
          >
            <RefreshCw />
          </button>
        )
      }
    >
      {error || account?.notice ? <p role="alert">{error || account?.notice}</p> : null}
      {browser ? (
        <p>请在 Windows 桌面客户端管理 Codex 账号。</p>
      ) : (
        <>
          <div className="card account-card">
            <div className="account-identity">
              <span className="account-avatar">
                <UserRound />
              </span>
              <div>
                <h2>
                  {account?.loggedIn
                    ? account.email || 'Codex 已登录'
                    : account
                      ? '尚未登录 Codex'
                      : '正在读取登录状态'}
                </h2>
                <p>{account?.subscriptionType || 'Codex CLI'}</p>
              </div>
              {account?.loggedIn && (
                <button
                  className="button secondary"
                  disabled={busy || !connected}
                  onClick={() => {
                    if (window.confirm('退出 VPS 上的 Codex 账号？')) void run('account.logout');
                  }}
                >
                  <LogOut />
                  退出登录
                </button>
              )}
            </div>
            {account?.loggedIn ? (
              <>
                <Row title="登录方式">
                  <span className="setting-value">
                    {account.authMethod === 'chatgpt'
                      ? 'ChatGPT 授权'
                      : account.authMethod === 'apiKey'
                        ? 'API 密钥'
                        : account.authMethod}
                  </span>
                </Row>
                {account.organization && (
                  <Row title="工作区">
                    <span className="setting-value">{account.organization}</span>
                  </Row>
                )}
                {account.codexProvider && (
                  <Row title="模型服务">
                    <span className="setting-value">
                      {account.codexProvider === 'openai' ? 'OpenAI' : account.codexProvider}
                    </span>
                  </Row>
                )}
              </>
            ) : login?.deviceCode ? (
              <div className="account-login">
                <p>
                  在本机浏览器打开 OpenAI 授权页，登录 ChatGPT
                  后输入以下设备码。完成后此页会自动更新。
                </p>
                <p>
                  <strong>{login.deviceCode}</strong>{' '}
                  <CopyButton text={login.deviceCode} label="复制设备码" />
                </p>
                <button
                  type="button"
                  className="button primary"
                  onClick={() =>
                    void window.desktop
                      ?.openExternal(login.url)
                      .catch(() => setError('请复制授权链接并在浏览器打开。'))
                  }
                >
                  打开 OpenAI 授权页
                </button>
                <CopyButton text={login.url} label="复制授权链接" />
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => void run('account.cancel')}
                >
                  取消登录
                </button>
              </div>
            ) : (
              <>
                <p>
                  使用 ChatGPT 账号授权。个人账号可在 ChatGPT
                  安全设置中启用设备码登录，工作区账号由管理员启用。
                </p>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !connected || !account}
                  onClick={() => void run('account.login')}
                >
                  用设备码登录 Codex
                </button>
              </>
            )}
          </div>
          {account?.loggedIn && (
            <>
              <div className="page-heading account-section-title">
                <h2>订阅用量</h2>
                <button
                  type="button"
                  className="button secondary"
                  aria-expanded={log}
                  onClick={() => setLog(!log)}
                >
                  <ListOrdered />
                  调用日志
                </button>
              </div>
              <div className="settings-list card">
                {durations.length ? (
                  durations.map((mins) => {
                    const w = limits.find((w) => (w.windowDurationMins ?? 0) === mins);
                    const name =
                      mins === 10080
                        ? '每周额度'
                        : mins && mins % 60 === 0
                          ? mins / 60 + ' 小时额度'
                          : mins
                            ? mins + ' 分钟额度'
                            : '订阅额度';
                    const period = summary?.windows.find(
                      (p) =>
                        p.name === (mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : ''),
                    );
                    const reset = w?.resetsAt
                      ? new Date(w.resetsAt * 1000)
                      : period?.resetsAt
                        ? new Date(period.resetsAt)
                        : null;
                    const used =
                      reset && reset.getTime() <= Date.now()
                        ? null
                        : (w?.usedPercent ?? period?.utilization);
                    return (
                      <div className="quota-row" key={mins}>
                        <div>
                          <strong>{name}</strong>
                          <span>
                            {used == null
                              ? '等待 Codex 上报'
                              : used + '% 已用 · ' + Math.max(0, 100 - used) + '% 剩余'}
                          </span>
                        </div>
                        {used != null && <progress aria-label={name} value={used} max={100} />}
                        {reset && <small>重置于 {reset.toLocaleString()}</small>}
                        {period && (
                          <small>
                            本期桌面对话 {period.requests} 次调用 ·{' '}
                            {tokens(
                              period.inputTokens +
                                period.cacheReadTokens +
                                period.cacheCreationTokens +
                                period.outputTokens,
                            )}{' '}
                            tokens{period.costUsd > 0 && ` · 等价 ${dollars(period.costUsd)}`}
                          </small>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <p>当前账号未返回订阅额度。</p>
                )}
                {account.codexLimitsAt && (
                  <small>更新于 {new Date(account.codexLimitsAt).toLocaleTimeString()}</small>
                )}
                <Row title="运行中每分钟读取一次额度">
                  <Switch
                    label="运行中每分钟读取一次额度"
                    checked={quotaReads}
                    onChange={(v) => setPrefs((p) => ({ ...p, quotaReads: v }))}
                  />
                </Row>
              </div>
            </>
          )}
        </>
      )}
    </Page>
  );
}
