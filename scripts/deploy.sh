#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

node_bin="$root_dir/.runtime/bin/node"
npm_cli="$root_dir/.runtime/lib/node_modules/npm/bin/npm-cli.js"
if [[ -x "$node_bin" && -f "$npm_cli" ]]; then
  "$node_bin" "$npm_cli" ci --omit=dev
else
  npm ci --omit=dev
fi
mkdir -p "$HOME/.config/systemd/user"
install -m 0644 deploy/minecraft-idle-bot.service \
  "$HOME/.config/systemd/user/minecraft-idle-bot.service"
systemctl --user daemon-reload
systemctl --user enable minecraft-idle-bot.service >/dev/null
systemctl --user restart minecraft-idle-bot.service

echo "[deploy] minecraft-idle-bot.service restarted from $(git rev-parse --short HEAD)"
