#!/usr/bin/env node
// server.mjs — the slate button, over HTTP. For the phone (android/), or any browser on the LAN.
//
//   GET  /?t=TOKEN        the page: Soft wipe / Hard wipe / Snapshot, plus the live log
//   POST /run {mode, noRoam}  mode = soft | hard | snapshot; noRoam:true skips the Roam push. 409 if a run is in progress.
//   GET  /status          { running, mode, startedAt, finishedAt, output }
//   GET  /ping            { slatewiper: true, host } — no token; what the phone probes to find this Mac
//
// Runs are launched through SlateWiper.app (`open -W -a SlateWiper --args ...`) so macOS
// attributes Screen Recording / Automation to the app, same as Spotlight or Keyboard Maestro.
// Output is whatever app-main.sh appended to ~/slate/app.log during the run.
//
// Every request needs the token (SLATE_SERVER_TOKEN in mine/.env, generated on first start) as
// ?t=... or an X-Slate-Token header. The server is plain HTTP on every interface; the
// token is what keeps a shared wifi from wiping your slate.
//
// Also advertises itself on the LAN as _slatewiper._tcp (Bonjour, via dns-sd) so the phone can find
// the Mac without knowing its IP.
//
// Port: server.port in the config (SLATE_SERVER_PORT overrides). Started at login by the LaunchAgent install.sh --server writes.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { CONFIG, ENV_FILE } from './config.mjs';

const HOME = os.homedir();
const LOG = path.join(HOME, 'slate', 'app.log');
const PORT = +(process.env.SLATE_SERVER_PORT || CONFIG.server?.port || 7337);

function token() {
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const m = env.match(/^\s*SLATE_SERVER_TOKEN\s*=\s*"?([^"\s]+)"?\s*$/m);
  if (m) return m[1];
  const t = crypto.randomBytes(12).toString('base64url');
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.appendFileSync(ENV_FILE, `${env && !env.endsWith('\n') ? '\n' : ''}SLATE_SERVER_TOKEN=${t}\n`);
  return t;
}
const TOKEN = token();

const MODES = { soft: ['--go'], hard: ['--go', '--hard'], snapshot: ['--snapshot'] };
const run = { running: false, mode: null, startedAt: null, finishedAt: null, offset: 0, exit: null };

const logSize = () => { try { return fs.statSync(LOG).size; } catch { return 0; } };
const logSince = (off) => {
  try { const fd = fs.openSync(LOG, 'r'); const size = Math.max(0, logSize() - off); const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, off); fs.closeSync(fd); return buf.toString('utf8'); }
  catch { return ''; }
};
const lastRunFromLog = () => { // output of the most recent "=== ... slatewipe ..." block, for the page's first paint
  try { const txt = fs.readFileSync(LOG, 'utf8'); const i = txt.lastIndexOf('\n=== '); return i < 0 ? txt : txt.slice(i + 1); } catch { return ''; }
};

function start(mode, noRoam) {
  if (run.running) return false;
  Object.assign(run, { running: true, mode, startedAt: Date.now(), finishedAt: null, offset: logSize(), exit: null });
  const child = spawn('open', ['-W', '-a', 'SlateWiper', '--args', ...MODES[mode], ...(noRoam ? ['--no-roam'] : [])], { stdio: 'ignore' });
  child.on('exit', (code) => Object.assign(run, { running: false, finishedAt: Date.now(), exit: code }));
  child.on('error', (e) => { fs.appendFileSync(LOG, `server: failed to launch SlateWiper: ${e.message}\n`); Object.assign(run, { running: false, finishedAt: Date.now(), exit: -1 }); });
  return true;
}

const status = () => ({ running: run.running, mode: run.mode, startedAt: run.startedAt, finishedAt: run.finishedAt, exit: run.exit,
  output: run.startedAt ? logSince(run.offset) : lastRunFromLog() });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>SlateWiper</title>
<style>
  :root{--bg:#17352c;--board:#1f4a3d;--ink:#e8efe9;--dim:#9db5aa;--chalk:#f3efe0;--blue:#2d5bd1;--red:#b8412f}
  *{box-sizing:border-box}html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.4 -apple-system,system-ui,Roboto,sans-serif;display:flex;flex-direction:column;padding:max(16px,env(safe-area-inset-top)) 16px max(16px,env(safe-area-inset-bottom))}
  h1{font-size:15px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 14px}
  .btns{display:grid;gap:12px}
  button{appearance:none;border:0;border-radius:16px;padding:22px 18px;font:inherit;font-size:20px;font-weight:600;color:var(--chalk);background:var(--board);text-align:left;cursor:pointer}
  button small{display:block;font-size:13px;font-weight:400;color:var(--dim);margin-top:4px}
  button.soft{background:var(--blue)}button.soft small{color:#cfdcff}
  button.hard{background:var(--red)}button.hard small{color:#ffd9d2}
  button:disabled{opacity:.45}
  #st{margin:18px 0 6px;font-size:13px;color:var(--dim);min-height:1.4em}
  pre{flex:1;margin:0;background:#0f2620;color:#d7e3dc;border-radius:12px;padding:12px;font:13px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto;min-height:120px}
  a{color:#9ec0ff}
  .spin{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid var(--dim);border-top-color:transparent;animation:r .8s linear infinite;vertical-align:-1px;margin-right:6px}@keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
<h1>SlateWiper</h1>
<div class="btns">
  <button class="soft" data-mode="soft">Soft wipe<small>archive, then close what needs no confirmation</small></button>
  <button class="hard" data-mode="hard">Hard wipe<small>also kill working sessions, disarm unsaved-state checks</small></button>
  <button data-mode="snapshot">Snapshot<small>archive only, close nothing</small></button>
</div>
<div id="st"></div>
<pre id="out"></pre>
<script>
const T = new URLSearchParams(location.search).get('t') || '';
const H = { 'X-Slate-Token': T, 'Content-Type': 'application/json' };
try { Object.assign(H, JSON.parse(window.SlateApp.accessHeaders())); } catch (e) {}   // Cloudflare Access service token, from the Android app
const $ = (s) => document.querySelector(s);
const btns = [...document.querySelectorAll('button')];
let timer = null;
const linkify = (s) => s.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/https?:\\/\\/\\S+/g, (u) => '<a href="' + u + '" target="_blank">' + u + '</a>');
async function poll() {
  let s; try { s = await (await fetch('/status', { headers: H })).json(); } catch (e) { $('#st').textContent = 'server unreachable'; return; }
  btns.forEach((b) => b.disabled = s.running);
  $('#out').innerHTML = linkify(s.output || '');
  $('#out').scrollTop = 1e9;
  if (s.running) { $('#st').innerHTML = '<span class="spin"></span>' + s.mode + ' wipe running… ' + Math.round((Date.now() - s.startedAt) / 1000) + 's'; timer = setTimeout(poll, 1000); }
  else { $('#st').textContent = s.finishedAt ? 'done ' + new Date(s.finishedAt).toLocaleTimeString() + (s.exit ? ' (exit ' + s.exit + ')' : '') : (s.output ? 'last run' : 'ready'); timer = null; }
}
btns.forEach((b) => b.onclick = async () => {
  btns.forEach((x) => x.disabled = true); $('#out').textContent = ''; $('#st').innerHTML = '<span class="spin"></span>starting…';
  const r = await fetch('/run', { method: 'POST', headers: H, body: JSON.stringify({ mode: b.dataset.mode }) });
  if (!r.ok) $('#st').textContent = 'error: ' + (await r.text());
  clearTimeout(timer); poll();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && !timer) poll(); });
poll();
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const t = req.headers['x-slate-token'] || url.searchParams.get('t') || '';
  const ok = t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  if (req.method === 'GET' && url.pathname === '/ping') return send(200, { slatewiper: true, host: os.hostname() });
  if (!ok) return send(403, 'forbidden (bad or missing token)', 'text/plain');
  if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html');
  if (req.method === 'GET' && url.pathname === '/status') return send(200, status());
  if (req.method === 'POST' && url.pathname === '/run') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let mode, noRoam; try { ({ mode, noRoam } = JSON.parse(body || '{}')); } catch {}
      if (!MODES[mode]) return send(400, 'mode must be soft | hard | snapshot', 'text/plain');
      if (!start(mode, !!noRoam)) return send(409, 'a run is already in progress', 'text/plain');
      send(202, { started: mode });
    });
    return;
  }
  send(404, 'not found', 'text/plain');
});
server.listen(PORT, '0.0.0.0', () => console.log(`slatewiper server on http://0.0.0.0:${PORT}/?t=${TOKEN}`));

// Bonjour: "SlateWiper" _slatewiper._tcp on this port, for the phone's LAN discovery.
let advert = null;
(function advertise() {
  advert = spawn('dns-sd', ['-R', 'SlateWiper', '_slatewiper._tcp', '.', String(PORT)], { stdio: 'ignore' });
  advert.on('exit', () => setTimeout(advertise, 5000));
  advert.on('error', (e) => console.log(`dns-sd unavailable: ${e.message}`));
})();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { advert?.removeAllListeners('exit'); advert?.kill(); process.exit(0); });
