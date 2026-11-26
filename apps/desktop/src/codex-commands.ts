// Public commands of the Linux release pinned in scripts/install-linux.sh.
// The native picker handles account/model service tiers, feature gates and newer CLI versions.
const descriptions: Record<string, string> = {
  model: '选择模型和推理强度',
  presets: '运行或保存常用提示与命令',
  daybreak: '切换 Daybreak',
  ide: '附加 IDE 当前上下文',
  permissions: '选择当前会话的审批模式',
  keymap: '编辑终端快捷键',
  vim: '切换 Vim 输入模式',
  experimental: '选择实验性功能',
  approve: '审查最近一次自动审批拒绝的重试',
  memories: '配置记忆的使用和生成',
  skills: '选择本次对话使用的技能',
  import: '导入 Claude Code 工作环境',
  hooks: '管理生命周期钩子',
  review: '审查改动',
  rename: '重命名会话',
  new: '开始新会话',
  archive: '归档会话',
  delete: '删除会话',
  resume: '选择历史会话',
  fork: '从当前对话分支',
  worktree: '在新工作树继续',
  init: '生成项目说明 AGENTS.md',
  compact: '压缩上下文',
  config: '查看 Codex 设置',
  recap: '总结当前对话',
  plan: '进入计划模式',
  voice: '语音模式及设置',
  goal: '设置或查看目标',
  agents: '打开代理管理界面',
  side: '开始旁支对话',
  btw: '开始旁支对话',
  copy: '复制回复',
  export: '导出 Markdown 对话记录',
  raw: '切换原始文本显示',
  tui: '选择终端界面模式',
  diff: '查看工作目录的 Git 差异',
  mention: '在输入中引用文件',
  status: '查看会话状态及用量',
  daemon: '管理 Codex 后台服务',
  rc: '管理远程控制',
  warnings: '查看诊断警告',
  cd: '切换工作目录',
  pwd: '显示工作目录',
  usage: '查看账户额度与重置选项',
  'debug-config': '查看有效配置的来源',
  title: '配置终端标题',
  statusline: '配置状态栏',
  theme: '选择高亮主题',
  pets: '选择终端宠物',
  mcp: '查看 MCP 工具和登录状态',
  apps: '管理应用',
  plugins: '浏览插件',
  logout: '退出 Codex 账号',
  quit: '退出原生终端',
  exit: '退出原生终端',
  feedback: '提交反馈或保存日志',
  ps: '列出后台终端',
  stop: '停止后台终端',
  clear: '清空终端并开始新会话',
  subagents: '切换子代理',
};
export const codexCommandPrefix = /^\/(?:[a-z][\w-]*)?$/i;
const aliases: Record<string, string> = { remote: 'rc', cwd: 'pwd', pet: 'pets', clean: 'stop' };
export function codexCommands(query: string, tiers: { name: string; description?: string }[] = []) {
  const entries = Object.entries(descriptions);
  const tiersByName = new Map<string, string>();
  for (const tier of tiers) {
    const name = tier.name.toLowerCase();
    if (/^[a-z][\w-]*$/.test(name) && !Object.hasOwn(descriptions, name))
      tiersByName.set(name, tier.description || '切换模型服务档位');
  }
  entries.splice(1, 0, ...tiersByName.entries());
  return entries
    .filter(
      ([name]) =>
        name.startsWith(query) ||
        Object.entries(aliases).some(
          ([alias, canonical]) => canonical === name && alias.startsWith(query),
        ),
    )
    .map(([name, description]) => ({ name, description }));
}
// A single CLI command, never a path or a multiline paste. Add-on/tier commands are resolved by the CLI.
export function parseCodexCommand(text: string) {
  if (/[\x00-\x1f\x7f]/u.test(text)) return null;
  const match = /^\/([a-z][\w-]*)(?: +(.+?))? *$/i.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { name: aliases[name] ?? name, args: match[2] ?? '', text: text.trimEnd() };
}
