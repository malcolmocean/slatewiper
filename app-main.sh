#!/bin/bash
# app-main.sh — what SlateWiper.app actually runs. Lives OUTSIDE the bundle so the
# bundle (and its code signature, which macOS ties permissions to) never changes.
# Screen Recording / Accessibility / Automation grants to this bundle, not to
# Terminal. Launch: open -a SlateWiper --args --go   (or --go --hard, --snapshot)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/slate/app.log"; mkdir -p "$HOME/slate"
ARGS=("$@")
TIMER="node $REPO/timer.mjs"
ask() { osascript -e 'tell application "System Events" to activate' "$@" 2>/dev/null; }
if [ ${#ARGS[@]} -eq 0 ]; then
  # Launched from Spotlight/Finder with no arguments: ask. (KM / CLI pass args and skip this.)
  armed=$($TIMER status); extra=""
  [ "$armed" != "no timer armed" ] && extra=", \"Cancel timer — $armed\""
  choice=$(ask -e "set c to choose from list {\"Soft wipe — close what needs no confirmation\", \"Hard wipe — kill working sessions too, disarm unsaved-state checks\", \"Snapshot — archive only, close nothing\", \"Timer — soft wipe in N minutes…\"$extra} with title \"SlateWiper\" with prompt \"Clear the slate?\" default items {\"Soft wipe — close what needs no confirmation\"} OK button name \"Go\" cancel button name \"Cancel\"" -e 'if c is false then return "cancel"' -e 'return item 1 of c')
  case "$choice" in
    Soft*) ARGS=(--go) ;;
    Hard*) ARGS=(--go --hard) ;;
    Snapshot*) ARGS=(--snapshot) ;;
    Timer*)
      pick=$(ask -e 'set c to choose from list {"5 minutes", "20 minutes", "60 minutes (1 h)", "300 minutes (5 h)", "Custom…"} with title "SlateWiper timer" with prompt "Soft wipe everything in…" default items {"20 minutes"} OK button name "Arm" cancel button name "Cancel"' -e 'if c is false then return "cancel"' -e 'return item 1 of c')
      case "$pick" in
        cancel|"") exit 0 ;;
        Custom*) pick=$(ask -e 'set r to display dialog "Soft wipe everything in how many minutes?" default answer "" with title "SlateWiper timer" buttons {"Cancel", "Arm"} default button "Arm" cancel button "Cancel"' -e 'return text returned of r') || exit 0 ;;
      esac
      ARGS=(--in "${pick%% *}") ;;
    Cancel\ timer*) ARGS=(--cancel-timer) ;;
    *) exit 0 ;;
  esac
fi
# Timer verbs (also usable from KM: open -a SlateWiper --args --in 20 [--hard] / --cancel-timer). These arm or
# disarm and exit; the wipe itself comes later, as its own `open -a SlateWiper --args --go ...` from the timer.
if [ "${ARGS[0]}" = --in ]; then
  mode=soft; case " ${ARGS[*]} " in *" --hard "*) mode=hard;; esac
  msg=$($TIMER arm "${ARGS[1]}" $mode 2>&1)
  osascript -e "display notification \"${msg//\"/}\" with title \"SlateWiper timer\"" 2>/dev/null; exit 0
fi
if [ "${ARGS[0]}" = --cancel-timer ]; then
  msg=$($TIMER cancel); osascript -e "display notification \"$msg\" with title \"SlateWiper timer\"" 2>/dev/null; exit 0
fi
case " ${ARGS[*]} " in *" --go "*|*" --snapshot "*|*" --grant-screen "*) ;; *) ARGS+=(--go);; esac   # the app never just previews
{
  echo "=== $(date) slatewipe ${ARGS[*]}"
  node "$REPO/slatewipe.mjs" "${ARGS[@]}" --notify
} >> "$LOG" 2>&1
