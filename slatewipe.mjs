#!/usr/bin/env node
// slatewipe — clear the slate.
//
//   slatewipe              PREVIEW. Prints the archive and the plan. Touches nothing.
//   slatewipe --go         SOFT wipe: archive everything, then close everything that is safe
//                          to close with no questions asked. Reports what it left alone.
//   slatewipe --go --hard  HARD wipe: also kill working agent sessions and busy shells.
//   slatewipe --snapshot   archive + Roam push only; closes nothing (a save point)
//   slatewipe find <text>  search every archive for a tab/session/folder
//   slatewipe --json       dump collected state
//   --no-roam              skip the Roam push
//
// "Safe to close" means:
//   - browser tabs: anything Chrome itself lets us close. A page that raises a
//     beforeunload dialog (real unsaved state you've interacted with) survives,
//     with Chrome's own Leave/Cancel dialog left up — that dialog IS the per-tab
//     hard-reset button.
//   - agent sessions (Claude Code / Codex): idle ones. A session that is mid-turn
//     or has a child process running (babysitting a batch job, a dev server) is
//     "working" and survives a soft wipe.
//   - bare shells: ones with nothing running.
// Git working trees are never touched by either mode.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assignProfiles } from './chrome-profiles.mjs';
import { CONFIG, loadEnv } from './config.mjs';

const HOME = os.homedir();
const ARCHIVE_ROOT = path.join(HOME, 'slate');
const args = new Set(process.argv.slice(2));
const GO = args.has('--go'), HARD = args.has('--hard'), SNAPSHOT = args.has('--snapshot'), NOTIFY = args.has('--notify');

// ---- config (mine/slatewipe.config.json, else slatewipe.config.example.json; see config.mjs) ----
const expand = (p) => p.replace(/^~/, HOME);
const under = (cwd, dirs) => !!cwd && dirs.some(d => cwd === expand(d) || cwd.startsWith(expand(d) + '/'));
const WORK_DIR_RULE = (cwd) => under(cwd, CONFIG.terminals?.workDirs || []) && !under(cwd, CONFIG.terminals?.personalDirs || []);
const PERSONAL_PROFILES = CONFIG.chrome?.personalProfiles || [];
const WORK_URL_PATTERNS = (CONFIG.chrome?.workUrlPatterns || []).map(p => new RegExp(p, 'i'));
const ROAM = CONFIG.roam || {};
const QUIT_APPS = CONFIG.quitApps?.list || [], QUIT_GRACE = (CONFIG.quitApps?.graceSeconds ?? 8) * 1000;
const SWEEP = CONFIG.sweep || {}, AFTER_URLS = CONFIG.afterwards?.openUrls || [], FINDER_CLOSE = CONFIG.finder?.close !== false;

// ---------- helpers ----------
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const jxa = (code, timeoutMs = 60_000) => {
  try { return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6, timeout: timeoutMs })); }
  catch (e) { return { __error: String(e.stderr || e.message).trim().slice(0, 300) }; }
};
const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const stamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };
const short = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const sleep = (ms) => execSync(`sleep ${ms / 1000}`);
const myTty = (() => { let pid = process.pid; for (let i = 0; i < 12 && pid > 1; i++) { const [tty, ppid] = sh(`ps -o tty=,ppid= -p ${pid}`).split(/\s+/); if (tty && tty !== '??') return tty; pid = +ppid; } return ''; })();

// ---------- find ----------
if (process.argv[2] === 'find') {
  const needle = process.argv.slice(3).join(' ').toLowerCase();
  if (!needle) { console.error('usage: slatewipe find <text>'); process.exit(2); }
  const dirs = fs.existsSync(ARCHIVE_ROOT) ? fs.readdirSync(ARCHIVE_ROOT).filter(d => /^\d{4}-/.test(d)).sort().reverse() : [];
  let hits = 0;
  for (const d of dirs) {
    const f = path.join(ARCHIVE_ROOT, d, 'slate.md'); if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.toLowerCase().includes(needle)) { console.log(`\x1b[35m${d.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')}\x1b[0m  ${line.trim().replace(/^- /, '')}`); hits++; }
  }
  if (!hits) console.log(`nothing matching "${needle}" in ${dirs.length} archives`);
  process.exit(0);
}

// ---------- terminals ----------
function collectTerminals() {
  const wins = jxa(`const T = Application('Terminal');
    JSON.stringify(T.windows().map(w => ({ id: w.id(), tabs: w.tabs().map(t => ({ tty: t.tty(), busy: t.busy(), procs: t.processes(), title: t.customTitle() })) })));`);
  if (wins.__error) return { error: wins.__error, windows: [] };
  const ps = sh('ps -axo tty=,pid=,ppid=,etime=,comm=').split('\n').map(l => l.trim().split(/\s+/)).filter(a => a.length >= 5)
    .map(([tty, pid, ppid, etime, ...comm]) => ({ tty, pid: +pid, ppid: +ppid, etime, comm: comm.join(' ') }));
  const byTty = {}; for (const p of ps) (byTty[p.tty] ||= []).push(p);
  const cwdOf = (pid) => sh(`lsof -a -p ${pid} -d cwd -Fn | sed -n 's/^n//p'`);
  const children = (pid) => sh(`pgrep -lP ${pid}`).split('\n').filter(Boolean).map(l => l.split(' ').slice(1).join(' '));

  for (const w of wins) for (const t of w.tabs) {
    const tty = t.tty.replace('/dev/', ''), procs = byTty[tty] || [];
    const shell = procs.find(p => /^-?(zsh|bash)$/.test(p.comm)) || procs.find(p => p.comm !== 'login') || procs[0];
    t.cwd = shell ? cwdOf(shell.pid) : ''; t.shellPid = shell?.pid; t.isSelf = tty === myTty;
    const agent = procs.find(p => /(^|\/)(claude|codex)$/.test(p.comm));
    if (agent) {
      t.session = /claude$/.test(agent.comm) ? claudeSession(agent, t) : codexSession(agent, t);
      const kids = children(agent.pid).filter(c => !/^(codex|caffeinate)$/.test(c));
      t.session.children = kids;
      t.session.working = !['idle', 'unknown', undefined].includes(t.session.status) || kids.length > 0;
      t.session.why = t.session.working ? (kids.length ? `running: ${kids.join(', ')}` : `status ${t.session.status}`) : null;
    } else {
      // bare shell: anything besides login/shell running in the foreground?
      const extra = procs.filter(p => !/^(login|-?zsh|-?bash)$/.test(p.comm)).map(p => p.comm);
      t.shellBusy = extra.length > 0; t.shellWhy = extra.length ? `running: ${extra.join(', ')}` : null;
    }
    t.repo = repoInfo(t.cwd);
    t.scope = WORK_DIR_RULE(t.cwd) ? 'work' : 'personal';
    // decision
    const working = t.session ? t.session.working : t.shellBusy;
    t.closable = !t.isSelf && (!working || HARD);
    t.keepWhy = t.isSelf ? 'this terminal' : working && !HARD ? (t.session?.why || t.shellWhy) : null;
  }
  return { windows: wins };
}

function claudeSession(proc, tab) {
  const meta = readJSON(path.join(HOME, '.claude/sessions', `${proc.pid}.json`)) || {};
  const s = { kind: 'claude', pid: proc.pid, uptime: proc.etime, sessionId: meta.sessionId, name: meta.name, status: meta.status, cwd: meta.cwd || tab.cwd };
  if (!s.sessionId) { const argv = sh(`ps -o command= -p ${proc.pid}`); s.resume = /\bagents\b/.test(argv) ? `cd ${q(tab.cwd)} && claude agents` : `cd ${q(tab.cwd)} && claude --continue`; s.status = s.status || 'unknown'; return s; }
  s.resume = `cd ${q(s.cwd)} && claude --resume ${s.sessionId}`;
  const file = sh(`ls ${q(HOME)}/.claude/projects/*/${s.sessionId}.jsonl 2>/dev/null | head -1`);
  if (file) Object.assign(s, lastExchange(file));
  return s;
}

function lastExchange(file) {
  const size = fs.statSync(file).size, want = 400_000;
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(Math.min(size, want));
  fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length)); fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').slice(1).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const txt = (m) => typeof m.message?.content === 'string' ? m.message.content : (m.message?.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
  const rev = [...lines].reverse();
  const user = rev.find(m => m.type === 'user' && !m.isMeta && txt(m).trim() && !/^</.test(txt(m).trim()));
  const asst = rev.find(m => m.type === 'assistant' && txt(m).trim());
  const title = rev.find(m => m.type === 'ai-title');
  return { title: title?.title || title?.aiTitle, lastUser: user ? short(txt(user), 280) : undefined, lastAssistant: asst ? short(txt(asst), 280) : undefined, lastAt: (asst || user)?.timestamp };
}

function codexSession(proc, tab) {
  const cwd = sh(`lsof -a -p ${proc.pid} -d cwd -Fn | sed -n 's/^n//p'`) || tab.cwd;
  const file = sh(`grep -l '"cwd":"${cwd.replace(/[\\/]/g, '\\$&')}"' ${q(HOME)}/.codex/sessions/*/*/*/*.jsonl 2>/dev/null | xargs ls -t 2>/dev/null | head -1`);
  let sessionId; if (file) { try { sessionId = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).payload?.id; } catch {} }
  return { kind: 'codex', pid: proc.pid, uptime: proc.etime, sessionId, cwd, status: 'unknown', title: tab.title?.replace(/^\[.*?\]\s*/, ''), resume: sessionId ? `cd ${q(cwd)} && codex resume ${sessionId}` : `cd ${q(cwd)} && codex resume --last` };
}

const repoCache = {};
function repoInfo(cwd) {
  if (!cwd) return null; if (cwd in repoCache) return repoCache[cwd];
  const root = sh(`git -C ${q(cwd)} rev-parse --show-toplevel`); if (!root) return (repoCache[cwd] = null);
  return (repoCache[cwd] = {
    root, name: path.basename(root),
    branch: sh(`git -C ${q(root)} branch --show-current`) || sh(`git -C ${q(root)} rev-parse --short HEAD`),
    dirty: sh(`git -C ${q(root)} status --porcelain`).split('\n').filter(Boolean),
    diffStat: sh(`git -C ${q(root)} diff --stat | tail -1`),
    ahead: sh(`git -C ${q(root)} rev-list --count @{upstream}..HEAD 2>/dev/null`),
    lastCommit: sh(`git -C ${q(root)} log -1 --format='%h %s (%cr)'`),
  });
}

// ---------- apps ----------
function collectApps() {
  const r = jxa(`JSON.stringify(Application('System Events').applicationProcesses.whose({ backgroundOnly: false }).name())`, 20_000);
  if (r.__error) return { error: r.__error, running: [], toQuit: [] };
  const running = r.filter(n => n !== 'Finder');
  const toQuit = QUIT_APPS.filter(a => running.some(n => n.toLowerCase() === a.toLowerCase()));
  return { running, toQuit };
}

// ---------- cursor ----------
// Cursor (VS Code) writes windowsState to storage.json only when it quits, so
// live folders are read AFTER quitApps(); before that we try window titles.
const CURSOR_STORAGE = path.join(HOME, 'Library/Application Support/Cursor/User/globalStorage/storage.json');
function cursorFoldersFromStorage() {
  const ws = readJSON(CURSOR_STORAGE)?.windowsState || {};
  const wins = [...(ws.openedWindows || []), ...(ws.lastActiveWindow ? [ws.lastActiveWindow] : [])];
  const uri = (w) => w.folder || w.workspace?.configPath || (typeof w.workspace === 'string' ? w.workspace : null);
  return [...new Set(wins.map(uri).filter(Boolean).map(u => decodeURIComponent(String(u).replace(/^file:\/\//, ''))))];
}
function collectCursor(apps) {
  const running = apps.running.some(n => n === 'Cursor');
  if (!running) return { running, folders: [] };
  const titles = jxa(`JSON.stringify(Application('System Events').processes.byName('Cursor').windows.name())`, 10_000);
  const fromTitles = titles.__error ? null : titles.map(t => String(t).split(' — ').pop().trim()).filter(Boolean);
  return { running, folders: [], windowTitles: fromTitles, note: 'folders are read from storage.json after Cursor quits' };
}

// ---------- finder ----------
function collectFinder() {
  const r = jxa(`const F = Application('Finder'); JSON.stringify(F.finderWindows().map(w => { try { return decodeURIComponent(w.target().url()).replace(/^file:\/\//, ''); } catch (e) { return null; } }))`, 15_000);
  return r.__error ? { error: r.__error, paths: [] } : { paths: r.filter(Boolean) };
}
function closeFinder() { return jxa(`const F = Application('Finder'); const n = F.finderWindows().length; F.finderWindows().forEach(w => { try { w.close(); } catch (e) {} }); JSON.stringify(n)`, 15_000); }

// ---------- sweeps ----------
function sweepFolder(name, srcDir, destDir, olderThanDays) {
  const out = { name, moved: [], skipped: null };
  let entries; try { entries = fs.readdirSync(srcDir).filter(f => !f.startsWith('.')); } catch (e) { out.skipped = `no access to ${srcDir} (${e.code})`; return out; }
  const cutoff = olderThanDays ? Date.now() - olderThanDays * 86400e3 : Infinity;
  for (const f of entries) {
    const src = path.join(srcDir, f);
    try { if (fs.statSync(src).mtimeMs > cutoff) continue; } catch { continue; }
    if (!out.moved.length) fs.mkdirSync(destDir, { recursive: true });
    try { fs.renameSync(src, path.join(destDir, f)); out.moved.push(f); } catch (e) { (out.errors ||= []).push(`${f}: ${e.code}`); }
  }
  return out;
}
function runSweeps(dir) {
  const results = [];
  if (SWEEP.desktop?.enabled) results.push(sweepFolder('Desktop', path.join(HOME, 'Desktop'), path.join(dir, 'desktop')));
  if (SWEEP.downloads?.enabled) results.push(sweepFolder('Downloads', path.join(HOME, 'Downloads'), path.join(dir, 'downloads'), SWEEP.downloads.olderThanDays ?? 1));
  return results;
}

// ---------- chrome ----------
const PROBE = `(()=>{try{const de=document.documentElement,sh=Math.max(de.scrollHeight,document.body?.scrollHeight||0);return JSON.stringify({y:Math.round(scrollY),sh,ih:innerHeight})}catch(e){return JSON.stringify({err:String(e)})}})()`;
function collectChrome() {
  const r = jxa(`const C = Application('Google Chrome');
    if (!C.running()) JSON.stringify({ running: false, windows: [] }); else {
    let jsEnabled = true;
    const windows = C.windows().map(w => ({ id: w.id(), bounds: w.bounds(), tabs: w.tabs().map(t => {
      const tab = { id: t.id(), title: t.title(), url: t.url() };
      if (jsEnabled && /^https?:/.test(tab.url)) {
        try { tab.probe = JSON.parse(C.execute(t, { javascript: ${JSON.stringify(PROBE)} })); }
        catch (e) { if (/turned off/.test(String(e))) jsEnabled = false; else tab.probe = { err: String(e) }; }
      }
      return tab; }) }));
    JSON.stringify({ running: true, jsEnabled, windows }); }`);
  if (r.__error) return { error: r.__error, windows: [] };
  let profiles = {}; try { profiles = assignProfiles(r.windows.map(w => ({ id: w.id, tabs: w.tabs.map(t => t.url) }))); } catch (e) { r.profileError = String(e.message); }
  for (const w of r.windows) {
    w.profile = profiles[w.id]?.profile || null; w.pwa = profiles[w.id]?.pwa || null;
    w.scope = w.profile && PERSONAL_PROFILES.length ? (PERSONAL_PROFILES.includes(w.profile) ? 'personal' : 'work') : null;
    for (const t of w.tabs) {
      const p = t.probe; if (p && !p.err && p.sh > 0) t.readPct = Math.min(100, Math.round(((p.y + p.ih) / p.sh) * 100));
      t.scope = w.scope || (WORK_URL_PATTERNS.some(re => re.test(t.url)) ? 'work' : 'personal');
    }
  }
  return r;
}

// ---------- render ----------
function render(state, result) {
  const L = []; const { terminals, chrome } = state;
  const tabs = chrome.windows.flatMap(w => w.tabs);
  const sessions = terminals.windows.flatMap(w => w.tabs).filter(t => t.session && !t.isSelf);
  L.push(`# Slate ${SNAPSHOT ? 'snapshot' : 'wipe'} ${state.human}${result || SNAPSHOT ? '' : ' (PREVIEW)'}`, '');
  L.push(`- #[[slate ${SNAPSHOT ? 'snapshot' : 'wipe'}]] ${state.human} — ${terminals.windows.length} terminal windows (${sessions.length} agent sessions), ${chrome.windows.length} Chrome windows / ${tabs.length} tabs${HARD ? ' — HARD' : ''}`);
  L.push(`  - **Terminals**`);
  for (const w of terminals.windows) for (const t of w.tabs) {
    const s = t.session, r = t.repo;
    const head = s ? `${s.kind} · ${s.title || s.name || t.title || ''}` : `shell`;
    const kept = t.keepWhy ? ` · **KEPT: ${t.keepWhy}**` : '';
    L.push(`    - ${head}${kept}${w.shot ? ` · [screenshot](${w.shot})` : ''}`);
    L.push(`      - cwd: \`${t.cwd || '?'}\`${r ? ` · branch \`${r.branch}\`${r.dirty.length ? ` · **${r.dirty.length} uncommitted** (${r.diffStat || 'untracked only'})` : ' · clean'}${r.ahead && r.ahead !== '0' ? ` · ${r.ahead} unpushed` : ''}` : ''}`);
    if (s) {
      L.push(`      - resume: \`${s.resume}\`  (up ${s.uptime}, ${s.status})`);
      if (s.lastUser) L.push(`      - last you: ${s.lastUser}`);
      if (s.lastAssistant) L.push(`      - last it: ${s.lastAssistant}`);
    }
  }
  if (state.cursor?.running || state.cursor?.folders?.length) {
    const c = state.cursor;
    L.push(`  - **Cursor**${c.folders.length ? '' : c.windowTitles?.length ? ` (windows: ${c.windowTitles.join(', ')})` : ` (running; ${c.note})`}`);
    for (const f of c.folders) L.push(`    - \`${f}\` · resume: \`open -a Cursor ${q(f)}\``);
  }
  if (state.finder?.paths?.length) L.push(`  - **Finder:** ${state.finder.paths.map(p => `\`${p}\``).join(', ')}`);
  if (result?.sweeps?.length) for (const sw of result.sweeps) L.push(`  - **${sw.name} sweep:** ${sw.skipped ? sw.skipped : sw.moved.length ? `${sw.moved.length} moved → ${state.ts}/${sw.name.toLowerCase()}/ (${sw.moved.slice(0, 8).join(', ')}${sw.moved.length > 8 ? ', …' : ''})` : 'nothing to move'}`);
  if (state.apps?.running?.length) L.push(`  - **Apps open:** ${state.apps.running.join(', ')}${state.apps.toQuit.length ? ` · quitting: ${state.apps.toQuit.join(', ')}` : ''}${result?.appsRefused?.length ? ` · **refused to quit: ${result.appsRefused.join(', ')}**` : ''}`);
  L.push(`  - **Chrome**${chrome.jsEnabled === false ? ' *(JS-from-AppleScript off: no read%)*' : ''}`);
  chrome.windows.forEach((w, i) => {
    L.push(`    - ${w.pwa ? `${w.pwa} PWA` : 'window'} ${i + 1} (${w.tabs.length} tabs${w.profile ? `, ${w.profile}` : ''})${w.shot ? ` · [screenshot](${w.shot})` : ''}`);
    for (const t of w.tabs) {
      const pct = t.readPct != null ? ` · read ${t.readPct}%` : '';
      const kept = result?.survivedTabs?.includes(t.id) ? ' · **KEPT: Chrome refused (unsaved state) — Leave/Cancel dialog pending**' : '';
      L.push(`      - [${short(t.title || t.url, 90)}](${t.url})${pct}${kept}`);
    }
  });
  return L.join('\n') + '\n';
}

// ---------- archive ----------
// Repo .slate/ markers mean "something was dropped here", so a snapshot (closes
// nothing) writes none, and a wipe skips terminals it kept: they're still open.
function writeArchive(state, md) {
  const dir = path.join(ARCHIVE_ROOT, state.ts); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'slate.md'), md); fs.writeFileSync(path.join(dir, 'slate.json'), JSON.stringify(state, null, 2));
  if (state.mode === 'snapshot') return dir;
  const byRepo = {};
  for (const w of state.terminals.windows) for (const t of w.tabs) if (t.repo && !t.isSelf && !t.keepWhy) (byRepo[t.repo.root] ||= []).push(t);
  for (const f of state.cursor?.folders || []) { const root = sh(`git -C ${q(f)} rev-parse --show-toplevel`) || f; if (fs.existsSync(root)) (byRepo[root] ||= []).push({ cursorFolder: f }); }
  for (const [root, tabs] of Object.entries(byRepo)) {
    const d = path.join(root, '.slate'); fs.mkdirSync(d, { recursive: true });
    const lines = [`# dropped here on ${state.human}`, `full archive: ${dir}/slate.md`, ''];
    for (const t of tabs) {
      if (t.cursorFolder) { lines.push(`- cursor: ${path.basename(t.cursorFolder)} (cwd ${t.cursorFolder})`, `  - resume: \`open -a Cursor ${q(t.cursorFolder)}\``); continue; }
      const s = t.session;
      lines.push(`- ${s ? `${s.kind}: ${s.title || s.name || ''}` : 'shell'} (cwd ${t.cwd})`);
      if (s) { lines.push(`  - resume: \`${s.resume}\``); if (s.lastUser) lines.push(`  - last you: ${s.lastUser}`); if (s.lastAssistant) lines.push(`  - last it: ${s.lastAssistant}`); }
    }
    fs.writeFileSync(path.join(d, `${state.ts}.md`), lines.join('\n') + '\n');
  }
  ensureGlobalIgnore('.slate/');
  return dir;
}
function ensureGlobalIgnore(pattern) {
  let file = sh('git config --global core.excludesfile');
  if (!file) { file = path.join(HOME, '.config/git/ignore'); fs.mkdirSync(path.dirname(file), { recursive: true }); sh(`git config --global core.excludesfile ${q(file)}`); }
  file = file.replace(/^~/, HOME);
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!cur.split('\n').includes(pattern)) fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n');
}

// ---------- roam ----------
const uid9 = () => Math.random().toString(36).slice(2, 11).padEnd(9, '0');
async function roamCall(graph, token, pathName, body) {
  let base = 'https://api.roamresearch.com';
  for (let i = 0; i < 6; i++) {
    const res = await fetch(`${base}/api/graph/${graph}/${pathName}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-authorization': `Bearer ${token}` }, body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (res.status >= 300 && res.status < 400) { const m = (res.headers.get('location') || '').match(/https:\/\/(peer-\d+).*?:(\d+)/); if (!m) throw new Error('bad redirect'); base = `https://${m[1]}.api.roamresearch.com:${m[2]}`; continue; }
    if (res.status === 503) { await new Promise(r => setTimeout(r, 4000)); continue; }
    if (!res.ok) throw new Error(`Roam ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text(); try { return JSON.parse(text).result ?? JSON.parse(text); } catch { return text; }
  }
  throw new Error('Roam: retries exhausted');
}
// Build nested Roam blocks for one scope ('personal' | 'work') from the state.
function roamTree(state, scope, result) {
  const kids = [];
  const terms = state.terminals.windows.flatMap(w => w.tabs).filter(t => !t.isSelf && t.scope === scope);
  if (terms.length) {
    const tk = [];
    for (const t of terms) {
      const s = t.session, r = t.repo;
      const c = [];
      c.push({ string: `cwd: \`${t.cwd || '?'}\`${r ? ` · branch \`${r.branch}\`${r.dirty.length ? ` · **${r.dirty.length} uncommitted**` : ' · clean'}` : ''}` });
      if (s) { c.push({ string: `resume: \`${s.resume}\`` }); if (s.lastUser) c.push({ string: `last you: ${s.lastUser}` }); if (s.lastAssistant) c.push({ string: `last it: ${s.lastAssistant}` }); }
      tk.push({ string: `${s ? `${s.kind} · ${s.title || s.name || ''}` : 'shell'}${r ? ` · [[${r.name}]]` : ''}${t.keepWhy ? ` · **KEPT: ${t.keepWhy}**` : ''}`, children: c });
    }
    kids.push({ string: '**Terminals**', children: tk });
  }
  const cfolders = (state.cursor?.folders || []).filter(f => (WORK_DIR_RULE(f) ? 'work' : 'personal') === scope);
  if (cfolders.length) kids.push({ string: '**Cursor**', children: cfolders.map(f => ({ string: `[[${path.basename(f)}]] · \`open -a Cursor ${q(f)}\`` })) });
  if (scope === 'personal' && state.finder?.paths?.length) kids.push({ string: `**Finder:** ${state.finder.paths.map(p => `\`${p}\``).join(', ')}` });
  const tabs = state.chrome.windows.flatMap((w, i) => w.tabs.map(t => ({ ...t, win: i + 1 }))).filter(t => t.scope === scope);
  if (tabs.length) {
    kids.push({ string: '**Chrome**', children: tabs.map(t => ({ string: `[${short(t.title || t.url, 90).replace(/[\[\]]/g, '')}](${t.url})${t.readPct != null ? ` · read ${t.readPct}%` : ''}${result?.survivedTabs?.includes(t.id) ? ' · **KEPT (unsaved state)**' : ''}` })) });
  }
  if (!kids.length) return null;
  return { string: `#[[slate ${SNAPSHOT ? 'snapshot' : 'wipe'}]] ${state.time} — ${terms.length} terminals, ${tabs.length} tabs${HARD ? ' — HARD' : ''}`, children: kids };
}
async function pushRoam(state, result, log) {
  const env = loadEnv(); const out = {};
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  const dnpUid = `${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}`;
  const ord = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const dnpTitle = `${d.toLocaleString('en-US', { month: 'long' })} ${ord(d.getDate())}, ${d.getFullYear()}`;
  for (const scope of ['personal', 'work']) {
    const tree = roamTree(state, scope, result); if (!tree) continue;
    if (!ROAM[scope]) continue;
    const { graph, tokenEnv } = ROAM[scope]; const token = env[tokenEnv];
    if (!token) { out[scope] = `skipped (no ${tokenEnv} in mine/.env)`; continue; }
    try {
      const page = await roamCall(graph, token, 'pull', { eid: `[:block/uid "${dnpUid}"]`, selector: '[:block/uid]' });
      if (!page) await roamCall(graph, token, 'write', { action: 'create-page', page: { title: dnpTitle, uid: dnpUid } });
      const actions = [];
      const walk = (node, parentUid, order) => { const uid = uid9(); actions.push({ action: 'create-block', location: { 'parent-uid': parentUid, order }, block: { string: node.string, uid } }); (node.children || []).forEach((c, i) => walk(c, uid, i)); return uid; };
      const rootUid = walk(tree, dnpUid, 'last');
      await roamCall(graph, token, 'write', { action: 'batch-actions', actions });
      out[scope] = `https://roamresearch.com/#/app/${graph}/page/${rootUid}`;
    } catch (e) { out[scope] = `FAILED: ${e.message}`; }
    log?.(`roam ${scope}: ${out[scope]}`);
  }
  return out;
}

// ---------- screenshots ----------
// Needs Screen Recording permission for the *responsible app* (SlateWiper.app,
// not Terminal). Silently skipped otherwise. Terminal's AppleScript window id
// is its CGWindowID; Chrome's isn't, so Chrome windows are matched by bounds.
function takeScreenshots(state, dir) {
  let probe; try { probe = execSync(`screencapture -x -t jpg ${q(path.join(dir, '.probe.jpg'))} 2>&1; echo "exit=$?"`, { encoding: 'utf8' }).trim(); } catch (e) { probe = String(e.message); }
  try { fs.unlinkSync(path.join(dir, '.probe.jpg')); } catch {}
  if (!/exit=0$/.test(probe) || /could not/i.test(probe)) return { skipped: `no Screen Recording permission for this app (${probe.replace(/\s+/g, ' ').slice(0, 120)})` };
  let n = 0;
  state.terminals.windows.forEach((w, i) => {
    const f = `terminal-${i + 1}.png`;
    if (sh(`screencapture -x -o -l ${w.id} ${q(path.join(dir, f))} 2>&1 && echo ok`) === 'ok') { w.shot = f; n++; }
  });
  const cg = jxa(`ObjC.import('CoreGraphics'); const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID); const out = [];
    for (let i = 0; i < ref.count; i++) { const d = ObjC.deepUnwrap(ref.objectAtIndex(i)); if (d.kCGWindowOwnerName === 'Google Chrome' && d.kCGWindowLayer === 0) out.push({ id: d.kCGWindowNumber, b: d.kCGWindowBounds }); }
    JSON.stringify(out)`, 20_000);
  if (!cg.__error) state.chrome.windows.forEach((w, i) => {
    const b = w.bounds; if (!b) return;
    const m = cg.find(c => Math.abs(c.b.X - b.x) < 2 && Math.abs(c.b.Y - b.y) < 2 && Math.abs(c.b.Width - b.width) < 2 && Math.abs(c.b.Height - b.height) < 2);
    if (!m) return;
    const f = `chrome-${i + 1}.png`;
    if (sh(`screencapture -x -o -l ${m.id} ${q(path.join(dir, f))} 2>&1 && echo ok`) === 'ok') { w.shot = f; n++; }
  });
  return { count: n };
}
function notify(title, body) {
  if (!NOTIFY) return;
  jxa(`const a = Application.currentApplication(); a.includeStandardAdditions = true; a.displayNotification(${JSON.stringify(body)}, { withTitle: ${JSON.stringify(title)} }); JSON.stringify(1)`, 10_000);
}

// ---------- act ----------
// Runs in the PAGE's world (AppleScript JS lives in an isolated world, so we
// inject a <script> element). Makes beforeunload unable to raise a dialog.
// Sites with strict CSP (nonce-only inline scripts) will reject this; those
// tabs then survive a hard wipe with Chrome's dialog up.
const DISARM = `(()=>{try{const s=document.createElement('script');s.textContent="window.onbeforeunload=null;try{const P=BeforeUnloadEvent.prototype;P.preventDefault=function(){};Object.defineProperty(P,'returnValue',{configurable:true,get(){return ''},set(){}})}catch(e){}";document.documentElement.appendChild(s);s.remove();return 'ok'}catch(e){return 'err '+e}})()`;

function closeChromeTabs(state) {
  // Soft: close each tab; Chrome refuses (and shows its Leave-site dialog) for
  // pages with real unsaved state you've interacted with — those survive.
  // Hard: disarm beforeunload in the page first, then close.
  const ids = state.chrome.windows.flatMap(w => w.tabs.map(t => t.id));
  if (!ids.length) return { closed: 0, survivedTabs: [] };
  const r = jxa(`const C = Application('Google Chrome'); C.includeStandardAdditions = true;
    const ids = ${JSON.stringify(ids)}; const byId = {};
    for (const w of C.windows()) for (const t of w.tabs()) byId[t.id()] = t;
    const hard = ${HARD};
    for (const id of ids) { const t = byId[id]; if (!t) continue;
      if (hard && /^https?:/.test(t.url())) { try { C.execute(t, { javascript: ${JSON.stringify(DISARM)} }); } catch (e) {} }
      try { t.close(); } catch (e) {} }
    delay(1.5);
    const alive = new Set(); for (const w of C.windows()) for (const t of w.tabs()) alive.add(t.id());
    JSON.stringify({ survivedTabs: ids.filter(id => alive.has(id)), closed: ids.filter(id => !alive.has(id)).length });`, 180_000);
  return r.__error ? { closed: 0, survivedTabs: ids, error: r.__error } : r;
}

function quitApps(state) {
  const names = state.apps.toQuit; if (!names.length) return { quit: [], refused: [] };
  for (const n of names) jxa(`try { Application(${JSON.stringify(n)}).quit(); } catch (e) {} JSON.stringify(1)`, 15_000);
  const deadline = Date.now() + QUIT_GRACE; let still = names;
  while (Date.now() < deadline && still.length) {
    sleep(1000);
    const live = jxa(`JSON.stringify(Application('System Events').applicationProcesses.name())`, 10_000);
    if (live.__error) break;
    still = names.filter(n => live.some(x => x.toLowerCase() === n.toLowerCase()));
  }
  if (still.length && HARD) { for (const n of still) sh(`pkill -9 -x ${q(n)}`); sleep(500); still = []; }
  if (names.includes('Cursor') && !still.includes('Cursor')) { sleep(1000); state.cursor.folders = cursorFoldersFromStorage(); state.cursor.running = false; }
  return { quit: names.filter(n => !still.includes(n)), refused: still };
}

function closeTerminals(state) {
  let closedWindows = 0, killed = 0;
  const targets = state.terminals.windows.map(w => ({ w, tabs: w.tabs.filter(t => t.closable) })).filter(x => x.tabs.length);
  for (const { tabs } of targets) for (const t of tabs) if (t.session?.pid) { try { process.kill(t.session.pid, 'SIGTERM'); killed++; } catch {} }
  if (killed) sleep(2000);
  for (const { tabs } of targets) for (const t of tabs) if (t.session?.pid && HARD) { try { process.kill(t.session.pid, 'SIGKILL'); } catch {} }
  for (const { w, tabs } of targets) {
    for (const t of tabs) if (t.shellPid) { try { process.kill(t.shellPid, 'SIGHUP'); } catch {} }
    if (tabs.length === w.tabs.length) { // whole window is ours to close
      jxa(`const T = Application('Terminal'); try { T.windows.byId(${w.id}).close({ saving: 'no' }); } catch (e) {} JSON.stringify(1)`, 10_000);
      closedWindows++;
    }
  }
  return { closedWindows, killed };
}

// ---------- repo awareness ----------
function printRepoAwareness() {
  const repos = {}; for (const t of state.terminals.windows.flatMap(w => w.tabs)) if (t.repo) repos[t.repo.root] = t.repo;
  const dirty = Object.values(repos).filter(r => r.dirty.length), ahead = Object.values(repos).filter(r => r.ahead && r.ahead !== '0');
  if (!dirty.length && !ahead.length) return;
  console.log(`\nFYI (untouched, as always):`);
  if (dirty.length) console.log(`  - uncommitted work in ${dirty.length} repo${dirty.length > 1 ? 's' : ''}: ${dirty.map(r => `${r.name} (${r.dirty.length})`).join(', ')}`);
  if (ahead.length) console.log(`  - unpushed commits in: ${ahead.map(r => `${r.name} (${r.ahead})`).join(', ')}`);
}

// ---------- main ----------
const now = new Date();
const state = { ts: stamp(now), human: now.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }), time: now.toLocaleTimeString('en-CA', { timeStyle: 'short' }), host: os.hostname(), mode: SNAPSHOT ? 'snapshot' : GO ? (HARD ? 'hard' : 'soft') : 'preview', terminals: collectTerminals(), chrome: collectChrome(), apps: collectApps() };
state.cursor = collectCursor(state.apps); state.finder = collectFinder();
if (args.has('--json')) { console.log(JSON.stringify(state, null, 2)); process.exit(0); }

const allTabs = state.chrome.windows.flatMap(w => w.tabs);
const termTabs = state.terminals.windows.flatMap(w => w.tabs);
const closableTerms = termTabs.filter(t => t.closable), keptTerms = termTabs.filter(t => !t.closable && !t.isSelf);
const repos = [...new Set(termTabs.filter(t => t.repo && !t.isSelf).map(t => t.repo.root))];
const describe = (t) => `${t.session ? `${t.session.kind} · ${t.session.title || t.session.name || ''}` : 'shell'} (${path.basename(t.cwd || '?')})`;

if (SNAPSHOT) {
  const dir0 = path.join(ARCHIVE_ROOT, state.ts); fs.mkdirSync(dir0, { recursive: true });
  const shots = takeScreenshots(state, dir0); console.log(`screenshots: ${shots.count ?? 0}${shots.skipped ? ` (${shots.skipped})` : ''}`);
  const dir = writeArchive(state, render(state));
  console.log(`snapshot → ${dir}/slate.md`);
  if (!args.has('--no-roam')) await pushRoam(state, null, (m) => console.log(m));
  notify('Slate snapshot', `archived ${allTabs.length} tabs, ${termTabs.length} terminals. Nothing closed.`);
  console.log('Nothing closed.');
} else if (!GO) {
  console.log(render(state));
  console.log('─'.repeat(72));
  console.log(`PREVIEW — nothing closed or written. \`slatewipe --go\` (soft) would:`);
  console.log(`  • archive to ${ARCHIVE_ROOT}/${state.ts}/slate.md, .slate/ in ${repos.length} repos (${repos.map(r => path.basename(r)).join(', ')}), push to Roam`);
  console.log(`  • close ${closableTerms.length} terminals: ${closableTerms.filter(t => t.session).length} idle agent sessions + ${closableTerms.filter(t => !t.session).length} idle shells`);
  console.log(`  • try to close all ${allTabs.length} Chrome tabs; Chrome keeps any with real unsaved state (you'll see its Leave/Cancel dialog on those)`);
  console.log(`  • quit ${state.apps.toQuit.length} apps: ${state.apps.toQuit.join(', ') || '(none of the nuke-list is running)'}${state.cursor.running ? ' (Cursor folders recorded on quit)' : ''}`);
  if (FINDER_CLOSE && state.finder.paths.length) console.log(`  • close ${state.finder.paths.length} Finder windows`);
  const sweeps = [SWEEP.desktop?.enabled && 'Desktop', SWEEP.downloads?.enabled && `Downloads (>${SWEEP.downloads.olderThanDays ?? 1}d old)`].filter(Boolean);
  if (sweeps.length) console.log(`  • sweep ${sweeps.join(' and ')} into the archive`);
  if (AFTER_URLS.length) console.log(`  • then open: ${AFTER_URLS.join(', ')}`);
  console.log(`  • leave untouched (${keptTerms.length}):`);
  for (const t of keptTerms) console.log(`      - ${describe(t)} — ${t.keepWhy}`);
  console.log(`  \`--go --hard\` would also kill those ${keptTerms.length}.`);
  printRepoAwareness();
  if (state.chrome.jsEnabled === false) console.log(`  ! Chrome JS-from-AppleScript is off, so read% is unavailable. View → Developer → Allow JavaScript from Apple Events`);
  if (state.terminals.error) console.log(`  ! Terminal: ${state.terminals.error}`);
  if (state.chrome.error) console.log(`  ! Chrome: ${state.chrome.error}`);
} else {
  const dir0 = path.join(ARCHIVE_ROOT, state.ts); fs.mkdirSync(dir0, { recursive: true });
  const shots = takeScreenshots(state, dir0); console.log(`screenshots: ${shots.count ?? 0}${shots.skipped ? ` (${shots.skipped})` : ''}`);
  const dir = writeArchive(state, render(state));
  console.log(`archived → ${dir}/slate.md`);
  const tabRes = closeChromeTabs(state);
  console.log(`chrome: closed ${tabRes.closed} tabs${tabRes.survivedTabs.length ? `, ${tabRes.survivedTabs.length} refused to close` : ''}${tabRes.error ? ` (${tabRes.error})` : ''}`);
  const termRes = closeTerminals(state);
  console.log(`terminals: killed ${termRes.killed} agent sessions, closed ${termRes.closedWindows} windows`);
  const appRes = quitApps(state);
  console.log(`apps: quit ${appRes.quit.join(', ') || 'none'}${appRes.refused.length ? `; refused: ${appRes.refused.join(', ')}` : ''}`);
  if (FINDER_CLOSE && state.finder.paths.length) { const n = closeFinder(); console.log(`finder: closed ${n.__error ? '?' : n} windows`); }
  const sweeps = runSweeps(dir); for (const sw of sweeps) console.log(`${sw.name.toLowerCase()} sweep: ${sw.skipped || `${sw.moved.length} moved`}`);
  const result = { survivedTabs: tabRes.survivedTabs, appsRefused: appRes.refused, sweeps };
  const finalMd = render(state, result); writeArchive(state, finalMd); // again: now with Cursor folders + sweep results
  if (!args.has('--no-roam')) await pushRoam(state, result, (m) => console.log(m));
  const survivors = allTabs.filter(t => tabRes.survivedTabs.includes(t.id));
  if (keptTerms.length || survivors.length || appRes.refused.length) {
    console.log(`\nUNTOUCHED:`);
    for (const a of appRes.refused) console.log(`  - app ${a} — refused to quit (unsaved documents?)`);
    for (const t of keptTerms) console.log(`  - ${describe(t)} — ${t.keepWhy}`);
    for (const t of survivors) console.log(`  - tab "${short(t.title || t.url, 70)}" — Chrome says unsaved state; its Leave/Cancel dialog is up (answer it before the next wipe)`);
    if (keptTerms.length || survivors.length) console.log(`  (\`slatewipe --go --hard\` kills the terminals too and disarms the tabs' unsaved-state check)`);
  }
  const untouched = keptTerms.length + survivors.length + appRes.refused.length;
  notify('Slate wiped', `closed ${tabRes.closed} tabs, ${termRes.closedWindows} terminals, ${appRes.quit.length} apps${untouched ? ` · ${untouched} untouched` : ''}. Begin again.`);
  printRepoAwareness();
  for (const u of AFTER_URLS) sh(`open -a 'Google Chrome' ${q(u)}`);
  console.log('\nBegin again.');
}
