import { useState, useEffect, useRef, type CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Check, RotateCcw, ShieldCheck } from 'lucide-react';
import type {
  CodexChoice,
  CodexModel,
  CodexConfig,
  Session,
  EventPayload,
} from '@cc-desk-tunnel/protocol';
import type { ProxyClient } from './client.ts';
import { ComposerQuota } from './ComposerControls.tsx';
import { usePrefs } from './prefs.ts';
import ContextMeter from './ContextMeter.tsx';
import { IconButton } from './ui.tsx';

import { codexPreset, type CodexPreset } from '@cc-desk-tunnel/protocol';
export const approvalLabels = {
  'ask-for-approval': 'Ask for approval',
  'approve-for-me': 'Approve for me',
  'full-access': 'Full access',
  'read-only': 'Read only',
} as const;
export const effortLabels: Record<string, string> = {
  none: '关闭',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '超高',
} as const;
export function CodexToolbar({
  client,
  session,
  disabled,
  usage,
  configure,
  commandMenu,
  setServiceTiers,
  quota,
  openAccount,
}: {
  client: ProxyClient;
  session: Session;
  disabled: boolean;
  usage?: (Extract<EventPayload, { type: 'codex.usage' }> & { measuredAt: string }) | null;
  quota: import('@cc-desk-tunnel/protocol').AccountQuota | null;
  openAccount: () => void;
  setServiceTiers: (tiers: NonNullable<CodexModel['serviceTiers']>) => void;
  commandMenu: { name: 'approval' | 'model'; sequence: number } | null;
  configure: (choice: CodexChoice) => Promise<void>;
}) {
  const { sessionBar } = usePrefs();
  const [menu, open] = useState<'approval' | 'model' | 'effort' | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]),
    [defaults, setDefaults] = useState<CodexConfig | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [refresh, reload] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const left = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    client
      .fetch({ type: 'codex.models.get' })
      .then(
        (r) => {
          if (active) {
            setModels(r.models);
            setDefaults(r.defaults);
          }
        },
        (e) => {
          if (active) setError(String(e.message ?? e));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, refresh, session.id]);
  useEffect(() => {
    open(null);
    setPreview(null);
  }, [session.id, disabled]);
  useEffect(() => {
    function outside(e: PointerEvent) {
      if (!left.current?.contains(e.target as Node) && !right.current?.contains(e.target as Node))
        open(null);
    }
    function escape(e: KeyboardEvent) {
      if (e.key === 'Escape') open(null);
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  useEffect(() => {
    if (commandMenu) open(commandMenu.name);
  }, [commandMenu]);
  const choice = session.codex ?? {},
    current =
      models.find((m) => m.model === (choice.model ?? defaults?.model)) ??
      (!choice.model && !defaults?.model ? models.find((m) => m.isDefault) : undefined);
  useEffect(() => {
    setServiceTiers(current?.serviceTiers ?? []);
  }, [current, setServiceTiers]);
  const modelLabel = current?.displayName || choice.model || defaults?.model || 'CLI 默认模型';
  const levels = current?.supportedReasoningEfforts ?? [];
  const actual =
    choice.effort ??
    (!choice.model || choice.model === defaults?.model ? defaults?.model_reasoning_effort : null) ??
    current?.defaultReasoningEffort;
  const shown = preview === null ? actual : levels[preview]?.reasoningEffort;
  const legacy = /^0\.1\.[0-7]$/.test(client.state.service ?? '');
  const approval =
    legacy && !choice.approval && !defaults?.approvals_reviewer
      ? codexPreset({ ...defaults, approvals_reviewer: 'user' })
      : codexPreset(defaults ?? {}, choice.approval);
  const metrics = codexContext(usage);
  function save(c: CodexChoice) {
    open(null);
    setPreview(null);
    void configure(c);
  }
  function level(index: number) {
    if (levels[index]) save({ effort: levels[index].reasoningEffort });
  }
  return (
    <>
      <div className="permission-control" ref={left}>
        <button
          type="button"
          className="chip"
          aria-label="审批模式"
          aria-expanded={menu === 'approval'}
          disabled={disabled}
          onClick={() => open(menu === 'approval' ? null : 'approval')}
        >
          <ShieldCheck />
          {approval ? approvalLabels[approval] : '自定义权限'}
          <ChevronDown />
        </button>
        {menu === 'approval' && (
          <div className="permission-menu" role="menu" aria-label="审批模式">
            {(Object.keys(approvalLabels) as CodexPreset[]).map((preset) => (
              <button
                type="button"
                key={preset}
                role="menuitemradio"
                aria-checked={approval === preset}
                disabled={
                  legacy &&
                  (preset === 'full-access' ||
                    preset === 'read-only' ||
                    (!!defaults?.sandbox_mode && defaults.sandbox_mode !== 'workspace-write'))
                }
                title={
                  legacy ? '旧服务端仅支持在工作区沙箱中切换审批人；升级可使用所有预设' : undefined
                }
                onClick={() => {
                  if (
                    preset === 'full-access' &&
                    !window.confirm(
                      '允许此会话在 VPS 服务账号的权限范围内完全访问文件和网络，且不再请求审批？',
                    )
                  )
                    return;
                  save({
                    approval: legacy
                      ? preset === 'approve-for-me'
                        ? 'auto_review'
                        : 'on-request'
                      : preset,
                  });
                }}
              >
                {approvalLabels[preset]}
                {approval === preset && <Check />}
              </button>
            ))}
            {choice.approval && (
              <button type="button" onClick={() => save({ approval: null })}>
                恢复服务端默认
              </button>
            )}
          </div>
        )}
      </div>
      <span className="toolbar-space" />
      <div className="composer-controls" ref={right}>
        <ComposerQuota account={quota} openAccount={openAccount} />
        {!sessionBar.enabled && <ContextMeter metrics={metrics} source="Codex 最近一次用量" />}
        <div className="model-control">
          <button
            type="button"
            className="model-trigger"
            disabled={disabled}
            aria-label="模型与推理强度"
            aria-expanded={menu === 'model' || menu === 'effort'}
            onClick={() => {
              setPreview(null);
              open(menu === 'effort' || menu === 'model' ? null : 'effort');
            }}
          >
            <span>{modelLabel}</span>
            <small>{actual ? (effortLabels[actual] ?? actual) : '默认'}</small>
            <ChevronDown />
          </button>
          {(menu === 'model' || menu === 'effort') && (
            <div
              className={'model-menu' + (menu === 'model' ? ' choosing' : '')}
              role="dialog"
              aria-label="模型与推理强度"
            >
              {menu === 'effort' ? (
                <div className="effort-view">
                  <div className="effort-heading">
                    <strong>{shown ? (effortLabels[shown] ?? shown) : '原生默认'}</strong>
                    <IconButton title="恢复默认推理强度" onClick={() => save({ effort: null })}>
                      <RotateCcw />
                    </IconButton>
                  </div>
                  <button type="button" className="model-current" onClick={() => open('model')}>
                    {modelLabel}
                    <ChevronRight />
                  </button>
                  {levels.length > 1 && (
                    <input
                      className="effort-slider"
                      type="range"
                      aria-label="推理强度"
                      aria-valuetext={shown ? (effortLabels[shown] ?? shown) : undefined}
                      min={0}
                      max={levels.length - 1}
                      value={Math.max(
                        0,
                        levels.findIndex((v) => v.reasoningEffort === shown),
                      )}
                      style={
                        {
                          '--fill':
                            Math.max(
                              0,
                              levels.findIndex((v) => v.reasoningEffort === shown),
                            ) /
                            (levels.length - 1),
                        } as CSSProperties
                      }
                      onChange={(e) => setPreview(Number(e.target.value))}
                      onPointerUp={(e) => level(Number(e.currentTarget.value))}
                      onKeyUp={(e) => {
                        if (
                          [
                            'ArrowLeft',
                            'ArrowRight',
                            'ArrowDown',
                            'ArrowUp',
                            'Home',
                            'End',
                          ].includes(e.key)
                        )
                          level(Number(e.currentTarget.value));
                      }}
                    />
                  )}
                  <div className="effort-ticks">
                    {levels.map((v, index) => (
                      <button
                        className={shown === v.reasoningEffort ? 'current' : undefined}
                        style={{ '--at': index / Math.max(1, levels.length - 1) } as CSSProperties}
                        key={v.reasoningEffort}
                        type="button"
                        aria-pressed={shown === v.reasoningEffort}
                        title={v.description}
                        onClick={() => save({ effort: v.reasoningEffort })}
                      >
                        {effortLabels[v.reasoningEffort] ?? v.reasoningEffort}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <button type="button" className="model-back" onClick={() => open('effort')}>
                    <ArrowLeft />
                    选择模型
                  </button>
                  <div className="model-options" role="listbox" aria-label="选择模型">
                    <button
                      type="button"
                      role="option"
                      aria-selected={!choice.model}
                      onClick={() => save({ model: null, effort: null })}
                    >
                      默认模型{!choice.model && <Check />}
                    </button>
                    {models.map((m) => (
                      <button
                        key={m.model}
                        type="button"
                        role="option"
                        aria-selected={choice.model === m.model}
                        title={m.description}
                        onClick={() => save({ model: m.model, effort: null })}
                      >
                        {m.displayName || m.model}
                        {choice.model === m.model && <Check />}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="model-refresh"
                    disabled={loading}
                    onClick={() => reload((v) => v + 1)}
                  >
                    <RotateCcw />
                    {loading ? '正在读取模型…' : '刷新模型列表'}
                  </button>
                </>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export const codexContext = (
  usage:
    (Extract<EventPayload, { type: 'codex.usage' }> & { measuredAt: string }) | null | undefined,
) =>
  usage?.window
    ? {
        type: 'native.metrics' as const,
        usage: null,
        context: {
          model: usage.model ?? 'Codex',
          usedTokens: usage.last.totalTokens,
          windowTokens: usage.window,
          percentage: Math.min(100, Math.round((100 * usage.last.totalTokens) / usage.window)),
          measuredAt: usage.measuredAt,
          categories: [],
        },
      }
    : null;
