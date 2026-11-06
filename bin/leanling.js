#!/usr/bin/env node
import { loadConfig, loadState, saveConfig } from '../src/config.js';
import { addRecipe } from '../src/add.js';
import { agentStatus } from '../src/agent.js';
import { clean, promote, rollback, update } from '../src/pipeline.js';
import { listRecipes, removeRecipe } from '../src/recipes.js';
import { scannerStatus } from '../src/scan.js';
import { startServer } from '../src/server.js';

const HELP = `Leanling: figli snelli dei programmi self-hosted

  leanling list                      ricette disponibili e versione in uso
  leanling add <url-git|immagine>    crea una ricetta nuova (--name nome, --no-agent)
  leanling remove <ricetta>          toglie una ricetta creata da te
  leanling update <ricetta>          prepara e prova il figlio della nuova versione
        --force                      rifallo anche se la versione non è cambiata
        --deploy                     se le prove passano, installalo subito
  leanling install <ricetta>         installa il figlio pronto
  leanling rollback <ricetta>        torna alla versione precedente
  leanling clean <ricetta>           toglie le immagini vecchie (--build-cache: anche la cache di Docker)
  leanling doctor                    agente e scanner disponibili
  leanling agent <none|claude|opencode> [--api]   sceglie l'agente (--api: Claude Code con chiave API)
  leanling dashboard [--port 7878]   apre la dashboard su 127.0.0.1
`;

const [cmd, name, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f) || name === f;
const exitWith = (r) => process.exit(r.status === 'errore' ? 1 : 0);

switch (cmd) {
  case 'list': {
    const state = loadState();
    for (const r of listRecipes()) {
      const s = state[r.name] ?? {};
      console.log(`${r.name.padEnd(14)} ${(s.current?.version ?? '-').padEnd(12)} ${s.candidate ? `pronto: ${s.candidate.version}` : ''}`);
    }
    break;
  }
  case 'add': {
    const i = rest.indexOf('--name');
    exitWith(await addRecipe(need(name), { name: i >= 0 ? rest[i + 1] : undefined, analyze: !flag('--no-agent'), echo: true }));
    break;
  }
  case 'remove':
    removeRecipe(need(name));
    console.log(`Ricetta ${name} tolta (le immagini restano: leanling clean prima di toglierla, se vuoi liberare spazio)`);
    break;
  case 'update':
    exitWith(await update(need(name), { force: flag('--force'), deploy: flag('--deploy'), echo: true }));
    break;
  case 'install':
    exitWith(await promote(need(name), { echo: true }));
    break;
  case 'rollback':
    exitWith(await rollback(need(name), { echo: true }));
    break;
  case 'clean':
    exitWith(await clean(need(name), { echo: true, buildCache: flag('--build-cache') }));
    break;
  case 'doctor': {
    const cfg = loadConfig();
    const a = agentStatus(cfg);
    console.log(`agente: ${a.ready ? 'pronto' : 'non attivo'} (${a.reason})`);
    for (const [id, s] of Object.entries(scannerStatus(cfg))) {
      console.log(`${id.padEnd(9)} ${s.installed ? 'installato' : 'manca     '} ${s.enabled ? 'attivo' : 'spento'}  ${s.what}${s.installed ? '' : `  → ${s.install}`}`);
    }
    break;
  }
  case 'agent': {
    if (!['none', 'claude', 'opencode'].includes(name)) die('Agente: none, claude o opencode');
    const cfg = loadConfig();
    cfg.agent.type = name;
    cfg.agent.auth = flag('--api') ? 'api' : 'subscription';
    if (cfg.agent.auth === 'api' && process.env.ANTHROPIC_API_KEY) cfg.agent.apiKey = process.env.ANTHROPIC_API_KEY;
    saveConfig(cfg);
    console.log(agentStatus(cfg).reason);
    break;
  }
  case 'dashboard': {
    const i = rest.indexOf('--port');
    const port = Number(i >= 0 ? rest[i + 1] : name === '--port' ? rest[0] : process.env.LEANLING_PORT ?? 7878);
    startServer({ port });
    break;
  }
  default:
    console.log(HELP);
}

function need(n) {
  if (!n || n.startsWith('--')) die('Manca il nome della ricetta (leanling list)');
  return n;
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}
