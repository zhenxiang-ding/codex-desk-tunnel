#!/usr/bin/env bash
# Codex Desk Tunnel installer, adapted from sun168567/cc-desk-tunnel.
set -euo pipefail

REPO="${CC_DESK_TUNNEL_REPO:-zhenxiang-ding/codex-desk-tunnel}"
REF="${CC_DESK_TUNNEL_REF:-refs/tags/v0.1.10}"
TARGET="${CC_DESK_TUNNEL_DIR:-/opt/codex-desk-tunnel}"
fail() { echo "错误：$*" >&2; exit 1; }
confirm() {
  local answer
  read -r -p "$1 [Y/n]: " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}
clone_release() {
  git clone --branch "${REF##*/}" --single-branch -- "$1" "$2"
  if [[ -z "$(git -C "$2" branch --show-current)" ]]; then
    git -C "$2" switch -c main
  fi
}
# Keep local source edits in place. Both checkouts use the same private deployment configuration,
# so the release's own management command can resume setup or update the existing Compose project.
create_managed_checkout() (
  local url="$1" original="$2" managed="$3" stage
  stage="$(mktemp -d -- "$managed.tmp.XXXXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  clone_release "$url" "$stage"
  mkdir -p -m 700 -- "$original/.local"
  ln -sT -- "$original/.local" "$stage/.local"
  printf '\n/.local\n' >> "$stage/.git/info/exclude"
  mv -Tn -- "$stage" "$managed"
  [[ ! -d "$stage" ]] || fail "$managed 已被占用，保留原目录。"
)
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
    local url="https://github.com/$REPO.git" managed changes
    if [[ -d "$TARGET/.git" ]]; then
      TARGET="$(cd -- "$TARGET" && pwd -P)"
      managed="$TARGET.managed"
      [[ "$(git -C "$TARGET" config --get remote.origin.url)" = "$url" && "$(git -C "$TARGET" branch --show-current)" = main ]] \
        || fail "$TARGET 需要是 $REPO 的 main 分支。"
      if [[ -d "$managed/.git" && -L "$managed/.local" && "$managed/.local" -ef "$TARGET/.local" ]]; then
        TARGET="$managed"
        [[ "$(git -C "$TARGET" config --get remote.origin.url)" = "$url" && "$(git -C "$TARGET" branch --show-current)" = main ]] \
          || fail "$TARGET 的仓库或分支已改变，请检查该托管目录。"
      fi
      changes="$(git -C "$TARGET" status --porcelain=v1 --untracked-files=normal)" || fail "无法读取 $TARGET 的 Git 状态。"
      if [[ -z "$changes" ]]; then
        git -C "$TARGET" fetch origin "$REF"
        git -C "$TARGET" merge-base --is-ancestor HEAD FETCH_HEAD || changes='本地提交与发布标签不同'
      fi
      if [[ -n "$changes" ]]; then
        printf '保留 %s 中的本地改动：\n%s\n' "$TARGET" "$changes"
        [[ "$TARGET" != "$managed" && ! -e "$managed" && ! -L "$managed" ]] || fail "托管目录 $managed 已有其他内容，请核对该目录。"
        confirm "从发布标签安装到 $managed 并沿用此 VPS 的部署配置？" || exit 0
        create_managed_checkout "$url" "$TARGET" "$managed"
        TARGET="$managed"
      else
        confirm "在 ${TARGET} 使用发布版本继续部署？" || exit 0
        git -C "$TARGET" merge --ff-only FETCH_HEAD
      fi
    else
      echo "将从 $url 拉取 ${REF##*/} 到 ${TARGET}。连接期间，VPS 可通过 SSH 以你的用户身份操作本机项目。"
      confirm "继续安装？" || exit 0
      clone_release "$url" "$TARGET"
    fi
    root="$TARGET"
    if [[ "$1" = setup && -f "${PROXY_DEPLOY_CONFIG:-$root/.local/docker.env}" ]]; then set -- upgrade; fi
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
