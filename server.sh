#!/bin/bash
# server.sh — launchd entry point for server.mjs (the LaunchAgent install.sh --server writes).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NVM_NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)
[ -n "$NVM_NODE" ] && export PATH="$NVM_NODE:$PATH"
mkdir -p "$HOME/slate"
exec node "$(dirname "$0")/server.mjs"
