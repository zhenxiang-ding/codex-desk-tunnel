import { useEffect, useState } from 'react';
import type { CodexConfig, CodexModel } from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { Page, Row } from './ui.tsx';
import IdleCompactionSettings from './IdleCompactionSettings.tsx';
import { effortLabels } from './CodexToolbar.tsx';

type Field = {
  key: keyof CodexConfig;
  name: string;
  detail?: string;
  kind?: 'number' | 'bool';
  options?: Record<string, string>;
};
const groups: { name: string; fields: Field[] }[] = [
  {
    name: '上下文与记忆',
    fields: [
      {
        key: 'model_auto_compact_token_limit',
        name: '自动压缩窗口',
        kind: 'number',
        detail: '达到此 token 阈值时压缩历史；留空使用模型默认值。',
      },
      {
        key: 'features.memories',
        name: '自动记忆',
        kind: 'bool',
        detail: '启用此 VPS 上 Codex 的跨会话记忆。',
      },
      {
        key: 'memories.generate_memories',
        name: '生成记忆',
        kind: 'bool',
        detail: '允许新线程成为后台记忆整理的来源。',
      },
      {
        key: 'memories.use_memories',
        name: '读取记忆',
        kind: 'bool',
        detail: '在后续会话中使用已保存的记忆。',
      },
    ],
  },
  {
    name: '模型与推理',
    fields: [
      { key: 'model', name: '默认模型', detail: '可在会话输入框单独选择模型。' },
      { key: 'model_reasoning_effort', name: '推理强度', options: {} },
      {
        key: 'model_reasoning_summary',
        name: '思考摘要',
        options: { auto: '自动', concise: '简短', detailed: '详细', none: '关闭' },
        detail: '支持摘要的模型会将摘要显示在对话中。',
      },
      { key: 'service_tier', name: '服务档位', options: {}, detail: '可用档位取决于模型和账号。' },
    ],
  },
  {
    name: '行为',
    fields: [
      {
        key: 'model_verbosity',
        name: '回复详细程度',
        options: { low: '简洁', medium: '适中', high: '详细' },
      },
      {
        key: 'tool_output_token_limit',
        name: '工具输出上限',
        kind: 'number',
        detail: '写入模型历史的单次工具输出 token 预算。',
      },
      {
        key: 'web_search',
        name: '网页搜索',
        options: { disabled: '关闭', cached: '缓存', live: '实时' },
      },
    ],
  },
  {
    name: '权限',
    fields: [
      {
        key: 'approval_policy',
        name: '审批规则',
        options: { 'on-request': '按需询问', untrusted: '非受信命令先询问', never: '直接拒绝提权' },
        detail: '会话工具栏可覆盖此默认值。',
      },
      {
        key: 'approvals_reviewer',
        name: '审批人',
        options: { user: '由我审批', auto_review: 'Codex 自动审查' },
      },
      {
        key: 'sandbox_mode',
        name: 'VPS 沙箱',
        options: {
          'read-only': '只读',
          'workspace-write': '允许写入工作区',
          'danger-full-access': '完全访问',
        },
        detail: '限制 VPS 上运行的命令。本机文件访问由 SSH 登录用户的权限决定。',
      },
    ],
  },
];
export function CodexSettings({
  client,
  section = 'cli',
  legacy = false,
}: {
  legacy?: boolean;
  client: ProxyClient;
  section?: 'cli' | 'context' | 'permissions';
}) {
  const visible = groups
    .map((group) => ({
      ...group,
      fields: group.fields.filter((f) =>
        section === 'permissions'
          ? group.name === '权限'
          : section === 'context'
            ? f.key === 'model_auto_compact_token_limit'
            : true,
      ),
    }))
    .filter((group) => group.fields.length);

  const [current, setCurrent] = useState<CodexConfig | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [models, setModels] = useState<CodexModel[]>([]);
  useEffect(() => {
    let active = true;
    if (section !== 'cli') return;
    client.fetch({ type: 'codex.models.get' }).then(
      (r) => {
        if (active) setModels(r.models);
      },
      () => {
        if (active) setModels([]);
      },
    );
    return () => {
      active = false;
    };
  }, [client, section]);
  const selectedModel = current?.model;
  const model = selectedModel
    ? models.find((m) => m.model === selectedModel)
    : models.find((m) => m.isDefault);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setMessage('');
    client
      .fetch({ type: 'codex.settings.get' })
      .then(
        (r) => {
          if (active) {
            setCurrent(r.values);
          }
        },
        (e) => {
          if (active) setMessage(e.message);
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [client, section]);
  async function save(values: Partial<CodexConfig>) {
    setBusy(true);
    setMessage('');
    try {
      const r = await client.fetch({ type: 'codex.settings.update', values });
      setCurrent(r.values);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }
  const controls = (
    <>
      {current && (
        <>
          {visible.map((group) => (
            <section className="settings-section" key={group.name}>
              <h2 className="page-heading">
                {section === 'context'
                  ? '按上下文用量压缩'
                  : section === 'permissions'
                    ? 'Codex 默认审批权限（VPS）'
                    : group.name}
              </h2>
              <div className="settings-list card">
                {group.fields.map((f) => {
                  const value = current[f.key];
                  const opts: Record<string, string> | undefined =
                    f.key === 'model_reasoning_effort'
                      ? Object.fromEntries(
                          (model?.supportedReasoningEfforts ?? []).map((e) => [
                            e.reasoningEffort,
                            effortLabels[e.reasoningEffort] ?? e.reasoningEffort,
                          ]),
                        )
                      : f.key === 'service_tier'
                        ? Object.fromEntries((model?.serviceTiers ?? []).map((t) => [t.id, t.name]))
                        : f.kind === 'bool'
                          ? { true: '开启', false: '关闭' }
                          : f.options;
                  const change = (raw: string) => {
                    if (
                      raw === 'danger-full-access' &&
                      !window.confirm(
                        '启用完全访问后，Codex 可以读写 VPS 上服务账号有权访问的文件。启用完全访问？',
                      )
                    )
                      return;
                    if (raw === String(value ?? '')) return;
                    void save({
                      [f.key]:
                        raw === ''
                          ? null
                          : f.kind === 'number'
                            ? Number(raw)
                            : f.kind === 'bool'
                              ? raw === 'true'
                              : raw,
                    });
                  };
                  return (
                    <Row key={f.key} title={f.name} detail={f.detail}>
                      {opts ? (
                        <select
                          aria-label={f.name}
                          disabled={busy}
                          value={String(value ?? '')}
                          onChange={(e) => change(e.target.value)}
                        >
                          <option value="">
                            {f.key === 'features.memories' ? '桌面对话默认（开启）' : 'CLI 默认'}
                          </option>
                          {value != null && !(String(value) in opts) && (
                            <option value={String(value)}>{String(value)}</option>
                          )}
                          {Object.entries(opts)
                            .filter(([key]) => !legacy || key !== 'danger-full-access')
                            .map(([key, label]) => (
                              <option key={key} value={key}>
                                {label}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <input
                          list={f.key === 'model' ? 'codex-setting-models' : undefined}
                          aria-label={f.name}
                          type={f.kind === 'number' ? 'number' : 'text'}
                          min={f.kind === 'number' ? 1 : undefined}
                          step={f.kind === 'number' ? 1 : undefined}
                          maxLength={160}
                          disabled={busy}
                          key={String(value ?? '')}
                          defaultValue={String(value ?? '')}
                          placeholder="CLI 默认"
                          onBlur={(e) => {
                            if (e.currentTarget.validity.valid) {
                              const input = e.currentTarget;
                              const previous = String(value ?? '');
                              const next = input.value.trim();
                              input.value = previous;
                              change(next);
                            } else {
                              setMessage('请输入大于零的整数。');
                              e.currentTarget.value = String(value ?? '');
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                        />
                      )}
                    </Row>
                  );
                })}
              </div>
            </section>
          ))}
          <datalist id="codex-setting-models">
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.displayName}
              </option>
            ))}
          </datalist>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
  if (section === 'permissions') return controls;
  return (
    <Page
      title={section === 'context' ? '上下文与缓存' : 'CLI 设置'}
      intro="配置保存在 VPS。修改后自动保存，后续运行会使用新设置。"
    >
      {controls}
      {section === 'context' &&
        (legacy ? (
          <p>请升级服务端以启用空闲压缩。</p>
        ) : (
          <IdleCompactionSettings client={client} codex />
        ))}
    </Page>
  );
}
