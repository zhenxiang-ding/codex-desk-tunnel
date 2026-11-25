import {
  BookOpen,
  Cable,
  Folder,
  MessagesSquare,
  ShieldCheck,
  SlidersHorizontal,
  SquareTerminal,
  Gauge,
  RefreshCw,
  Keyboard,
  Settings,
} from 'lucide-react';
import type { Article, Block } from './help-content.ts';
const p = (text: string): Block => ({ kind: 'p', text });
const link = (section: 'account' | 'claude' | 'connection' | 'about', label: string): Block => ({
  kind: 'actions',
  items: [{ label, target: { settings: section } }],
});
export const codexArticles: Article[] = [
  {
    id: 'first-steps',
    group: 'start',
    title: '连接 VPS 并开始对话',
    icon: BookOpen,
    lead: '先连接隧道服务，再登录 VPS 上的 Codex。',
    blocks: [
      p(
        '在 Windows 添加服务，填写安装脚本输出的 WSS 地址和服务凭据。使用自签证书时，同步填写证书指纹。',
      ),
      p(
        '打开“账号与额度”，点“用设备码登录 Codex”。在本机浏览器的 OpenAI 授权页输入设备码，完成后回到桌面。',
      ),
      p('在侧栏添加本机项目，新建会话，在输入框中发送任务。'),
      link('account', '打开账号与额度'),
    ],
  },
  {
    id: 'how-it-works',
    group: 'start',
    title: 'SSH 如何访问本机',
    icon: Cable,
    lead: 'Windows 主动连接 VPS，Codex 在 VPS 上通过会话专用 SSH 通道访问项目。',
    blocks: [
      p(
        '连接时客户端会在本机生成临时 Ed25519 密钥并启动回环 SSH 服务，断开时清理。会话里的 ssh device hostname 可用于核对设备。',
      ),
      p(
        '从 OpenAI 桌面端直连 VPS 宿主机时，使用 Windows 上单独生成的 VPS 登录私钥。生成和登记步骤可在隧道客户端连接页展开查看。',
      ),
    ],
  },
  {
    id: 'ssh-login',
    group: 'start',
    icon: Cable,
    title: '从本机直接 SSH 登录 VPS',
    lead: '需要用 OpenAI 桌面端或系统终端登录 VPS 时，可使用单独的本机密钥。',
    blocks: [
      p(
        '在 Windows 登录页展开“在本机生成 SSH 密钥”，复制 PowerShell 命令，生成 codex_vps。将 .pub 文件中的公钥追加到 VPS 登录用户的 ~/.ssh/authorized_keys。',
      ),
      p(
        '在 OpenAI 桌面端添加 SSH 连接，显示名称可自定。主机名填 VPS 用户名@主机地址，SSH 端口填 VPS 的 SSH 端口（通常为 22）。选择“身份文件”，填写本机 codex_vps 私钥的完整路径并保存。',
      ),
      p(
        'Desk Tunnel 连接页使用安装脚本输出的 WSS 服务地址；每次连接时会单独建立用于访问本机项目的 SSH 通道。',
      ),
    ],
  },
  {
    id: 'projects',
    group: 'daily',
    title: '选择项目和分支',
    icon: Folder,
    lead: '输入框上方显示当前项目和可读取的本机 Git 分支。',
    blocks: [
      p(
        '点项目名可以选择另一个项目或文件夹。下一轮使用新目录，已有消息和 Codex 线程会保留。分支标签显示当前检出的分支。',
      ),
    ],
  },
  {
    id: 'sessions',
    group: 'daily',
    title: '聊天、工具与续聊',
    icon: MessagesSquare,
    lead: '消息、命令、输出和审批都在同一条对话里。',
    blocks: [
      p('Enter 发送，Shift+Enter 换行。点加号添加文件，Codex 会通过项目设备访问提供的文件路径。'),
      p(
        '展开工具记录可查看命令和结果。点停止可以中断本轮；再次打开同一会话，下一条消息继续使用该线程。',
      ),
    ],
  },
  {
    id: 'approval',
    group: 'daily',
    title: '审批模式',
    icon: ShieldCheck,
    lead: '点输入框左下角的审批按钮，选择当前会话的审批方式。',
    blocks: [
      p(
        '按需询问会把需要批准的操作显示在对话里。非受信命令先询问，由 Codex 判断哪些命令受信。选择自动审查时由 Codex 审查审批请求。直接拒绝提权会拒绝需要提升权限的操作。',
      ),
      p(
        '选择“跟随 CLI 设置”可恢复 VPS 的默认规则。沙箱限制作用于 VPS；通过 SSH 操作本机时，文件权限由本机登录用户决定。',
      ),
      link('claude', '打开 CLI 设置'),
    ],
  },
  {
    id: 'models',
    group: 'daily',
    title: '模型与推理强度',
    icon: SlidersHorizontal,
    lead: '输入框右下角显示当前会话的模型和推理强度。',
    blocks: [
      p(
        '点模型按钮打开推理强度面板，再点模型名查看 VPS 上 Codex 返回的模型列表。点刷新可重新读取。',
      ),
      p(
        '强度选项由所选模型提供。选择默认模型或恢复默认推理强度，下一轮会采用 CLI 或模型的默认值。',
      ),
    ],
  },
  {
    id: 'context',
    group: 'daily',
    title: '上下文与压缩',
    icon: Gauge,
    lead: '输入框的圆环显示最近一次 Codex 上报的 token 数与模型上下文窗口。',
    blocks: [
      p('将鼠标移到圆环上可查看读数和剩余比例。首轮返回用量前，窗口暂时没有读数。'),
      p('在 CLI 设置的“上下文与记忆”中可调整自动压缩窗口，留空使用模型默认值。'),
      link('claude', '打开上下文与记忆设置'),
    ],
  },
  {
    id: 'terminal',
    group: 'agents',
    title: '桌面终端与 cxdt',
    icon: SquareTerminal,
    lead: '需要 Codex 原生终端时，从会话菜单打开。',
    blocks: [
      p(
        '选择“打开 Codex 终端”在窗口内运行，或选择“用 cxdt 打开”进入系统终端。结束终端后可回到桌面输入框继续。',
      ),
      { kind: 'code', label: 'Windows CMD', text: 'cxdt login\ncxdt' },
    ],
  },
  {
    id: 'quota',
    group: 'account',
    title: '账号与订阅额度',
    icon: Gauge,
    lead: '登录方式、套餐和订阅窗口来自 VPS 上的 Codex CLI。',
    blocks: [
      p(
        '订阅用量显示服务端返回的已用与剩余比例、重置时间。可手动刷新，或启用运行中每分钟读取。部分登录方式不提供订阅窗口。',
      ),
      p('点“用量记录”可查看此服务已保留会话的 token 记录，其中缓存输入已包含在输入 token 内。'),
      link('account', '打开账号与额度'),
    ],
  },
  {
    id: 'settings',
    group: 'settings',
    title: 'Codex CLI 设置',
    icon: Settings,
    lead: '这里修改 VPS 上的 Codex 配置；会话工具栏只覆盖所选会话。',
    blocks: [
      p(
        '在上下文与记忆、模型与推理、行为、权限中修改需要的项目后保存。选择 CLI 默认可以移除该项覆盖。',
      ),
      p('自动记忆可分别控制记忆生成和使用。网页搜索、推理摘要和服务档位的可用性取决于模型及账号。'),
      link('claude', '打开 CLI 设置'),
    ],
  },
  {
    id: 'shortcuts',
    group: 'settings',
    title: '键盘快捷键',
    icon: Keyboard,
    lead: '当前设备的快捷键可在设置中调整。',
    blocks: [{ kind: 'keys' }],
  },
  {
    id: 'updates',
    group: 'care',
    title: '升级与连接排查',
    icon: RefreshCw,
    lead: 'Windows 客户端与 VPS 服务端应使用配套版本。',
    blocks: [
      p(
        '在设置的“关于与更新”检查并升级服务端。如果无法进入会话，在登录页填写服务地址、指纹和凭据，点“检查服务端更新”，再确认升级。提示需要更新镜像时，在 VPS 运行 README 的一键安装命令。',
      ),
      p(
        '如果 VPS 能连接但项目无法访问，先检查项目所在电脑是否在线，再核对服务地址、证书指纹和 SSH 通道状态。',
      ),
    ],
  },
];
