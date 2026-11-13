#!/usr/bin/env node
// timer.mjs — "wipe everything in N minutes". One timer at a time, shared by every entry point
// (the phone page via server.mjs, the app's chooser, the CLI).
//
//   node timer.mjs arm <minutes> [soft|hard|snapshot]   arm (replaces any armed timer); prints the fire time
//   node timer.mjs cancel                      disarm
//   node timer.mjs status [--json]             what's armed; --json: { armed, fireAt, mode, minutes, armedAt } or { armed: false }
//
// State lives in ~/slate/timer.json. Arming spawns a detached waiter (`timer.mjs wait <id>`) that
// checks the wall clock every few seconds (so a sleeping laptop fires on wake if the deadline passed
// while it slept), posts a notification 5 min and 1 min before, then launches the wipe through
// SlateWiper.app so it runs with the app's permissions, exactly like the phone button. Each tick it
// re-reads timer.json and exits quietly if its id is gone (cancelled or replaced), so cancelling is
// just deleting the file; the kill is a courtesy.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FILE = path.join(os.homedir(), 'slate', 'timer.json');
const LOG = path.join(os.homedir(), 'slate', 'timer.log');   // not app.log: the phone page shows app.log's latest run
const SELF = fileURLToPath(import.meta.url);
const MODE_ARGS = { soft: ['--go'], hard: ['--go', '--hard'], snapshot: ['--snapshot'] };
export const LABEL = { soft: 'soft wipe', hard: 'hard wipe', snapshot: 'snapshot' };
export const PRESETS = [5, 20, 60, 300];

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const clock = (ms) => new Date(ms).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
export const human = (min) => min < 60 ? `${+min.toFixed(1)} min` : `${+(min / 60).toFixed(2)} h`;
const log = (msg) => { try { fs.appendFileSync(LOG, `timer: ${new Date().toLocaleString('en-CA')} ${msg}\n`); } catch {} };
const notify = (title, body) => {
  try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { stdio: 'ignore', timeout: 10_000 }); } catch {}
};

export function status() {
  const t = read();
  if (!t) return { armed: false };
  if (!alive(t.pid)) { try { fs.unlinkSync(FILE); } catch {} return { armed: false }; } // waiter died (reboot, kill): not armed
  return { armed: true, fireAt: t.fireAt, mode: t.mode, minutes: t.minutes, armedAt: t.armedAt };
}

export function cancel() {
  const t = read();
  if (!t) return false;
  try { fs.unlinkSync(FILE); } catch {}
  if (alive(t.pid)) try { process.kill(t.pid); } catch {}
  log(`cancelled (was ${LABEL[t.mode]} at ${clock(t.fireAt)})`);
  return true;
}

export function arm(minutes, mode = 'soft') {
  minutes = Number(minutes);
  if (!(minutes > 0 && minutes <= 7 * 24 * 60)) throw new Error('minutes must be a number between 0 and 10080');
  if (!MODE_ARGS[mode]) throw new Error('mode must be soft | hard | snapshot');
  const prev = read(); if (prev) { try { fs.unlinkSync(FILE); } catch {} if (alive(prev.pid)) try { process.kill(prev.pid); } catch {} }
  const armedAt = Date.now(), fireAt = armedAt + minutes * 60e3, id = `${armedAt}-${process.pid}`;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [SELF, 'wait', id], { detached: true, stdio: ['ignore', out, out] });
  child.unref(); fs.closeSync(out);
  const t = { id, pid: child.pid, armedAt, fireAt, minutes, mode };
  fs.writeFileSync(FILE, JSON.stringify(t, null, 2));
  log(`armed: ${LABEL[mode]} at ${clock(fireAt)} (in ${human(minutes)})`);
  return { armed: true, fireAt, mode, minutes, armedAt };
}

async function wait(id) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const mine = () => { const t = read(); return t?.id === id ? t : null; };
  let t = mine(); if (!t) return;
  const total = t.fireAt - t.armedAt;
  const warnings = [5, 1].map(m => m * 60e3).filter(w => total >= 2 * w);   // 5-min warning only on timers ≥10 min, 1-min on ≥2 min
  while ((t = mine())) {
    const left = t.fireAt - Date.now();
    if (left <= 0) break;
    while (warnings.length && left <= warnings[0]) {
      const w = warnings.shift();
      if (left > w - 30e3) notify('SlateWiper', `${LABEL[t.mode][0].toUpperCase() + LABEL[t.mode].slice(1)} in ${w / 60e3} min (${clock(t.fireAt)}). Cancel from the phone, the app, or \`slate timer cancel\`.`);
    }
    await sleep(Math.min(5000, Math.max(250, left)));
  }
  if (!t) return;   // cancelled / replaced
  try { fs.unlinkSync(FILE); } catch {}
  const late = Date.now() - t.fireAt;
  log(`firing ${LABEL[t.mode]}${late > 60e3 ? ` (${Math.round(late / 60e3)} min late; the Mac was probably asleep)` : ''}`);
  if (process.env.SLATE_TIMER_DRY) return log(`(dry run: would open -a SlateWiper --args ${MODE_ARGS[t.mode].join(' ')})`);
  // -n: if SlateWiper is already open (the chooser window, another wipe), plain `open -a` just activates
  // that instance and silently drops --args, so the timer would fire into nothing.
  const appLog = path.join(os.homedir(), 'slate', 'app.log');
  const size = () => { try { return fs.statSync(appLog).size; } catch { return 0; } };
  const before = size();
  const c = spawn('open', ['-n', '-a', 'SlateWiper', '--args', ...MODE_ARGS[t.mode], '--timer-fired'], { stdio: 'ignore', detached: true });
  c.on('error', (e) => log(`failed to launch SlateWiper: ${e.message}`));
  c.unref();
  // app-main.sh writes "=== <date> slatewipe ..." to app.log first thing; if that never shows up, say so loudly.
  for (let i = 0; i < 30; i++) { await sleep(1000); if (size() > before) return log('wipe started'); }
  log('wipe did NOT start (no app.log entry 30 s after launching SlateWiper)');
  notify('SlateWiper', `The timer fired but the ${LABEL[t.mode]} didn't start. Run it by hand; see ~/slate/timer.log.`);
}

// ---------- CLI ----------
if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'wait') await wait(a);
  else if (cmd === 'arm') {
    try { const s = arm(a, b || 'soft'); console.log(`${LABEL[s.mode]} at ${clock(s.fireAt)} (in ${human(s.minutes)}). \`slate timer cancel\` to disarm.`); }
    catch (e) { console.error(e.message); process.exit(2); }
  }
  else if (cmd === 'cancel') console.log(cancel() ? 'timer cancelled' : 'no timer armed');
  else if (cmd === 'status' || !cmd) {
    const s = status();
    if (process.argv.includes('--json')) console.log(JSON.stringify(s));
    else console.log(s.armed ? `${LABEL[s.mode]} at ${clock(s.fireAt)} (${human((s.fireAt - Date.now()) / 60e3)} left)` : 'no timer armed');
  }
  else { console.error('usage: timer.mjs arm <minutes> [soft|hard|snapshot] | cancel | status'); process.exit(2); }
}
