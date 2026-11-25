#!/bin/sh
# Installs cxdt from this folder for the current user: copies it to ~/.local/share/cxdt and links
# ~/.local/bin/cxdt to it. Running it again updates cxdt in place.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
target=${XDG_DATA_HOME:-$HOME/.local/share}/cxdt
if [ "$here" != "$target" ]; then
  rm -rf "$target"
  mkdir -p "$(dirname "$target")"
  cp -R "$here" "$target"
fi
# A package a browser downloaded on a Mac carries the mark of the download, which the files unpacked from it take on;
# it would have the system ask about, or refuse, the Node and the SSH library inside.
if [ "$(uname -s)" = Darwin ]; then xattr -dr com.apple.quarantine "$target" 2>/dev/null || true; fi
mkdir -p "$HOME/.local/bin"
# A desktop client that carries cxdt has made ~/.local/bin/cxdt its own (apps/desktop/electron/cxdt.mjs): that is the
# cxdt the terminal runs, updated with the client, and it stays so.
desktop=
current=$(readlink "$HOME/.local/bin/cxdt" 2>/dev/null || true)
case "$current" in
*/resources/cxdt/bin/cxdt) if [ -e "$current" ]; then desktop=$current; fi ;;
esac
if [ -n "$desktop" ]; then
  echo "cxdt 已安装到 ${target}。图形客户端自带的 cxdt（${desktop}）是 ~/.local/bin/cxdt，终端里用的是它，随图形客户端升级。"
else
  ln -sf "$target/bin/cxdt" "$HOME/.local/bin/cxdt"
  echo "cxdt 已安装到 ${target}，命令为 ~/.local/bin/cxdt。"
fi
# ~/.local/bin is not on the PATH everywhere, never on macOS by default: the line that puts it there goes once into
# the configuration file of the user's shell, marked as cxdt's, for every shell started from now on.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) echo "运行 cxdt login 登录服务端。" ;;
  *)
    line='export PATH="$HOME/.local/bin:$PATH"'
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
      *) rc="$HOME/.profile" ;;
    esac
    if ! grep -qsF "$line" "$rc"; then
      printf '\n# cxdt\n%s\n' "$line" >>"$rc"
      echo "已把 ~/.local/bin 加入 PATH（写在 ${rc}）。"
    fi
    echo "打开一个新的终端窗口后运行 cxdt login 登录服务端；在这个窗口里先运行 ${line}。"
    ;;
esac
