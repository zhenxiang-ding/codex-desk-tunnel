# Codex Desk Tunnel

Codex CLI 在 Ubuntu VPS 上运行，通过 SSH 读写你选定的 Windows 项目。Windows 主动连接 VPS，项目文件留在本机。首次使用先部署 VPS，再安装 Windows 客户端。

## 1. 在 Ubuntu 24.04 VPS 安装服务端

在 Windows 的 CMD 或 PowerShell 里登录 VPS。把 `ubuntu` 和 `VPS_IP` 换成你的用户名和公网 IP。下面的 Linux 命令都在登录后的同一个终端执行。

```console
ssh -t ubuntu@VPS_IP
```

在 VPS 的 SSH 终端粘贴这一行（需要 `curl` 和 root 或 sudo 权限）：

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/zhenxiang-ding/codex-desk-tunnel/main/deploy/install.sh)"
```

脚本会检查依赖；全新 Ubuntu 缺少 Docker 或 Compose 时，按回车同意安装，再按回车启动 Docker。部署向导会显示检测到的 IP；确认它是 Windows 能访问的公网地址，若有误就输入正确的 IP 或域名。其余提示回车即可使用自签证书、TCP **8788**、默认数据目录和随机服务凭据。首次部署会在 VPS 上构建包含 Codex CLI 的镜像。

部署完成后保存**服务地址、证书指纹、服务凭据**，在云安全组和已启用的主机防火墙中放行部署汇总列出的端口。最后一个提示回车开始 Codex 登录，在浏览器完成设备码授权。跳过登录后可在 VPS 运行 `sudo codex-desk-tunnel login`。

[GitHub Releases 下载页](https://github.com/zhenxiang-ding/codex-desk-tunnel/releases/latest) 提供 Windows 桌面安装包、命令行客户端、VPS 服务端包和 SHA-256 校验清单。手工部署时，解压服务端包到独立目录，进入该目录执行 `sudo bash deploy/install.sh`。

## 2. 在 Windows 本机安装客户端

### 用桌面客户端连接

1. 下载并运行 [Codex Desk Tunnel Windows x64 安装包（.exe）](https://github.com/zhenxiang-ding/codex-desk-tunnel/releases/download/codex-v0.1.0/Codex-Desk-Tunnel-Setup-0.3.20-x64.exe)，自带 OpenSSH、PowerShell 和 `ccdt`。
2. 添加服务，粘贴 VPS 显示的服务地址和服务凭据。选了自签证书时，也填入对应的证书指纹。
3. 连接后添加本机项目文件夹。创建或选中该项目的会话，在会话菜单选择 **打开 Codex 终端**，即可在桌面窗口内使用 VPS 上的 Codex。使用原作者的 0.3.20 客户端时，选择 **用 ccdt 打开** 在系统终端中使用。
4. 在 Codex 终端输入“请通过 SSH 列出当前 Windows 项目的顶层文件，并报告项目路径”。核对结果是否与本机目录一致。

### 用 CMD 或 PowerShell 连接

桌面安装包已经包含 `ccdt`。安装后新开一个 **CMD**，在你要操作的项目目录里运行：

```bat
cd /d E:\Codex_default
ccdt login
ccdt
```

登录时选刚才保存的 VPS 服务，按提示输入服务凭据。如果从 PowerShell 进入项目，第一行用 `Set-Location E:\Codex_default`。

只用命令行时，从发布页下载 [Windows x64 终端客户端 ZIP](https://github.com/zhenxiang-ding/codex-desk-tunnel/releases/download/codex-v0.1.0/ccdt-0.3.20-windows-x64.zip)，解压后在 `ccdt` 目录打开 PowerShell 并运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

新开 CMD，按上面的命令进入项目并执行 `ccdt login`。没有保存过服务时，按提示输入 VPS 显示的连接信息，再运行 `ccdt`。

## 从源码构建

自行编译时，在 Windows x64 上准备 Git、Node.js 24 和 PowerShell 7，首次获取源码时运行：

```powershell
git clone https://github.com/zhenxiang-ding/codex-desk-tunnel.git
cd codex-desk-tunnel
```

已有本仓库的用户直接进入仓库目录。从该目录运行：

```powershell
npm.cmd ci
npm.cmd run prepare:windows:package
npm.cmd run setup:desktop
npm.cmd run build
npm.cmd run desktop
```

连接 VPS 后，在会话菜单选择 **打开 Codex 终端**。需要生成 Windows 安装包时，在同一仓库运行 `npm.cmd run package:windows`，产物位于 `artifacts/windows/`。

## 日常使用

- **查看服务**：在 VPS 运行 `sudo codex-desk-tunnel status`。需要重新查看客户端连接信息时运行 `sudo codex-desk-tunnel summary`。
- **升级服务端**：在 VPS 终端重新运行第 1 节的一键安装命令。脚本更新源码，沿用已有配置重建容器。
- **继续对话**：在本机打开原来的 Desk 会话，再在 Codex 终端用 `/resume` 选择历史。
- **遇到 `stdin is not a terminal`**：在 Windows Terminal 或 CMD 中按第 1 节用 `ssh -t` 登录 VPS，再逐条执行交互命令。可先在 VPS 执行 `tty`，确认输出是 `/dev/pts/…` 等终端设备。启动本机 `ccdt` 时也要使用交互终端。

## 致谢与许可

感谢原作者 [sun168567](https://github.com/sun168567) 和 [CC Desk Tunnel](https://github.com/sun168567/cc-desk-tunnel) 的贡献者。本项目基于上游 0.3.20，复用桌面端、设备隧道、SSH 和终端转发，并接入 Codex CLI。项目保留 [Apache-2.0 许可证](LICENSE) 和[原始版权声明](NOTICE)。原版的说明、截图和文档见[上游 README](https://github.com/sun168567/cc-desk-tunnel/blob/v0.3.20/README.md)。
