#!/usr/bin/env bash
# Codex Desk Tunnel installer, adapted from sun168567/cc-desk-tunnel.
set -euo pipefail

REPO="${CC_DESK_TUNNEL_REPO:-zhenxiang-ding/codex-desk-tunnel}"
REF="${CC_DESK_TUNNEL_REF:-refs/tags/v0.1.5}"
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

  local packages=() tool compose_package=docker-compose-v2
  for tool in curl tar openssl git; do
    command -v "$tool" >/dev/null || packages+=("$tool")
  done
  command -v sha256sum >/dev/null || packages+=(coreutils)
  command -v docker >/dev/null || packages+=(docker.io)
  if ! docker compose version >/dev/null 2>&1; then
    # Keep the existing Engine provider when installing its Compose plugin.
    if command -v dpkg-query >/dev/null && dpkg-query -W -f='${db:Status-Status}' docker-ce 2>/dev/null | grep -qx installed; then
      compose_package=docker-compose-plugin
    fi
    packages+=("$compose_package")
  fi
  if ((${#packages[@]})); then
    [[ "$id" = ubuntu ]] || fail "请先安装依赖：${packages[*]}"
    echo "将通过 apt 安装缺少的依赖：${packages[*]}"
    confirm "安装以上依赖并继续？" || exit 0
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-remove "${packages[@]}"
  fi
  if ! docker info >/dev/null 2>&1; then
    confirm "启动 Docker 服务并设置开机启动？" || exit 0
    systemctl enable --now docker
    docker info >/dev/null || fail "Docker 启动失败，请检查 systemctl status docker。"
  fi

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
      git -C "$TARGET" fetch origin "$REF"
      git -C "$TARGET" merge-base --is-ancestor HEAD FETCH_HEAD || fail "本地有独立提交，请手动更新。"
      confirm "更新 ${TARGET}，使用新源码重新部署？" || exit 0
      git -C "$TARGET" merge --ff-only FETCH_HEAD
      if [[ "$1" = setup && -f "${PROXY_DEPLOY_CONFIG:-$TARGET/.local/docker.env}" ]]; then set -- upgrade; fi
    else
      echo "将从 $url 拉取 ${REF##*/} 到 ${TARGET}。连接期间，VPS 可通过 SSH 以你的用户身份操作本机项目。"
      confirm "继续安装？" || exit 0
      git clone --branch "${REF##*/}" --single-branch -- "$url" "$TARGET"
      if [[ -z "$(git -C "$TARGET" branch --show-current)" ]]; then
        git -C "$TARGET" switch -c main
      fi
    fi
    root="$TARGET"
  fi

  bash "$root/deploy/manage.sh" "$@"
  if [[ "$1" = setup && -t 0 ]]; then
    if confirm "现在登录 Codex？已登录或想稍后登录可输入 n"; then
      bash "$root/deploy/manage.sh" login || echo "服务已部署，稍后可执行 sudo codex-desk-tunnel login 重试。"
    fi
  fi
  if [[ "$1" = init ]]; then
    echo "启动服务：sudo codex-desk-tunnel up"
  else
    echo "Windows 客户端：https://github.com/$REPO/releases/latest"
  fi
  echo "客户端请使用部署汇总列出的服务地址和端口。"
}
main "$@"
