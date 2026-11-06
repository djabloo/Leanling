// Impostazioni e stato di Leanling, tutto in ~/.leanling (o $LEANLING_HOME).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.LEANLING_HOME ?? join(homedir(), '.leanling');
for (const d of ['', 'work', 'runs', 'patches']) mkdirSync(join(HOME, d), { recursive: true, mode: 0o700 });

const DEFAULTS = {
  agent: {
    type: 'none', // none | claude | opencode
    auth: 'subscription', // subscription | api (solo Claude Code)
    apiKey: '',
    model: '',
    review: true, // l'agente legge le novita' prima dell'installazione
    fixPatches: true, // l'agente sistema le patch che non si applicano piu'
  },
  scanners: { osv: true, guarddog: true, gitleaks: true, clamav: false },
  keepVersions: 2, // versione in uso + precedente
  recipes: {},
};

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Scrittura atomica: mai un file a meta' se il processo si ferma
function writeJson(file, data, mode = 0o600) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode });
  renameSync(`${file}.tmp`, file);
}

const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
};

const CONFIG = join(HOME, 'config.json');
const STATE = join(HOME, 'state.json');

export const loadConfig = () => merge(DEFAULTS, readJson(CONFIG, {}));
export const saveConfig = (cfg) => writeJson(CONFIG, cfg);
export const loadState = () => readJson(STATE, {});
export const saveState = (state) => writeJson(STATE, state);

/** Impostazioni dell'utente per una ricetta: scelte, contenitore, cose da pubblicare */
export function recipeSettings(cfg, name) {
  return merge({ choices: {}, container: {}, extraOptions: [], publishAs: '', deploy: false }, cfg.recipes[name]);
}

/** Configurazione senza segreti, da mostrare nella dashboard */
export function publicConfig(cfg) {
  return { ...cfg, agent: { ...cfg.agent, apiKey: cfg.agent.apiKey ? '••••' + cfg.agent.apiKey.slice(-4) : '' } };
}

export const exists = existsSync;
