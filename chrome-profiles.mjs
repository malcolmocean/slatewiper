// Which Chrome profile owns each window? Chrome's AppleScript interface
// doesn't say, so we parse each profile's SNSS session file
// (~/Library/Application Support/Google/Chrome/<Profile>/Sessions/Session_*)
// to get its live windows as ordered URL lists, then match them against the
// AppleScript windows. Format: "SNSS" magic, int32 version, then commands of
// [uint16 size][uint8 id][payload]. Command ids from session_service_commands.cc.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');

// Installed Chrome web-app shortcuts: start-URL origin → app name (for labeling PWA windows).
export function installedPWAs() {
  const out = {};
  for (const dir of [path.join(os.homedir(), 'Applications/Chrome Apps.localized'), '/Applications/Chrome Apps.localized']) {
    let apps = []; try { apps = fs.readdirSync(dir).filter(f => f.endsWith('.app')); } catch { continue; }
    for (const a of apps) {
      try {
        const plist = fs.readFileSync(path.join(dir, a, 'Contents/Info.plist'), 'utf8');
        const url = plist.match(/<key>CrAppModeShortcutURL<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        const name = plist.match(/<key>CrAppModeShortcutName<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        if (url && name) out[new URL(url).origin] = name;
      } catch {}
    }
  }
  return out;
}

export function listProfiles() {
  try {
    const ls = JSON.parse(fs.readFileSync(path.join(ROOT, 'Local State'), 'utf8'));
    return Object.entries(ls.profile.info_cache).map(([dir, p]) => ({ dir, name: p.name, email: p.user_name || '' }));
  } catch { return []; }
}

function parseSession(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'SNSS') return null;
  let off = 8;
  const tabs = {}, windows = {}, tabWindow = {}; // tabId -> {index, navs:{}, selected, closed}; windowId -> {closed, type}; tabId -> windowId
  const tab = (id) => (tabs[id] ||= { navs: {}, selected: 0, index: 0, closed: false });
  while (off + 3 <= buf.length) {
    const size = buf.readUInt16LE(off); const id = buf[off + 2];
    const p = buf.subarray(off + 3, off + 2 + size); off += 2 + size;
    if (p.length < 8 && ![16, 17].includes(id)) continue;
    try {
      if (id === 0) { tabWindow[p.readInt32LE(4)] = p.readInt32LE(0); }                  // SetTabWindow: {window_id, tab_id}
      else if (id === 2) { tab(p.readInt32LE(0)).index = p.readInt32LE(4); }          // SetTabIndexInWindow: tab_id, index
      else if (id === 7) { tab(p.readInt32LE(0)).selected = p.readInt32LE(4); }       // SetSelectedNavigationIndex: tab_id, index
      else if (id === 16) { tab(p.readInt32LE(0)).closed = true; }                     // TabClosed
      else if (id === 17) { (windows[p.readInt32LE(0)] ||= {}).closed = true; }        // WindowClosed
      else if (id === 9) { (windows[p.readInt32LE(0)] ||= {}).type = p.readInt32LE(4); }  // SetWindowType: 0 normal, 1 popup, 2 app (PWA), 4 app popup
      else if (id === 6) {                                                             // UpdateTabNavigation (pickle)
        let o = 4; // skip pickle header (payload size)
        const tabId = p.readInt32LE(o); o += 4; const navIdx = p.readInt32LE(o); o += 4;
        const ulen = p.readInt32LE(o); o += 4; const url = p.toString('utf8', o, o + ulen); o += (ulen + 3) & ~3;
        const tlen = p.readInt32LE(o); o += 4; const title = p.toString('utf16le', o, o + tlen * 2);
        tab(tabId).navs[navIdx] = { url, title };
      }
    } catch { /* truncated command; ignore */ }
  }
  return { tabs, windows, tabWindow };
}

function liveWindows(parsed) {
  const byWindow = {};
  for (const [idStr, t] of Object.entries(parsed.tabs)) {
    const id = +idStr; const win = parsed.tabWindow[id]; if (win == null) continue;
    if (t.closed || parsed.windows[win]?.closed) continue;
    const navKeys = Object.keys(t.navs).map(Number); if (!navKeys.length) continue;
    const nav = t.navs[t.selected] || t.navs[Math.max(...navKeys)];
    (byWindow[win] ||= []).push({ index: t.index, url: nav.url, title: nav.title });
  }
  const TYPES = { 0: 'normal', 1: 'popup', 2: 'app', 3: 'devtools', 4: 'app-popup' };
  return Object.entries(byWindow).map(([id, tabs]) => ({ id: +id, type: TYPES[parsed.windows[id]?.type] || 'normal', tabs: tabs.sort((a, b) => a.index - b.index) }));
}

export function profileWindows() {
  const out = [];
  for (const prof of listProfiles()) {
    for (const sub of ['Sessions', 'Sessions/Apps']) {   // Sessions/Apps holds PWA (web app) windows
      const sdir = path.join(ROOT, prof.dir, sub); if (!fs.existsSync(sdir)) continue;
      const files = fs.readdirSync(sdir).filter(f => f.startsWith('Session_')).map(f => ({ f, m: fs.statSync(path.join(sdir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
      if (!files.length) continue;
      const parsed = parseSession(path.join(sdir, files[0].f)); if (!parsed) continue;
      for (const w of liveWindows(parsed)) out.push({ profile: prof.name, email: prof.email, mtime: files[0].m, ...w, type: sub.endsWith('Apps') ? 'app' : w.type });
    }
  }
  return out;
}

const strip = (u) => String(u || '').replace(/#.*$/, '');
// Assign a profile to each AppleScript window ({id, tabs:[url]}). Exact ordered
// URL-list match first, then best set overlap (ties → most recently written session file).
export function assignProfiles(asWindows) {
  const pw = profileWindows(); const pwas = installedPWAs();
  const result = {};
  for (const w of asWindows) {
    const urls = w.tabs.map(String);
    let best = null, bestScore = 0;
    for (const cand of pw) {
      const curls = cand.tabs.map(t => String(t.url));
      const exact = curls.length === urls.length && curls.every((u, i) => u === urls[i]);
      const overlap = urls.filter(u => curls.includes(u)).length;                       // full-URL matches
      const loose = urls.filter(u => !curls.includes(u) && curls.map(strip).includes(strip(u))).length; // fragment-insensitive, weaker
      const score = (exact ? 1000 : 0) + overlap * 10 + loose * 2 - Math.abs(curls.length - urls.length) + (cand.mtime / 1e13);
      if ((overlap > 0 || loose > 1) && score > bestScore) { best = cand; bestScore = score; }
    }
    const origin = (() => { try { return new URL(w.tabs[0]).origin; } catch { return null; } })();
    const pwaName = origin && pwas[origin];
    result[w.id] = best ? { profile: best.profile, exact: bestScore >= 1000, type: best.type, pwa: best.type === 'app' ? (pwaName || 'PWA') : null } : (pwaName && w.tabs.length === 1 ? { profile: null, exact: false, type: 'app', pwa: pwaName } : null);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { execFileSync } = await import('node:child_process');
  const wins = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', `JSON.stringify(Application('Google Chrome').windows().map(w => ({ id: w.id(), tabs: w.tabs().map(t => t.url()) })))`], { encoding: 'utf8' }));
  const pw = profileWindows();
  console.log('profile windows:'); for (const w of pw) console.log(`  ${w.profile.padEnd(12)} ${w.type.padEnd(7)} win ${w.id} ${w.tabs.length} tabs: ${w.tabs.slice(0, 3).map(t => t.url.slice(0, 40)).join(' | ')}`);
  const a = assignProfiles(wins);
  console.log('assignments:'); for (const w of wins) console.log(`  as-win ${w.id} (${w.tabs.length} tabs, ${w.tabs[0].slice(0, 45)}) → ${JSON.stringify(a[w.id])}`);
}
