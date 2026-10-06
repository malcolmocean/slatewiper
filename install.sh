#!/bin/bash
# install.sh — put slatewiper's pieces in place on this Mac. Safe to re-run.
#   ./install.sh                 SlateWiper.app (only if not installed yet), power-off watcher,
#                                zsh hooks, .slate/ in your global gitignore
#   ./install.sh --server        also the phone-button server (LaunchAgent, port from config)
#   ./install.sh --rebuild-app   rebuild the app even if installed (then re-grant its permissions)
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"; cd "$REPO"
ID=$(node config.mjs get id); ID=${ID:-local.slatewiper}
LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA" "$HOME/slate"
SERVER=no; REBUILD=no
for a in "$@"; do case $a in --server) SERVER=yes;; --rebuild-app) REBUILD=yes;; *) echo "unknown: $a"; exit 1;; esac; done
[ -f "$LA/$ID.server.plist" ] && SERVER=yes   # already installed: keep it current

echo "id $ID · config $(node config.mjs get configFile)"

if [ $REBUILD = yes ] || [ ! -d "$HOME/Applications/SlateWiper.app" ]; then app/build.sh
else echo "app: ~/Applications/SlateWiper.app already installed, leaving it (and its permissions) alone"; fi

agent() {  # label, program args...
  local label=$1; shift
  { echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo "<plist version=\"1.0\"><dict>"
    echo "  <key>Label</key><string>$label</string>"
    echo "  <key>ProgramArguments</key><array>$(for x in "$@"; do printf '<string>%s</string>' "$x"; done)</array>"
    echo "  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"
    echo "  <key>StandardOutPath</key><string>$HOME/slate/${label##*.}.log</string>"
    echo "  <key>StandardErrorPath</key><string>$HOME/slate/${label##*.}.log</string>"
    echo "</dict></plist>"; } > "$LA/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA/$label.plist"
  echo "agent: $label running"
}

cc -framework AppKit -fobjc-arc -o watcher/slate-watcher watcher/slate-watcher.m
agent "$ID.watcher" "$REPO/watcher/slate-watcher" "$REPO"
[ $SERVER = yes ] && agent "$ID.server" "$REPO/server.sh"

if grep -q '>>> slatewiper >>>' "$HOME/.zshrc" 2>/dev/null; then echo "zsh: hooks already in ~/.zshrc"
else printf '\n# >>> slatewiper >>>\nsource %s/slate.zsh\n# <<< slatewiper <<<\n' "$REPO" >> "$HOME/.zshrc"; echo "zsh: added to ~/.zshrc (open a new shell)"; fi

GI=$(git config --global core.excludesfile || true); GI=${GI:-$HOME/.config/git/ignore}; GI=${GI/#\~/$HOME}
mkdir -p "$(dirname "$GI")"; touch "$GI"
grep -qx '.slate/' "$GI" || { echo '.slate/' >> "$GI"; echo "git: .slate/ added to $GI"; }

cat <<MSG

Done. First run: \`open -a SlateWiper\` and grant Automation when asked; for window screenshots,
System Settings → Privacy & Security → Screen Recording → SlateWiper. In Chrome:
View → Developer → Allow JavaScript from Apple Events. Then try \`node slatewipe.mjs\` (preview).
MSG
