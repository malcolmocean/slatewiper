# slatewiper

Clear the slate. One button that archives every open terminal session and
browser tab somewhere findable, then closes them all. The point is not to lose
nothing; the point is to be free to *drop things without noticing you dropped
them*, knowing the state is recoverable if a project ever feels alive again.

Projects stop being implicit TODOs and become overhang.

macOS only. Terminal.app, Google Chrome, Claude Code and Codex sessions.

## Getting it

This is less a product than a working reference implementation of a fairly personal
tool. The intended route is to point your coding agent at **[SETUP.md](SETUP.md)**: it
interviews you, then adapts this repo to your terminal, browser, agents and archive (a
folder of Markdown, Obsidian, Roam, ...), keeping your settings in `mine/`.

If you already run Terminal.app + Chrome and like the defaults:

```
git clone <this repo> && cd slatewiper
./install.sh                      # app, power-off watcher, zsh hooks
node slatewipe.mjs                # PREVIEW: prints what it would archive and close
```

Your own settings go in `mine/` (see [Configuration](#configuration)).

## Usage

```
slatewipe                 PREVIEW (default). Prints the archive and the plan. Touches nothing.
slatewipe --go            SOFT wipe. Archive, then close everything that's safe to close, no questions asked.
                          Reports what it left alone.
slatewipe --go --hard     HARD wipe. Also kills working agent sessions / busy shells, and disarms
                          pages' unsaved-state check so they close too.
slatewipe --snapshot      Archive only. Closes nothing. A save point.
slatewipe find <text>     Search every archive (tab titles, URLs, session titles, folders).
slatewipe --json          Dump collected state.
slate ...                 zsh function for the above; `unwipe` resumes a dropped session in the current repo.
  --no-roam               Skip the Roam push (if you use Roam).
```

## What "safe to close" means (soft mode)

- **Browser tabs:** anything Chrome itself lets us close. A page that raises a
  `beforeunload` dialog (real unsaved state on a page you've interacted with)
  survives, with Chrome's own Leave / Cancel dialog left up. That dialog *is*
  the per-tab hard-reset button. Answer it before the next wipe: Chrome's
  AppleScript interface wedges while a dialog is pending.
- **Agent sessions (Claude Code / Codex):** idle ones. A session that's mid-turn
  or has a child process (babysitting a batch job, running a dev server) is
  *working* and survives.
- **Bare shells:** ones with nothing running in them.
- **Apps:** only those on the nuke-list, and only if they quit when asked.
- **Git working trees:** never touched, in any mode. Branch, uncommitted count
  and diff stat are recorded.

The terminal you ran it from is never closed.

## Where things go

1. `~/slate/<timestamp>/slate.md` (nested bullets) and `slate.json` (everything). The durable copy.
2. `.slate/<timestamp>.md` in the root of every repo that had something open, so the next
   `ls -a` there shows what was dropped. `install.sh` adds `.slate/` to your global
   gitignore, so no repo's status changes.
3. Screenshots of every Terminal and Chrome window in the archive dir, linked from
   `slate.md`. Requires the app's Screen Recording permission.
4. Optionally Roam: one `#[[slate wipe]]` block on today's daily-notes page, children =
   the archive, with a `[[repo-name]]` reference per terminal so project pages accumulate
   their dropped sessions. Can split across two graphs, work and personal (see
   `chrome` / `terminals` / `roam` in the config).

Each agent session is recorded with its exact resume command (`claude --resume <id>` /
`codex resume <id>`), cwd, uptime, status, and the last thing you said / it said, pulled
from the local transcript. No tokens spent. Every run also records which GUI apps were
open, and ends with an FYI line listing repos with uncommitted or unpushed work.

## Shell notice

`slate.zsh` (sourced from `~/.zshrc` by `install.sh`) prints a one-line FYI when you `cd`
into a repo that has `.slate/` entries. `unwipe` resumes the most recent dropped agent
session there; `unwipe -l` lists them.

## Configuration

`slatewipe.config.example.json` is the default. Copy it to `mine/slatewipe.config.json`
and edit; tokens go in `mine/.env`. `mine/` is gitignored here, so you can pull updates
without conflicts, and you can make it its own private repo to version your settings.
Anything specific to you belongs in `mine/`, not in the code.

All lists are nuke-lists, never keep-lists.

- `id`: reverse-DNS id for the app bundle, LaunchAgent labels and the Android app.
- `quitApps.list`: GUI apps quit on `--go`. Graceful; an app that refuses within
  `graceSeconds` (unsaved documents) is reported as untouched. `--hard` force-kills it.
  When Cursor quits, the folders it had open are recorded with `open -a Cursor <folder>`
  resume lines.
- `finder.close`: record Finder window paths and close them.
- `sweep.desktop` / `sweep.downloads`: move loose files into the archive dir (Downloads
  only files older than `olderThanDays`).
- `afterwards.openUrls`: a "begin again" page or two to open after a wipe.
- `autoSnapshot.onPowerOff` / `onSleep`: the watcher (a LaunchAgent) runs `--snapshot` on
  those events. Re-read on each event. Untested against a real shutdown: macOS may not
  wait the ~15 s a snapshot takes.
- `chrome.personalProfiles`, `chrome.workUrlPatterns`, `terminals.personalDirs`,
  `terminals.workDirs`: optional work/personal routing.
- `roam.personal` / `roam.work`: graph names and the `mine/.env` variable holding each token.
- `server`: port, plus how the phone finds the Mac (below).

## The app (permissions container)

`app/build.sh` builds `SlateWiper.app` into `~/Applications` so macOS grants **Screen
Recording** and **Automation** to *SlateWiper*, not to your terminal. Its executable is a
tiny compiled launcher (`app/launcher.c`) that spawns `app-main.sh` and waits. Two things
matter here, both learned the hard way:

- The executable must be a real Mach-O binary, not a script. A script runs as
  `/bin/bash`, an Apple platform binary, and macOS skips platform binaries when
  attributing a permission prompt, so the prompt said "node would like to
  record the screen".
- The bundle is ad-hoc signed, and macOS ties grants to that signature, which changes
  whenever the bundle's contents change. So all logic lives outside the bundle in
  `app-main.sh`, and the bundle never needs rebuilding. If it does
  (`./install.sh --rebuild-app`), re-grant the permissions.

Launched with no arguments (Spotlight, Finder, Dock) it shows a small chooser: Soft wipe /
Hard wipe / Snapshot / Cancel. With arguments (Keyboard Maestro, Raycast, `open --args`)
it runs them directly and never previews.

```
open -a SlateWiper --args --go            # soft wipe
open -a SlateWiper --args --go --hard     # hard wipe
open -a SlateWiper --args --snapshot      # save point
```

Output goes to `~/slate/app.log` plus a macOS notification. First run prompts for
Automation (Terminal, Chrome, System Events); grant Screen Recording in System Settings →
Privacy & Security → Screen Recording → SlateWiper to get window screenshots.

## The server (phone button, optional)

`server.mjs` is the same button over HTTP: one page with Soft wipe / Hard wipe / Snapshot
and the live log. It launches runs through SlateWiper.app, so permissions are the app's.
`./install.sh --server` starts it at login (port `server.port`, default 7337). Log:
`~/slate/server.log`.

- Every request needs the token: `SLATE_SERVER_TOKEN` in `mine/.env`, generated on first
  start, as `?t=TOKEN` or an `X-Slate-Token` header. The server is plain HTTP on every
  interface; the token is what keeps a shared wifi from wiping your slate.
- `GET /` the page · `GET /status` · `POST /run` `{"mode": "soft" | "hard" | "snapshot", "noRoam": false}`
  (409 while a run is in progress) · `GET /ping` (no token; for discovery).
- Advertises itself on the LAN as `_slatewiper._tcp` (Bonjour).

### Android app

`android/` is a WebView around that page, plus one real job: finding the Mac. On every
foreground it probes these in parallel and takes the highest-priority one that answers:
a URL typed into the app's dialog; `server.tunnel` (below); `server.hosts` (Tailscale
MagicDNS names, LAN hostnames); Bonjour; whatever worked last time; the Mac's LAN IP at
build time.

`android/build.sh` builds and signs the APK with the SDK's own tools (no Gradle) and bakes
in the token, port, hosts and tunnel; `--install` also `adb install`s it. `adb logcat -s
SlateWiper` says which candidate won.

### The tunnel

For the phone button away from home: `tunnel-setup.sh` creates a Cloudflare Tunnel to the
server at the hostname in `server.tunnel` and a LaunchAgent running `cloudflared`. Put
**Cloudflare Access** in front of it (Zero Trust → Access → Applications, one policy with
Service Auth for a service token) and put that token's Client ID / Secret in `mine/.env`
as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`; the Android app sends them on every
request, and anything without them dies at Cloudflare's edge.

## Requirements

- macOS, Terminal.app, Google Chrome, Node ≥ 18, Xcode command line tools (`cc`).
- Chrome menu bar → **View → Developer → Allow JavaScript from Apple Events** (on). Gives
  `read N%` per tab and lets hard mode disarm `beforeunload`.

## Known limits

- Hard mode's disarm injects a `<script>` into the page (AppleScript JS runs in an
  isolated world, so it has to). Sites with strict nonce-based CSP (Gmail, X) reject the
  injection; those tabs survive a hard wipe too, with the dialog up.
- Terminal windows are closed whole. A window mixing closable and kept tabs is left alone.
- Only Chrome and Terminal.app. Safari, Arc, iTerm, Ghostty: not handled (yet; SETUP.md
  tells your agent how to add them).

## How it finds things

- Claude Code writes `~/.claude/sessions/<pid>.json` per live process (sessionId, cwd,
  name, status). Transcript tail: `~/.claude/projects/*/<sessionId>.jsonl`.
- Codex: process cwd matched against `~/.codex/sessions/**/rollout-*.jsonl`
  session_meta; newest wins.
- Chrome profiles: Chrome's AppleScript interface doesn't expose them, so
  `chrome-profiles.mjs` parses each profile's SNSS session file into live windows and
  matches them to the AppleScript windows by ordered URL list.

## Developing in public with a private mine/

`.githooks/pre-commit` refuses commits that contain any value from `mine/.env` or any
pattern listed in `mine/forbidden.txt`. Enable it with `git config core.hooksPath .githooks`.

## License

MIT
