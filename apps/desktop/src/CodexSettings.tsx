import { useEffect, useState } from 'react';
import type { CodexConfig, CodexTokens } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Page, Row } from './ui.tsx';

const labels: Record<keyof CodexTokens, string> = {
  totalTokens: '总 token',
  inputTokens: '输入 token',
  cachedInputTokens: '其中缓存输入',
  outputTokens: '输出 token',
  reasoningOutputTokens: '其中推理输出',
};

export function CodexSettings({
  client,
  section,
}: {
  client: ProxyClient;
  section: 'claude' | 'context' | 'codexUsage';
}) {
  const [config, setConfig] = useState<CodexConfig | null>(null),
    [limit, setLimit] = useState('');
  const [usage, setUsage] = useState<{ totals: CodexTokens; sessions: number } | null>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0);
  const context = section === 'context',
    stats = section === 'codexUsage';
  function display(values: CodexConfig) {
    setConfig(values);
    setLimit(String(values.model_auto_compact_token_limit ?? ''));
  }
  useEffect(() => {
    let active = true;
    setBusy(true);
    setNotice('');
    const read = stats
      ? client.fetch({ type: 'codex.usage.get' }).then((v) => {
          if (active) setUsage(v);
        })
      : client.fetch({ type: 'codex.settings.get' }).then((v) => {
          if (active) display(v.values);
        });
    void read
      .catch((e) => {
        if (active) setNotice(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, section, stats, revision]);
  async function save() {
    if (!config) return;
    const threshold = limit.trim() ? Number(limit) : null;
    if (context && threshold !== null && (!Number.isSafeInteger(threshold) || threshold <= 0)) {
      setNotice('请输入正整数，或留空使用模型默认阈值。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const values = context
        ? { model_auto_compact_token_limit: threshold }
        : {
            model: config.model?.trim() || null,
            model_reasoning_effort: config.model_reasoning_effort,
          };
      display((await client.fetch({ type: 'codex.settings.update', values })).values);
      setNotice('已保存到 VPS 上的 Codex 配置，下轮对话生效。');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      title={stats ? '用量统计' : context ? '自动压缩上下文' : 'CLI 设置'}
      intro={
        stats
          ? '汇总当前保留的桌面对话中，Codex 已上报的累计 token。'
          : context
            ? '达到阈值时，Codex 会压缩较早的对话，以便在同一会话中继续工作。'
            : '配置 VPS 上 Codex CLI 使用的模型与推理强度。'
      }
    >
      <div className="card account-card">
        {stats && usage && (
          <>
            <Row title="已上报用量的会话">{usage.sessions}</Row>
            {(Object.keys(labels) as (keyof CodexTokens)[]).map((k) => (
              <Row key={k} title={labels[k]}>
                {usage.totals[k].toLocaleString()}
              </Row>
            ))}
          </>
        )}
        {!stats &&
          config &&
          (context ? (
            <Row title="自动压缩阈值（token）" detail="留空使用 Codex 为所选模型确定的阈值。">
              <input
                aria-label="自动压缩阈值"
                type="number"
                min="1"
                step="1"
                placeholder="模型默认"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </Row>
          ) : (
            <>
              <Row title="模型" detail="留空使用 Codex 的默认模型。">
                <input
                  aria-label="模型"
                  placeholder="Codex 默认"
                  value={config.model ?? ''}
                  maxLength={160}
                  onChange={(e) => setConfig({ ...config, model: e.target.value })}
                />
              </Row>
              <Row title="推理强度">
                <select
                  aria-label="推理强度"
                  value={config.model_reasoning_effort ?? ''}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      model_reasoning_effort:
                        (e.target.value as CodexConfig['model_reasoning_effort']) || null,
                    })
                  }
                >
                  <option value="">模型默认</option>
                  {['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Row>
            </>
          ))}
        {!!notice && <p role="status">{notice}</p>}
        {!stats && (
          <button className="button primary" disabled={busy || !config} onClick={() => void save()}>
            保存
          </button>
        )}
        <button className="button" disabled={busy} onClick={() => refresh((v) => v + 1)}>
          {busy ? '读取或保存中…' : '刷新'}
        </button>
      </div>
    </Page>
  );
}
