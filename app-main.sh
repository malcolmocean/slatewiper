#!/bin/bash
# app-main.sh — what SlateWiper.app actually runs. Lives OUTSIDE the bundle so the
# bundle (and its code signature, which macOS ties permissions to) never changes.
# Screen Recording / Accessibility / Automation grants to this bundle, not to
# Terminal. Launch: open -a SlateWiper --args --go   (or --go --hard, --snapshot)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/slate/app.log"; mkdir -p "$HOME/slate"
ARGS=("$@")
if [ ${#ARGS[@]} -eq 0 ]; then
  # Launched from Spotlight/Finder with no arguments: ask. (KM / CLI pass args and skip this.)
  choice=$(osascript -e 'tell application "System Events" to activate' -e 'set c to choose from list {"Soft wipe — close what needs no confirmation", "Hard wipe — kill working sessions too, disarm unsaved-state checks", "Snapshot — archive only, close nothing"} with title "SlateWiper" with prompt "Clear the slate?" default items {"Soft wipe — close what needs no confirmation"} OK button name "Go" cancel button name "Cancel"' -e 'if c is false then return "cancel"' -e 'return item 1 of c' 2>/dev/null)
  case "$choice" in
    Soft*) ARGS=(--go) ;;
    Hard*) ARGS=(--go --hard) ;;
    Snapshot*) ARGS=(--snapshot) ;;
    *) exit 0 ;;
  esac
fi
case " ${ARGS[*]} " in *" --go "*|*" --snapshot "*) ;; *) ARGS+=(--go);; esac   # the app never just previews
{
  echo "=== $(date) slatewipe ${ARGS[*]}"
  node "$REPO/slatewipe.mjs" "${ARGS[@]}" --notify
} >> "$LOG" 2>&1
