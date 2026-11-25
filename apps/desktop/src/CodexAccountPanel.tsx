import { SshKeySetup } from './SshKeySetup.tsx';
import { useState } from 'react';
import type { AccountState, Command } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { CopyButton } from './copy.tsx';
import { Page, Row } from './ui.tsx';

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
  return (
    <Page title="账号与额度" label="Codex 账号" intro="此账号供 VPS 容器里的 Codex CLI 使用。">
      {error || account?.notice ? <p role="alert">{error || account?.notice}</p> : null}
      {browser ? (
        <p>请在 Windows 桌面客户端管理 Codex 账号。</p>
      ) : (
        <>
          <div className="card account-card">
            <Row
              title={
                account?.loggedIn
                  ? account.email || 'Codex 已登录'
                  : account
                    ? '尚未登录 Codex'
                    : '正在读取 Codex 登录状态'
              }
            >
              <button
                type="button"
                className="button"
                disabled={!connected || busy}
                onClick={() => void run('account.status')}
              >
                刷新
              </button>
            </Row>
            {account?.loggedIn ? (
              <>
                <Row title="登录方式">
                  {account.authMethod === 'chatgpt' ? 'ChatGPT' : account.authMethod}
                </Row>
                {account.subscriptionType && <Row title="订阅">{account.subscriptionType}</Row>}
                {account.organization && <Row title="工作区">{account.organization}</Row>}
                <button
                  type="button"
                  className="button"
                  disabled={busy || !connected}
                  onClick={() => {
                    if (window.confirm('退出 VPS 上的 Codex 账号？')) void run('account.logout');
                  }}
                >
                  退出 Codex 登录
                </button>
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
            <div className="card account-card">
              <h2>Codex 额度</h2>
              {limits.length ? (
                limits.map((w, i) => (
                  <Row
                    key={i}
                    title={
                      w.windowDurationMins ? `${w.windowDurationMins} 分钟用量窗口` : '用量窗口'
                    }
                    detail={
                      w.resetsAt
                        ? `重置时间 ${new Date(w.resetsAt * 1000).toLocaleString()}`
                        : undefined
                    }
                  >
                    已用 {w.usedPercent}%
                  </Row>
                ))
              ) : (
                <p>当前账号未返回 Codex 额度数据。</p>
              )}
            </div>
          )}
          <SshKeySetup />
        </>
      )}
    </Page>
  );
}
