import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, Folder, Play, Plus, RefreshCw, Shrink, Square, SquareSlash } from 'lucide-react';
import { isWindowsPath, skillMention } from '@cc-desk-tunnel/protocol';
import type {
  AccountQuota,
  CodexModel,
  Effort,
  NativeCapabilities,
  NativeMetrics,
  NativeSession,
  PermissionMode,
  Session,
} from '@cc-desk-tunnel/protocol';
import { codexCommandPrefix, codexCommands, parseCodexCommand } from './codex-commands.ts';
import CodexSkillPicker from './CodexSkillPicker.tsx';
import { CodexSettings } from './CodexSettings.tsx';
import { Modal } from './ui.tsx';
import { slashCommands } from './commands.ts';
import { CodexToolbar } from './CodexToolbar.tsx';
import type { ProxyClient } from './client.ts';
import ProjectBranch from './ProjectBranch.tsx';
import ComposerControls from './ComposerControls.tsx';
import MessageInput, { messageLimit } from './MessageInput.tsx';
import type { MessageInputHandle } from './MessageInput.tsx';
import PermissionMenu from './PermissionMenu.tsx';
import { IconButton } from './ui.tsx';
import type { MenuPosition } from './ui.tsx';

export type Scenario = 'chat' | 'tool' | 'question' | 'plan' | 'error';
// A draft that is only a slash and an optional command name opens the command menu.
const slashDraft = /^[/\\][^ \n]*$/;

export default function Composer({
  session,
  projectName,
  chooseProject,
  localProject,
  openCodexCommand,
  codexAction,
  draft,
  setDraft,
  native,
  codex = false,
  client,
  connected,
  busy,
  refreshing,
  canRefreshModels,
  ownsRun,
  inputDisabled,
  controlsDisabled,
  slashOpen,
  setSlashOpen,
  canCompact,
  scenario,
  setScenario,
  capabilities,
  nativeSession,
  metrics,
  quota,
  openAccount,
  send,
  resume,
  compact,
  refresh,
  configure,
  stop,
}: {
  session: Session;
  // Absent for a session that belongs to no project.
  projectName: string | null;
  // Opens the list of projects the session can be moved to; absent while it cannot be moved.
  localProject: boolean;
  openCodexCommand?: (command: string) => void;
  codexAction: (name: 'config' | 'usage' | 'rename' | 'export' | 'new') => void;
  chooseProject?: (position: MenuPosition) => void;
  draft: string;
  setDraft: (text: string) => void;
  native: boolean;
  codex?: boolean;
  client: ProxyClient;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  canRefreshModels: boolean;
  ownsRun: boolean;
  inputDisabled: boolean;
  controlsDisabled: boolean;
  slashOpen: boolean;
  setSlashOpen: (open: boolean) => void;
  canCompact: boolean;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  capabilities: NativeCapabilities | null;
  nativeSession: NativeSession | null;
  metrics: NativeMetrics | null;
  quota: AccountQuota | null;
  openAccount: () => void;
  // Sends the draft, or the text given instead of it.
  send: (text?: string) => void;
  // Present when the session's last turn was stopped or cut off: takes it up again without a message.
  resume?: () => void;
  compact: () => void;
  refresh: () => void;
  configure: (values: {
    codex?: Session['codex'];
    model?: string | null;
    effort?: Effort | null;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  stop: () => void;
}) {
  const input = useRef<MessageInputHandle>(null);
  const tooLong = draft.length > messageLimit;
  const toolbar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = toolbar.current!;
    const fit = () => {
      bar.classList.remove('compact-permission');
      bar.classList.add('measuring');
      bar.classList.toggle(
        'compact-permission',
        bar.lastElementChild!.getBoundingClientRect().right +
          parseFloat(getComputedStyle(bar).paddingRight) >
          bar.getBoundingClientRect().right,
      );
      bar.classList.remove('measuring');
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    for (const child of bar.children) observer.observe(child);
    return () => observer.disconnect();
  }, [session, native, capabilities, nativeSession, !!resume, !!draft.trim()]);
  const [dropping, setDropping] = useState(false);
  // The command menu: this window's own actions, then Claude Code's commands that fit what follows the slash. Enter
  // runs the one picked; Tab or a click puts a command in the box, to be given its arguments.
  // Until the keys pick one, the first that can be used is picked.
  const [pick, setPick] = useState<number | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = slashOpen ? draft.slice(1).toLowerCase() : '';
  const items: {
    key: string;
    icon: ReactNode;
    title: ReactNode;
    detail: ReactNode;
    disabled: boolean;
    run: () => void;
    fill?: string;
  }[] = [
    ...('compact'.startsWith(typed)
      ? [
          {
            key: 'compact',
            icon: <Shrink />,
            title: '压缩上下文',
            detail: metrics?.context ? `已使用 ${metrics.context.percentage}%` : '/compact',
            disabled: controlsDisabled || !canCompact,
            run: compact,
          },
        ]
      : []),
    ...('refresh'.startsWith(typed)
      ? [
          {
            key: 'refresh',
            icon: <RefreshCw />,
            title: '刷新原生状态',
            detail: '上下文与订阅额度',
            disabled: controlsDisabled || refreshing,
            run: () => {
              setSlashOpen(false);
              setDraft('');
              refresh();
            },
          },
        ]
      : []),
    ...(slashOpen ? slashCommands(capabilities, typed) : []).map((command) => ({
      key: `/${command.name}`,
      icon: <SquareSlash />,
      title: (
        <>
          /{command.name}
          {command.argumentHint && <em>{command.argumentHint}</em>}
        </>
      ),
      detail: command.description,
      disabled: inputDisabled,
      run: () => send(`/${command.name}`),
      fill: `/${command.name} `,
    })),
  ];
  const [serviceTiers, setServiceTiers] = useState<NonNullable<CodexModel['serviceTiers']>>([]);
  const [commandMenu, setCommandMenu] = useState<{
    name: 'approval' | 'model';
    sequence: number;
  } | null>(null);
  const [panel, setPanel] = useState<'skills' | 'memories' | null>(null);
  const [slashError, setSlashError] = useState('');
  useEffect(() => {
    setPanel(null);
    setSlashError('');
    setCommandMenu(null);
  }, [session.id]);
  function dispatchCommand(text: string) {
    const command = parseCodexCommand(text);
    if (!command && text !== '/') return false;
    const name = command?.name,
      args = command?.args;
    setSlashOpen(false);
    setSlashError('');
    if (!args && (name === 'permissions' || name === 'model')) {
      setCommandMenu((v) => ({
        name: name === 'permissions' ? 'approval' : 'model',
        sequence: (v?.sequence ?? 0) + 1,
      }));
    } else if (!args && name === 'compact' && canCompact) {
      compact();
      return true;
    } else if (
      !args &&
      name === 'skills' &&
      window.desktop &&
      !/^0\.1\.[0-8]$/.test(client.state.service ?? '')
    ) {
      setPanel('skills');
    } else if (!args && name === 'memories' && window.desktop) {
      setPanel('memories');
    } else if (
      !args &&
      (name === 'config' ||
        name === 'rename' ||
        name === 'usage' ||
        name === 'export' ||
        name === 'new') &&
      window.desktop
    ) {
      codexAction(name);
    } else if (openCodexCommand) {
      openCodexCommand(command?.text ?? '/');
    } else {
      setSlashError('此命令使用 VPS 上的原生 Codex 界面，请从桌面客户端打开。');
      return true;
    }
    setDraft('');
    return true;
  }
  function submit() {
    if (tooLong || inputDisabled) return;
    if (codex && dispatchCommand(draft)) return;
    send();
  }
  const shownItems: typeof items = codex
    ? [
        ...codexCommands(typed, serviceTiers).map(({ name, description }) => ({
          key: name,
          title: '/' + name,
          icon: <SquareSlash />,
          detail: description,
          disabled: inputDisabled,
          fill: undefined,
          run: () => dispatchCommand('/' + name),
        })),
        ...(openCodexCommand
          ? [
              {
                key: 'native-picker',
                title: typed ? '在 Codex CLI 中打开 /' + typed : '查看 VPS 上的完整命令菜单',
                icon: <SquareSlash />,
                detail: '包含模型档位、预设和当前启用的功能',
                disabled: inputDisabled,
                run: () => {
                  setDraft('');
                  setSlashOpen(false);
                  openCodexCommand(typed ? '/' + typed : '/');
                },
              },
            ]
          : []),
      ]
    : items;
  const menuShown = native && slashOpen && shownItems.length > 0;
  const at =
    pick === null
      ? Math.max(
          0,
          shownItems.findIndex((item) => !item.disabled),
        )
      : Math.min(pick, shownItems.length - 1);
  useEffect(() => {
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, menuShown]);
  function fill(text: string) {
    setDraft(text);
    setSlashOpen(false);
    input.current?.focus();
  }
  // A file reaches Claude as its Windows path in the message, where it was put: Claude reads it through the
  // execution channel, the same way it reads the project. The box shows it as the file (see MessageInput).
  function attach(paths: string[]) {
    if (paths.length) input.current?.insert(paths);
  }
  const shown = useRef(session.id);
  shown.current = session.id;
  // Files copied in Explorer have a path. A picture that is only on the clipboard (a screenshot, an image
  // copied from a page) has none: the client saves it on this computer and its path is attached like any other.
  async function paste(files: File[]) {
    const pasted = session.id;
    const found: string[] = [];
    for (const file of files) {
      const path = window.desktop!.pathForFile(file);
      if (path) found.push(path);
      else if (file.type.startsWith('image/'))
        try {
          found.push(
            await window.desktop!.saveImage(file.type, new Uint8Array(await file.arrayBuffer())),
          );
        } catch {
          // A picture that could not be saved is left out; the rest is still attached.
        }
    }
    if (shown.current === pasted) attach(found);
  }
  return (
    <div className="composer-area">
      {slashError && <p role="alert">{slashError}</p>}
      {panel === 'skills' && (
        <CodexSkillPicker
          client={client}
          sessionId={session.id}
          close={() => setPanel(null)}
          choose={(skill) => {
            setPanel(null);
            fill(skillMention(skill) + ' ');
          }}
        />
      )}
      {panel === 'memories' && (
        <Modal title="Codex 记忆" onClose={() => setPanel(null)}>
          <CodexSettings client={client} section="memories" />
          {openCodexCommand && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setPanel(null);
                openCodexCommand('/memories');
              }}
            >
              打开原生记忆菜单
            </button>
          )}
        </Modal>
      )}
      {menuShown && (
        <div className="slash-menu" role="listbox" aria-label="会话命令" ref={menu}>
          {shownItems.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={index === at}
              disabled={item.disabled}
              // The message box keeps the focus, and with it the keys.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setPick(index)}
              onClick={() => (item.fill ? fill(item.fill) : item.run())}
            >
              {item.icon}
              <span>
                {item.title}
                <small>{item.detail}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-context">
        <button
          type="button"
          className="chip quiet"
          aria-label="会话所在的项目"
          aria-haspopup="menu"
          title={session.projectPath}
          disabled={!chooseProject}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            chooseProject!({ x: box.left, y: box.top - 6, above: true });
          }}
        >
          <Folder />
          <span>{projectName ?? '普通会话'}</span>
        </button>
        {localProject && window.desktop && (
          <ProjectBranch
            key={session.projectPath}
            path={session.projectPath}
            running={!!session.activeRun}
            disabled={controlsDisabled}
          />
        )}
      </div>
      <form
        className={`composer ${dropping ? 'dropping' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onDragOver={(event) => {
          if (!window.desktop || inputDisabled || !event.dataTransfer.types.includes('Files'))
            return;
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!window.desktop || inputDisabled || !event.dataTransfer.files.length) return;
          event.preventDefault();
          void paste([...event.dataTransfer.files]);
        }}
      >
        <MessageInput
          ref={input}
          windows={isWindowsPath(session.projectPath)}
          placeholder={
            session.activeRun?.surface === 'terminal'
              ? '会话在终端中打开，关闭终端后可以在这里接着聊'
              : '随心输入…'
          }
          value={draft}
          disabled={inputDisabled}
          onChange={(text) => {
            setDraft(text);
            setSlashOpen(native && (codex ? codexCommandPrefix : slashDraft).test(text));
            setPick(null);
          }}
          onPaste={(event) => {
            // Pasted text is left to the browser, also when a program put a picture of it beside the text.
            if (!window.desktop || !event.clipboardData.files.length) return;
            const files = [...event.clipboardData.files];
            const text = event.clipboardData.getData('text/plain');
            const usable = files.filter(
              (file) =>
                window.desktop!.pathForFile(file) || (!text && file.type.startsWith('image/')),
            );
            if (!usable.length) return;
            event.preventDefault();
            void paste(usable);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setSlashOpen(false);
              return;
            }
            if (menuShown && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              setPick(
                (at + (event.key === 'ArrowDown' ? 1 : shownItems.length - 1)) % shownItems.length,
              );
              return;
            }
            if (menuShown && event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault();
              const command =
                shownItems[at].fill ??
                (codex && shownItems[at].key !== 'native-picker'
                  ? '/' + shownItems[at].key + ' '
                  : undefined);
              if (command) fill(command);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              // A touch keyboard has no Shift+Enter: there Enter starts a new line and the send button sends.
              if (!menuShown && matchMedia('(pointer: coarse)').matches) return;
              event.preventDefault();
              if (!menuShown) {
                submit();
              } else if (!shownItems[at].disabled) shownItems[at].run();
            }
          }}
        />
        <div className="composer-toolbar" ref={toolbar}>
          {window.desktop && (
            <IconButton
              title="添加文件：把文件的路径放进消息"
              className="attach-button"
              disabled={inputDisabled}
              onClick={() => void window.desktop!.chooseFiles().then(attach)}
            >
              <Plus />
            </IconButton>
          )}
          {codex ? (
            <CodexToolbar
              client={client}
              session={session}
              disabled={controlsDisabled}
              commandMenu={commandMenu}
              setServiceTiers={setServiceTiers}
              metrics={metrics}
              quota={quota}
              openAccount={openAccount}
              configure={(c) => configure({ codex: c })}
            />
          ) : !native ? (
            <label className="scenario-label">
              场景
              <select
                aria-label="模拟场景"
                value={scenario}
                onChange={(event) => setScenario(event.target.value as Scenario)}
                disabled={!!session.activeRun || busy}
              >
                <option value="chat">对话</option>
                <option value="tool">工具审批</option>
                <option value="question">提问</option>
                <option value="plan">计划</option>
                <option value="error">上游错误</option>
              </select>
            </label>
          ) : (
            <PermissionMenu
              mode={session.permissionMode}
              disabled={controlsDisabled}
              change={(permissionMode) => void configure({ permissionMode })}
            />
          )}
          {!codex && <span className="toolbar-space" />}
          {native && !codex && (
            <ComposerControls
              key={session.id}
              model={session.model}
              effort={session.effort}
              capabilities={capabilities}
              nativeSession={nativeSession}
              metrics={metrics}
              quota={quota}
              openAccount={openAccount}
              disabled={controlsDisabled}
              configure={configure}
              refresh={refresh}
              refreshing={refreshing}
              canRefreshModels={canRefreshModels}
            />
          )}
          {session.activeRun &&
            session.activeRun.waiting !== 'background' &&
            session.activeRun.surface !== 'terminal' && (
              <IconButton
                title="停止运行"
                className="stop-button"
                disabled={!connected || !ownsRun || busy}
                onClick={stop}
              >
                <Square />
              </IconButton>
            )}
          {resume && !draft.trim() ? (
            <IconButton title="接着上一轮继续" className="send-button" onClick={resume}>
              <Play />
            </IconButton>
          ) : (
            (!session.activeRun || native) && (
              <button
                type="submit"
                className="icon-button send-button"
                aria-label="发送消息"
                title={tooLong ? `消息超过 ${messageLimit} 字，删减后再发送` : '发送消息'}
                disabled={!draft.trim() || tooLong || inputDisabled}
              >
                <ArrowUp />
              </button>
            )
          )}
        </div>
      </form>
    </div>
  );
}
