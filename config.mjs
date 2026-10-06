// Where your own settings live: mine/ (gitignored here; make it its own private repo if
// you want it versioned). mine/slatewipe.config.json overrides the example config,
// mine/.env holds tokens. Anything personal goes in mine/, never in the code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MINE = path.join(HERE, 'mine');
export const ENV_FILE = path.join(MINE, '.env');
export const CONFIG_FILE = [path.join(MINE, 'slatewipe.config.json'), path.join(HERE, 'slatewipe.config.example.json')].find(f => fs.existsSync(f));
export const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

export const loadEnv = () => {
  const e = {};
  for (const l of (fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) e[m[1]] = m[2]; }
  return e;
};

// `node config.mjs get server.tunnel` → prints a config value (for the shell scripts)
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'get') {
  const v = process.argv[3].split('.').reduce((o, k) => o?.[k], { ...CONFIG, configFile: CONFIG_FILE, env: loadEnv() });
  process.stdout.write(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
}
