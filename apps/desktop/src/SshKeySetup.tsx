import { CopyButton } from './copy.tsx';
import { project } from './project.tsx';

const generateKey = String.raw`$key = Join-Path $env:USERPROFILE '.ssh\codex_vps'
New-Item -ItemType Directory -Force (Split-Path $key) | Out-Null
if (!(Test-Path $key) -and !(Test-Path "$key.pub")) { ssh-keygen -t ed25519 -f $key }
Get-Content "$key.pub"`;

export function SshKeySetup() {
  if (window.desktop?.platform !== 'win32') return null;
  return (
    <details className="ssh-setup">
      <summary>在本机生成 SSH 密钥</summary>
      <p>
        通过 Desk Tunnel 操作 Windows 项目时，连接按钮会在本机生成本次隧道的 Ed25519
        密钥。断开后客户端会清理它。
      </p>
      <p>
        用 OpenSSH 或 OpenAI 桌面端从 Windows 直连 VPS 时，可在本机 PowerShell
        创建专用身份文件。已有能登录 VPS 的密钥时可直接使用。
      </p>
      <pre>{generateKey}</pre>
      <CopyButton text={generateKey} label="复制本机生成密钥命令" />
      <p>
        将输出的 .pub 公钥追加到 VPS 登录用户的 ~/.ssh/authorized_keys。桌面端的“身份文件路径”填本机
        codex_vps 私钥的完整路径。
      </p>
      <button
        type="button"
        className="button"
        onClick={() => void window.desktop?.openExternal(project.url + '#windows-ssh-key')}
      >
        查看配置和验证命令
      </button>
    </details>
  );
}
