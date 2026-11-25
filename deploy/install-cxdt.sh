#!/bin/sh
# Installs cxdt, the terminal client of Codex Desk Tunnel, for the current user on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/zhenxiang-ding/codex-desk-tunnel/main/deploy/install-cxdt.sh | sh
#
# It downloads the package of the newest release for this system, checks it against the release's SHA256SUMS and puts
# it in place with the install script the package carries. No root is needed. CXDT_VERSION=0.3.20 takes that release
# instead, the one of the service; CXDT_DOWNLOAD_ONLY=1 only unpacks the checked package into the current directory.
set -eu
repository=zhenxiang-ding/codex-desk-tunnel
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) system=mac-arm64 ;;
  Darwin-x86_64) system=mac-x64 ;;
  Linux-x86_64 | Linux-amd64) system=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) system=linux-arm64 ;;
  *)
    echo "没有这个系统（$(uname -s) $(uname -m)）的 cxdt 包。Windows 上请在 PowerShell 里运行 install-cxdt.ps1。" >&2
    exit 1
    ;;
esac
version=${CXDT_VERSION:-}
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$repository/releases/latest" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  if [ -z "$version" ]; then
    echo "读不到最新的版本号；可以用 CXDT_VERSION 指定版本，例如 CXDT_VERSION=0.3.20。" >&2
    exit 1
  fi
fi
version=${version#codex-}
version=${version#v}
name="cxdt-$version-$system.tar.gz"
base="https://github.com/$repository/releases/download/codex-v$version"
folder=$(mktemp -d)
trap 'rm -rf "$folder"' EXIT
echo "正在下载 cxdt $version ……"
curl -fsSL -o "$folder/$name" "$base/$name"
curl -fsSL -o "$folder/SHA256SUMS" "$base/SHA256SUMS"
expected=$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1; exit }' "$folder/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "$version 的校验清单里没有 ${name}。" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$folder/$name" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$folder/$name" | cut -d ' ' -f 1)
fi
if [ "$actual" != "$expected" ]; then
  echo "下载的 $name 校验不符，没有安装。" >&2
  exit 1
fi
if [ -n "${CXDT_DOWNLOAD_ONLY:-}" ]; then
  tar -xzf "$folder/$name" -C .
  echo "已校验并解压到 $(pwd)/cxdt，没有安装。"
  exit 0
fi
tar -xzf "$folder/$name" -C "$folder"
sh "$folder/cxdt/install.sh"