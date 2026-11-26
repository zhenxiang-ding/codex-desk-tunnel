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
const link = (
  section: 'context' | 'instructions' | 'web' | 'account' | 'claude' | 'connection' | 'about',
  label: string,
): Block => ({
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
        '从 OpenAI 桌面端直连 VPS 宿主机时，使用 Windows 上单独生成的 VPS 登录私钥。生成和登记步骤见项目 README。',
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
        'Ask for approval 由你处理审批。默认的 Approve for me 让 Codex 审查符合条件的请求。两者均使用工作区沙箱。Read only 使用只读沙箱，Full access 允许使用 VPS 服务账号的完整访问权限。',
      ),
      p(
        '选择“恢复服务端默认”可重新使用 VPS 的权限设置。沙箱限制作用于 VPS；通过 SSH 操作本机时，文件权限由本机登录用户决定。',
      ),
      p(
        '在全局说明中编辑服务账号的 AGENTS.md。浏览器访问页显示此服务的 HTTPS 地址和已配置的入口路径。',
      ),
      link('instructions', '打开全局说明'),
      link('web', '打开浏览器访问'),
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
      p('在“上下文与缓存”可单独设置空闲多久后压缩，以及触发压缩所需的最小上下文。'),
      link('context', '打开上下文与缓存'),
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
      p(
        '点“调用日志”可按额度周期、日期和模型筛选 VPS 桌面对话的调用，查看 token 构成、缓存命中率和逐次明细。',
      ),
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
        '在上下文与记忆、模型与推理、行为、权限中选择后自动保存；文本与数字在回车或离开输入框时保存。',
      ),
      p(
        '桌面对话默认开启自动记忆，VPS 已配置的开关优先。记忆生成和读取可以分别设置。网页搜索、推理摘要和服务档位的可用性取决于模型及账号。',
      ),
      p(
        '在全局说明中编辑服务账号的 AGENTS.md。浏览器访问页显示此服务的 HTTPS 地址和已配置的入口路径。',
      ),
      link('instructions', '打开全局说明'),
      link('web', '打开浏览器访问'),
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
        '在设置的“关于与更新”检查并升级服务端。协议不兼容时，连接被拒后会显示对应的升级操作。提示需要更新镜像时，在 VPS 运行 README 的一键安装命令。',
      ),
      p(
        '如果 VPS 能连接但项目无法访问，先检查项目所在电脑是否在线，再核对服务地址、证书指纹和 SSH 通道状态。',
      ),
    ],
  },
];
