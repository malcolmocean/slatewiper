# Setting up slatewiper (for your coding agent)

> **Human:** open your coding agent (Claude Code, Codex, ...) in this folder and say
> "follow SETUP.md". It will ask you a few questions, then adapt and install.

**Agent:** you're setting up slatewiper for the person you're working with. Read
README.md for what it does, then this file for what matters and what's subtle. The
code in this repo is one person's working setup. Treat it as a reference
implementation: keep what fits, cut what doesn't, and write what's missing. Don't
force their situation into its shape.

## What it's for (keep this intact)

The button exists so the person can *drop* things, not finish them. Every open
terminal session and browser tab goes into a findable archive, then closes. A project
that was quietly asking for attention just stops asking. If it ever feels alive again,
its state is still recoverable.

Design decisions that follow from that. Don't undo them without the person asking:

- **A button, not a schedule.** They choose when to wipe. (An automatic *snapshot* on
  power-off is fine, because it closes nothing.)
- **Preview by default.** `slatewipe` with no flags touches nothing.
- **Two tiers, no confirmation dialogs of our own.** A soft wipe closes only what needs
  no confirmation and reports what it left. A hard wipe takes the rest.
- **Kill and record, not hand off.** Don't ask agents to write handoff notes before
  closing them. Record the resume command and the last exchange, then close.
- **Never touch git working trees.** Record branch / dirty / unpushed state, nothing more.
- **Nuke-lists, never keep-lists.** Config names things to close, not things to protect.
- **Don't build a review flow.** No "tinder for tabs", snooze or "process your archive".
  Making finishing easier is the opposite of the point. Searching the archive (`find`) is fine.

## Interview

Ask these, a few at a time, conversationally. Skip anything the machine already
answers: look at `/Applications`, running processes, `~/.claude`, `~/.codex`, Chrome's
`Local State` for profiles, the shell rc file.

1. **Terminal:** Terminal.app, iTerm2, Ghostty, Warp, a tmux setup? (Only Terminal.app is
   implemented.)
2. **Browser:** Chrome (implemented), Arc, Safari, Brave, Firefox? Several profiles?
3. **Agents:** Claude Code, Codex, Cursor, Aider, something else? Do they leave agents
   babysitting long jobs (those should survive a soft wipe)?
4. **Archive target:** the local `~/slate/` folder always exists. Should it also go
   somewhere they already look: an Obsidian vault (a dated note), Logseq, Roam, Notion,
   a daily-notes folder, nowhere else?
5. **Work/personal split:** do they want the archive split by context (different Chrome
   profiles or folders → different destinations)? Most people don't. If not, leave the
   routing config empty.
6. **Apps to quit** on a wipe (Slack, Discord, ...)? Desktop sweep, Finder windows?
7. **Trigger:** command line only, Spotlight/Dock app, a hotkey (Keyboard Maestro,
   Raycast, BetterTouchTool), a phone button? The phone button (server + Android app +
   optional Cloudflare tunnel) is real work. Only set it up if they want it.
8. **Auto-snapshot on power-off?** (Default on, closes nothing.)

## Adapting

- **Settings go in `mine/`.** Copy `slatewipe.config.example.json` to
  `mine/slatewipe.config.json`. Tokens go in `mine/.env`. Pick an `id` (reverse-DNS,
  e.g. `com.theirname.slatewiper`). If they want their settings versioned,
  `git init` inside `mine/` (it's gitignored by the outer repo). Keeping personal
  values out of the code means they can pull upstream changes cleanly.
- **Changing code is fine.** For new terminals, browsers or archive targets, add a
  sibling of the existing collector or closer, or of `pushRoam`, rather than
  generalizing everything up front. Delete what they'll never use (Roam, Android,
  tunnel) if they'd rather not carry it.
- Run `./install.sh` (`--server` for the phone button). It builds the app only if it
  isn't installed yet.

## macOS gotchas (each one cost real time)

- **Permissions need their own app.** Screen Recording / Automation should belong to
  `SlateWiper.app`, not the person's terminal. The app's executable must be a compiled
  binary (`app/launcher.c`) that spawns the script and *waits* (no `exec`). A script
  executable runs as `/bin/bash`, a platform binary, and macOS then attributes the
  prompt to the next non-Apple binary ("node would like to record the screen").
- **Grants are tied to the ad-hoc signature,** which changes whenever the bundle
  changes. Keep all logic outside the bundle (`app-main.sh`) and never rebuild it
  casually. After a rebuild, re-grant.
- **Without Screen Recording, `CGWindowListCopyWindowInfo` omits other apps' windows
  entirely,** not just their titles. `screencapture` lives in `/usr/sbin`, which isn't on
  a minimal PATH.
- **Chrome's `execute javascript` runs in an isolated world** (and needs View →
  Developer → Allow JavaScript from Apple Events). Page globals are invisible there, and
  `window.onbeforeunload = null` does nothing. To touch the page, inject a `<script>`
  element. Strict-CSP sites (Gmail, X) block it.
- **A `beforeunload` dialog wedges Chrome's AppleScript.** `close tab` on a page with
  unsaved state returns immediately, the tab survives, Chrome shows Leave/Cancel, and
  *every later AppleScript call to Chrome hangs* until a human answers. Close those tabs
  last, or not at all in soft mode.
- **Chrome's AppleScript doesn't say which profile a window is in.** Parse
  `<Profile>/Sessions/Session_*` (SNSS) and match windows by ordered URL list. See
  `chrome-profiles.mjs`.
- **AppleScript reserved words** `before`, `after`, `st` fail as variable names with
  "Expected expression but found".
- **Closing Terminal.app sessions cleanly:** kill the agent, SIGHUP the shell, then
  `window.close({saving:'no'})` via JXA.
- **Synthetic clicks** (`cliclick`) may not register in Chrome from a script's process
  chain. To test `beforeunload` behaviour you need a real user gesture on the page.
- **Agent permission classifiers** may refuse to inspect Chrome's dialogs through System
  Events. Don't fight that; design around the dialog instead.

## Verify before the first real wipe

1. `node slatewipe.mjs`: the preview. Check that it found every window, tab and session,
   and that the plan matches what they expect.
2. `--snapshot`: archive only. Open `~/slate/<latest>/slate.md` and whatever external
   target you wired up.
3. A soft wipe with something disposable open: a scratch Terminal tab and a couple of
   throwaway Chrome tabs, one with unsaved text typed into a form. That tab should survive.
4. Hand them the button.
