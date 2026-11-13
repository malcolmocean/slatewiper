#!/usr/bin/env node
// server.mjs — the slate button, over HTTP. For the phone (android/), or any browser on the LAN.
//
//   GET  /?t=TOKEN        the page: Soft wipe / Hard wipe / Snapshot, plus the live log
//   POST /run {mode, noRoam}  mode = soft | hard | snapshot; noRoam:true skips the Roam push. 409 if a run is in progress.
//   GET  /status          { running, mode, startedAt, finishedAt, output, timer }
//   POST /timer {minutes, mode}  arm "wipe in N minutes" (mode soft | hard | snapshot; replaces any armed timer). See timer.mjs.
//   POST /timer/cancel    disarm
//   GET  /ping            { slatewiper: true, host } — no token; what the phone probes to find this Mac
//
// Runs are launched through SlateWiper.app (`open -W -a SlateWiper --args ...`) so macOS
// attributes Screen Recording / Automation to the app, same as Spotlight or Keyboard Maestro.
// Output is whatever app-main.sh appended to ~/slate/app.log during the run.
//
// Every request needs the token (SLATE_SERVER_TOKEN in mine/.env, generated on first start) as
// ?t=... or an X-Slate-Token header. The server is plain HTTP; the token is what keeps a
// shared wifi from wiping your slate.
//
// Bind address: server.bind in the config (SLATE_SERVER_BIND overrides). Default 0.0.0.0 = every
// interface, so the phone can reach it over the LAN. 127.0.0.1 = loopback only: nothing on the
// wifi can see it, and it is reached through the Cloudflare Tunnel and/or `tailscale serve`
// (both connect to localhost). Bonjour advertising (_slatewiper._tcp via dns-sd, so the phone can
// find the Mac without knowing its IP) only happens when bound to every interface.
//
// Port: server.port in the config (SLATE_SERVER_PORT overrides). Started at login by the LaunchAgent install.sh --server writes.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { CONFIG, ENV_FILE } from './config.mjs';
import * as timer from './timer.mjs';

const HOME = os.homedir();
const LOG = path.join(HOME, 'slate', 'app.log');
const PORT = +(process.env.SLATE_SERVER_PORT || CONFIG.server?.port || 7337);
const BIND = process.env.SLATE_SERVER_BIND || CONFIG.server?.bind || '0.0.0.0';
const LAN = BIND === '0.0.0.0' || BIND === '::';

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

// A wipe this server didn't launch: the timer firing, the app from Spotlight, the CLI.
const externalRun = () => { try { return !!execFileSync('pgrep', ['-f', 'slatewipe\\.mjs.* --(go|snapshot)'], { encoding: 'utf8' }).trim(); } catch { return false; } };

function start(mode, noRoam) {
  if (run.running || externalRun()) return false;
  Object.assign(run, { running: true, mode, startedAt: Date.now(), finishedAt: null, offset: logSize(), exit: null });
  const child = spawn('open', ['-W', '-a', 'SlateWiper', '--args', ...MODES[mode], ...(noRoam ? ['--no-roam'] : [])], { stdio: 'ignore' });
  child.on('exit', (code) => Object.assign(run, { running: false, finishedAt: Date.now(), exit: code }));
  child.on('error', (e) => { fs.appendFileSync(LOG, `server: failed to launch SlateWiper: ${e.message}\n`); Object.assign(run, { running: false, finishedAt: Date.now(), exit: -1 }); });
  return true;
}

const status = () => {
  const ext = !run.running && externalRun();
  return { running: run.running || ext, mode: ext ? null : run.mode, startedAt: ext ? null : run.startedAt, finishedAt: run.finishedAt, exit: run.exit,
    output: run.startedAt ? logSince(run.offset) : lastRunFromLog(), timer: timer.status(), now: Date.now() };
};

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
  .timer{margin-top:12px;background:var(--board);border-radius:16px;padding:14px 16px}
  .timer .hd{display:flex;justify-content:space-between;align-items:center;font-size:15px;font-weight:600;color:var(--chalk);margin-bottom:10px}
  .timer .hd label{font-size:13px;font-weight:400;color:var(--dim);display:flex;align-items:center;gap:6px}
  .chips{display:grid;grid-template-columns:repeat(4,1fr) 1.3fr;gap:8px}
  .chips button,.timer .cancel{padding:12px 0;border-radius:10px;font-size:16px;text-align:center;background:#2b5e4f}
  .chips input{width:100%;min-width:0;border:0;border-radius:10px;padding:0 10px;font:inherit;font-size:16px;background:#0f2620;color:var(--chalk)}
  .armed{display:flex;align-items:center;gap:12px}
  .armed .big{flex:1;font:600 30px/1.1 ui-monospace,Menlo,monospace;color:var(--chalk)}
  .armed .big small{display:block;font:13px/1.4 -apple-system,system-ui,Roboto,sans-serif;color:var(--dim);margin-top:4px}
  .timer .cancel{padding:12px 18px}
  .timer.hot{background:#5a2a22}
  .spin{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid var(--dim);border-top-color:transparent;animation:r .8s linear infinite;vertical-align:-1px;margin-right:6px}@keyframes r{to{transform:rotate(360deg)}}
</style></head><body>
<h1>SlateWiper</h1>
<div class="btns">
  <button class="soft" data-mode="soft">Soft wipe<small>archive, then close what needs no confirmation</small></button>
  <button class="hard" data-mode="hard">Hard wipe<small>also kill working sessions, disarm unsaved-state checks</small></button>
  <button data-mode="snapshot">Snapshot<small>archive only, close nothing</small></button>
</div>
<div class="timer" id="timer">
  <div id="arm">
    <div class="hd"><span>In… <select id="tmode"><option value="soft">soft wipe</option><option value="hard">hard wipe</option><option value="snapshot">snapshot</option></select></span></div>
    <div class="chips">
      <button data-min="5">5m</button><button data-min="20">20m</button><button data-min="60">1h</button><button data-min="300">5h</button>
      <input id="custom" type="number" inputmode="decimal" min="1" placeholder="min ↵" enterkeyhint="go">
    </div>
  </div>
  <div id="armedbox" class="armed" hidden>
    <div class="big"><span id="left"></span><small id="when"></small></div>
    <button class="cancel" id="cancel">Cancel</button>
  </div>
</div>
<div id="st"></div>
<pre id="out"></pre>
<script>
const T = new URLSearchParams(location.search).get('t') || '';
const H = { 'X-Slate-Token': T, 'Content-Type': 'application/json' };
try { Object.assign(H, JSON.parse(window.SlateApp.accessHeaders())); } catch (e) {}   // Cloudflare Access service token, from the Android app
const $ = (s) => document.querySelector(s);
const btns = [...document.querySelectorAll('button[data-mode]')];
let timer = null, armed = null, skew = 0, tick = null;
const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? h + ':' + String(m).padStart(2, '0') + ':' + x : m + ':' + x; };
function renderTimer() {
  $('#arm').hidden = !!armed; $('#armedbox').hidden = !armed;
  if (!armed) { $('#timer').classList.remove('hot'); return; }
  const left = armed.fireAt - (Date.now() + skew);
  $('#left').textContent = fmt(left);
  $('#when').textContent = (armed.mode === 'snapshot' ? 'snapshot' : armed.mode + ' wipe') + ' at ' + new Date(armed.fireAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  $('#timer').classList.toggle('hot', left < 60e3);
}
setInterval(() => { if (armed) { renderTimer(); if (armed.fireAt - (Date.now() + skew) < -2000 && !timer) poll(); } }, 1000);
async function arm(min) {
  if (!(min > 0)) return;
  const r = await fetch('/timer', { method: 'POST', headers: H, body: JSON.stringify({ minutes: min, mode: $('#tmode').value }) });
  if (!r.ok) $('#st').textContent = 'error: ' + (await r.text());
  clearTimeout(timer); poll();
}
document.querySelectorAll('.chips button').forEach((b) => b.onclick = () => arm(+b.dataset.min));
$('#custom').addEventListener('keydown', (e) => { if (e.key === 'Enter') { arm(+e.target.value); e.target.value = ''; e.target.blur(); } });
$('#custom').addEventListener('change', (e) => { if (e.target.value) { arm(+e.target.value); e.target.value = ''; } });
$('#cancel').onclick = async () => { await fetch('/timer/cancel', { method: 'POST', headers: H }); clearTimeout(timer); poll(); };
const linkify = (s) => s.replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/https?:\\/\\/\\S+/g, (u) => '<a href="' + u + '" target="_blank">' + u + '</a>');
async function poll() {
  let s; try { s = await (await fetch('/status', { headers: H })).json(); } catch (e) { $('#st').textContent = 'server unreachable'; return; }
  btns.forEach((b) => b.disabled = s.running);
  armed = s.timer && s.timer.armed ? s.timer : null; skew = s.now - Date.now(); renderTimer();
  $('#out').innerHTML = linkify(s.output || '');
  $('#out').scrollTop = 1e9;
  if (s.running) { $('#st').innerHTML = '<span class="spin"></span>' + (s.mode ? s.mode + ' wipe running… ' + Math.round((Date.now() - s.startedAt) / 1000) + 's' : 'wipe running…'); timer = setTimeout(poll, 1000); }
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
  if (req.method === 'POST' && url.pathname === '/timer/cancel') { timer.cancel(); return send(200, timer.status()); }
  if (req.method === 'POST' && url.pathname === '/timer') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      let minutes, mode; try { ({ minutes, mode } = JSON.parse(body || '{}')); } catch {}
      try { send(200, timer.arm(minutes, mode || 'soft')); } catch (e) { send(400, e.message, 'text/plain'); }
    });
    return;
  }
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
server.listen(PORT, BIND, () => console.log(`slatewiper server on http://${BIND}:${PORT}/?t=${TOKEN}${LAN ? '' : ' (loopback only: no LAN access, no Bonjour)'}`));

// Bonjour: "SlateWiper" _slatewiper._tcp on this port, for the phone's LAN discovery. Only when the LAN can reach us.
let advert = null;
(function advertise() {
  if (!LAN) return;
  advert = spawn('dns-sd', ['-R', 'SlateWiper', '_slatewiper._tcp', '.', String(PORT)], { stdio: 'ignore' });
  advert.on('exit', () => setTimeout(advertise, 5000));
  advert.on('error', (e) => console.log(`dns-sd unavailable: ${e.message}`));
})();
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { advert?.removeAllListeners('exit'); advert?.kill(); process.exit(0); });
