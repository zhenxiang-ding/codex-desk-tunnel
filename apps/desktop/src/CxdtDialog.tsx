import { ExternalLink } from 'lucide-react';
import { CopyButton } from './copy.tsx';
import { project } from './project.tsx';
import { Modal } from './ui.tsx';

const script = `https://raw.githubusercontent.com/zhenxiang-ding/codex-desk-tunnel/main/deploy/install-cxdt`;

// The one line that installs cxdt of `version`, the service's, on this system; see docs/cli.md.
export function installCommand(platform: string, version: string) {
  return platform === 'win32'
    ? `$env:CXDT_VERSION = '${version}'; irm ${script}.ps1 | iex`
    : `curl -fsSL ${script}.sh | CXDT_VERSION=${version} sh`;
}

// Opening a session in cxdt found it not installed, or `installed` of another release than the service's.
export function CxdtDialog({
  installed,
  version,
  close,
}: {
  installed?: string;
  version: string;
  close: () => void;
}) {
  const platform = window.desktop?.platform ?? '';
  const command = installCommand(platform, version);
  return (
    <Modal title={installed ? '更新 cxdt' : '安装 cxdt'} onClose={close}>
      <div className="dialog-form cxdt-dialog">
        <p>
          {installed
            ? `这台电脑上的 cxdt 是 ${installed}，要与服务端同为 ${version} 才能连接。`
            : '用 cxdt 打开需要先安装终端客户端 cxdt：在系统终端打开当前项目的远程会话。'}
        </p>
        <p className="muted">
          在{platform === 'win32' ? ' PowerShell ' : '终端'}里运行下面这行，装好后再选一次“在 cxdt
          中打开”：
        </p>
        <div className="code-block">
          <pre>
            <code>{command}</code>
          </pre>
          <span className="code-actions">
            <CopyButton text={command} label="复制命令" />
          </span>
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              void window.desktop?.openExternal(`${project.url}/blob/main/docs/cli.md`)
            }
          >
            <ExternalLink />
            安装说明
          </button>
          <button type="button" className="button primary" onClick={close}>
            知道了
          </button>
        </div>
      </div>
    </Modal>
  );
}
