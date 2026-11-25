cxdt：在自己的终端里打开 VPS 上的 Codex，与图形客户端共用会话。

安装
  Windows：在这个文件夹里运行  powershell -ExecutionPolicy Bypass -File install.ps1
  macOS、Linux：在这个文件夹里运行  ./install.sh
  不安装也可以直接运行这里的 cxdt.cmd（Windows）或 bin/cxdt。

开始
  cxdt login          登录服务端（地址和证书指纹默认取自图形客户端）
  cd 你的项目目录
  cxdt                接着这个项目最近的会话；没有就新建
  cxdt -r             从这个项目的会话里选一个
  cxdt --help         全部命令

cxdt 的版本须与服务端相同。cxdt upgrade 升级服务端，再把 cxdt 换成与服务端相同的版本。
卸载：删除安装目录（Windows 为 %LOCALAPPDATA%\Programs\cxdt，并从用户 PATH 去掉它；
macOS、Linux 为 ~/.local/share/cxdt 与 ~/.local/bin/cxdt，以及 shell 配置文件里标着 # cxdt 的一行）。设置与保存的登录在 %APPDATA%\cxdt（Windows）、
~/Library/Application Support/cxdt（macOS）或 ~/.config/cxdt（Linux）。
