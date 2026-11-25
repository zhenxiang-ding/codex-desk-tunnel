# Codex Desk Tunnel

Codex CLI 在 Ubuntu VPS 上运行，通过 SSH 读写你选定的 Windows 项目。Windows 主动连接 VPS，项目文件留在本机。首次使用先部署 VPS，再安装 Windows 客户端。

## 1. 在 Ubuntu 24.04 VPS 安装服务端

在 Windows 的 CMD 或 PowerShell 里登录 VPS。把 `ubuntu` 和 `VPS_IP` 换成你的用户名和公网 IP。下面的 Linux 命令都在登录后的同一个终端执行。

```console
ssh -t ubuntu@VPS_IP
```

全新的 Ubuntu 24.04 可用系统软件源安装依赖。已有 Docker Engine 和 Compose v2 的机器可用 `sudo docker info` 和 `docker compose version` 检查，然后直接运行安装脚本。

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates openssl docker.io docker-compose-v2
sudo systemctl enable --now docker
```

从本仓库下载并运行服务端安装脚本：

```bash
cd ~
curl -fsSLo codex-desk-install.sh https://raw.githubusercontent.com/zhenxiang-ding/codex-desk-tunnel/main/deploy/install.sh && sudo bash codex-desk-install.sh
```

按提示填写 Windows 能访问的公网 IP 或域名。只有 IP 时，入口选 **1（自签证书 + 指纹）**。默认直连端口是 **TCP 8788**，在云服务商的安全组和启用的主机防火墙中放行该端口。已有 nginx 反代时按部署汇总中列出的端口配置。

脚本会把源码拉到 `/opt/codex-desk-tunnel`，在 VPS 构建包含 Codex CLI 的镜像。完成后记下**服务地址、证书指纹、服务凭据**，Windows 连接时要用。服务凭据请保密。随后登录容器里的 Codex：

```bash
cd /opt/codex-desk-tunnel
sudo docker compose --env-file .local/docker.env -f deploy/compose.yml exec proxy codex login --device-auth
sudo docker compose --env-file .local/docker.env -f deploy/compose.yml exec proxy codex login status
```

第一条登录命令会显示验证网址和设备码。用浏览器完成授权，再运行最后一条检查登录状态。

## 2. 在 Windows 本机安装客户端

### 用桌面客户端连接

1. 在 Windows 10/11 x64 上下载并运行 [CC Desk Tunnel 0.3.20 安装包（.exe）](https://github.com/sun168567/cc-desk-tunnel/releases/download/v0.3.20/CC-Desk-Tunnel-Setup-0.3.20-x64.exe)。这是与本项目兼容的原作者客户端，自带 OpenSSH、PowerShell 和 `ccdt`。已经装过这个版本可以直接打开。
2. 添加服务，粘贴 VPS 显示的服务地址和服务凭据。选了自签证书时，也填入对应的证书指纹。
3. 连接后添加本机项目文件夹，例如 `E:\Codex_default`。创建或选中该项目的会话，右键选择 **用 ccdt 打开**。弹出的系统终端里运行的是 VPS 上的 Codex。桌面主聊天框仍使用 Claude。
4. 在 Codex 终端输入“请通过 SSH 列出当前 Windows 项目的顶层文件，并报告项目路径”。核对结果是否与本机目录一致。

### 用 CMD 或 PowerShell 连接

桌面安装包已经包含 `ccdt`。安装后新开一个 **CMD**，在你要操作的项目目录里运行：

```bat
cd /d E:\Codex_default
ccdt login
ccdt
```

登录时选刚才保存的 VPS 服务，按提示输入服务凭据。如果从 PowerShell 进入项目，第一行用 `Set-Location E:\Codex_default`。

只用命令行时，也可以单独安装 `ccdt`。在 Windows **PowerShell** 运行以下两行。脚本会下载原作者的 0.3.20 客户端并核对发布包的 SHA-256。

```powershell
$env:CCDT_VERSION = '0.3.20'
irm https://raw.githubusercontent.com/sun168567/cc-desk-tunnel/v0.3.20/deploy/install-ccdt.ps1 | iex
```

新开 CMD，按上面的命令进入项目并执行 `ccdt login`。没有保存过服务时，按提示输入 VPS 显示的连接信息，再运行 `ccdt`。

## 从源码构建

如果想直接在桌面窗口中使用 **打开 Codex 终端**，可以运行本仓库的客户端。在 Windows x64 上准备 Git、Node.js 24 和 PowerShell 7，首次获取源码时运行：

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
- **升级服务端**：回到 VPS 用户的家目录，重新运行第 1 节的下载安装命令。脚本更新源码，沿用已有配置重建容器。
- **继续对话**：在本机打开原来的 Desk 会话，再在 Codex 终端用 `/resume` 选择历史。
- **遇到 `stdin is not a terminal`**：在 Windows Terminal 或 CMD 中按第 1 节用 `ssh -t` 登录 VPS，再逐条执行交互命令。可先在 VPS 执行 `tty`，确认输出是 `/dev/pts/…` 等终端设备。启动本机 `ccdt` 时也要使用交互终端。

## 致谢与许可

感谢原作者 [sun168567](https://github.com/sun168567) 和 [CC Desk Tunnel](https://github.com/sun168567/cc-desk-tunnel) 的贡献者。本项目基于上游 0.3.20，复用桌面端、设备隧道、SSH 和终端转发，并接入 Codex CLI。项目保留 [Apache-2.0 许可证](LICENSE) 和[原始版权声明](NOTICE)。原版的说明、截图和文档见[上游 README](https://github.com/sun168567/cc-desk-tunnel/blob/v0.3.20/README.md)。
