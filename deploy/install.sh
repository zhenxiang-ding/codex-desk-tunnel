#!/usr/bin/env bash
# Codex Desk Tunnel installer, adapted from sun168567/cc-desk-tunnel.
set -euo pipefail

REPO="${CC_DESK_TUNNEL_REPO:-zhenxiang-ding/codex-desk-tunnel}"
TARGET="${CC_DESK_TUNNEL_DIR:-/opt/codex-desk-tunnel}"
fail() { echo "错误：$*" >&2; exit 1; }
confirm() {
  local answer
  read -r -p "$1 [Y/n]: " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}
main() {
  # Without arguments the installer asks its questions, gets the image, starts and prints a summary.
  (($#)) || set -- setup
  [[ "$1" = init || "$1" = setup ]] || fail "参数只接受 setup（默认）或 init …；其余操作请用 deploy/manage.sh。"
  [[ "$(id -u)" = 0 ]] || fail "需要 root 权限，请在命令前加 sudo。"
  [[ "$(uname -s)" = Linux && "$(uname -m)" =~ ^(x86_64|aarch64)$ ]] || fail "目前只支持 x86_64（amd64）和 aarch64（arm64）的 Linux。"
  # Piped from curl, the script itself is on standard input; the questions need the terminal. Without one (a
  # script answering for itself), standard input stays as it is.
  if [[ ! -t 0 ]] && (exec < /dev/tty) 2>/dev/null; then exec < /dev/tty; fi
  local id=''
  [[ ! -r /etc/os-release ]] || id="$(. /etc/os-release && echo "${ID:-}")"
  [[ "$id" = ubuntu ]] || echo "提示：只在 Ubuntu 上验证过；其他发行版可以继续，遇到问题请参考部署手册。"

  # What is missing is reported together with how to install it; nothing is installed from here.
  local missing=() packages=() tool
  for tool in curl tar openssl sha256sum; do
    command -v "$tool" >/dev/null || { missing+=("$tool"); packages+=("$([[ "$tool" = sha256sum ]] && echo coreutils || echo "$tool")"); }
  done
  command -v docker >/dev/null || { missing+=("Docker Engine"); packages+=(docker.io); }
  docker compose version >/dev/null 2>&1 || { missing+=("Docker Compose v2"); packages+=(docker-compose-v2); }
  if ((${#missing[@]})); then
    echo "缺少以下组件：${missing[*]}" >&2
    if [[ "$id" = ubuntu ]]; then
      echo "请先执行下面的命令安装，然后重新运行本脚本：" >&2
      echo "  sudo apt-get update && sudo apt-get install -y ${packages[*]}" >&2
    else
      echo "请按发行版的方式安装后重新运行本脚本。Docker 的官方安装说明：https://docs.docker.com/engine/install/" >&2
    fi
    exit 1
  fi
  docker info >/dev/null 2>&1 || {
    echo "Docker 已安装但没有运行。请先执行下面的命令，然后重新运行本脚本：" >&2
    echo "  sudo systemctl enable --now docker" >&2
    exit 1
  }

  # Run from an unpacked server archive or a checkout, that copy is used as it is.
  local self="${BASH_SOURCE[0]:-}" root=''
  if [[ "$self" = */install.sh || "$self" = install.sh ]] && [[ -f "$(dirname -- "$self")/manage.sh" ]]; then
    root="$(cd -- "$(dirname -- "$self")/.." && pwd)"
  else
    command -v git >/dev/null || fail "请先安装 Git：sudo apt-get install git"
    local url="https://github.com/$REPO.git"
    if [[ -d "$TARGET/.git" ]]; then
      [[ "$(git -C "$TARGET" config --get remote.origin.url)" = "$url" && "$(git -C "$TARGET" branch --show-current)" = main ]] \
        || fail "$TARGET 需要是 $REPO 的 main 分支。"
      [[ -z "$(git -C "$TARGET" status --porcelain)" ]] || fail "工作区有本地修改，请先保存。"
      git -C "$TARGET" fetch origin main
      git -C "$TARGET" merge-base --is-ancestor HEAD FETCH_HEAD || fail "本地有独立提交，请手动更新。"
      confirm "更新 ${TARGET}，使用新源码重新部署？" || exit 0
      git -C "$TARGET" merge --ff-only FETCH_HEAD
      if [[ "$1" = setup && -f "${PROXY_DEPLOY_CONFIG:-$TARGET/.local/docker.env}" ]]; then set -- upgrade; fi
    else
      echo "将从 $url 拉取 main 到 ${TARGET}。连接期间，VPS 可通过 SSH 以你的用户身份操作本机项目。"
      confirm "继续安装？" || exit 0
      git clone --branch main --single-branch -- "$url" "$TARGET"
    fi
    root="$TARGET"
  fi

  bash "$root/deploy/manage.sh" "$@"
  if [[ "$1" = init ]]; then
    echo "启动服务：sudo codex-desk-tunnel up"
  else
    echo "兼容的 Windows 客户端：https://github.com/sun168567/cc-desk-tunnel/releases/tag/v0.3.20"
  fi
  echo "本脚本没有修改防火墙、nginx 或 SSH 配置，也没有安装系统软件。"
}
main "$@"
