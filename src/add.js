// "Aggiungi programma": da un URL git o da un'immagine Docker a una ricetta pronta da rivedere.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentStatus, askAgent } from './agent.js';
import { HOME, loadConfig } from './config.js';
import { finish, logger, newRun, step } from './pipeline.js';
import { listRecipes, NAME, writeRecipe } from './recipes.js';
import { run } from './sh.js';

export const isGit = (src) => /^(https?:\/\/|git@)/.test(src) || src.endsWith('.git');

/** Nome della ricetta dall'URL o dall'immagine: ultimo pezzo, minuscolo, senza tag */
export function nameFrom(src) {
  const last = src.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).filter(Boolean);
  const base = isGit(src) ? last.at(-1) : src.replace(/[:@][^/]*$/, '').split('/').at(-1);
  return (base ?? 'programma').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'programma';
}

/** Porta, percorso del controllo di salute e volumi letti da un Dockerfile */
export function parseDockerfile(text) {
  const port = Number(text.match(/^\s*EXPOSE\s+(\d+)/im)?.[1]) || null;
  const hc = text.match(/^\s*HEALTHCHECK[\s\S]*?(?:\n(?!\s)|$)/im)?.[0] ?? '';
  const path = hc.match(/https?:\/\/[^/\s"'$]+(?::\d+)?(\/[^\s"'\\)]*)/)?.[1] ?? null;
  const volumes = [...text.matchAll(/^\s*VOLUME\s+(.+)$/gim)].flatMap((m) => m[1].replace(/[[\]",]/g, ' ').split(/\s+/).filter(Boolean));
  return { port, path, volumes };
}

const guessLicense = (dir) => {
  const f = readdirSync(dir).find((x) => /^licen[sc]e(\.md|\.txt)?$/i.test(x));
  if (!f) return 'Licenza non trovata: controllala prima di usarlo';
  const t = readFileSync(join(dir, f), 'utf8').slice(0, 3000);
  for (const [re, name] of [[/Sustainable Use License/i, 'Sustainable Use License (uso interno o non commerciale)'], [/GNU AFFERO/i, 'AGPL-3.0'], [/GNU GENERAL PUBLIC LICENSE/i, 'GPL'], [/GNU LESSER/i, 'LGPL'], [/Apache License/i, 'Apache-2.0'], [/MIT License|Permission is hereby granted, free of charge/i, 'MIT'], [/Business Source License/i, 'Business Source License (non open source)'], [/Elastic License/i, 'Elastic License (non open source)'], [/BSD/i, 'BSD']]) {
    if (re.test(t)) return name;
  }
  return `Licenza in ${f}: leggila prima di usarlo`;
};

const MANIFESTS = ['requirements.txt', 'package.json', 'package-lock.json'];

/**
 * Crea la ricetta e, se c'e' un agente, gli fa proporre opzioni e patch.
 * La ricetta finisce in ~/.leanling/recipes: niente di personale nella repo di Leanling.
 */
export async function addRecipe(src, { name, analyze = true, echo = false } = {}) {
  src = src.trim();
  name = (name || nameFrom(src)).toLowerCase();
  if (!NAME.test(name)) throw new Error(`Nome non valido: ${name} (minuscole, numeri e trattini)`);
  if (listRecipes().some((r) => r.name === name)) throw new Error(`Esiste già una ricetta "${name}": scegli un altro nome`);

  const r = newRun(name, 'aggiungi');
  const log = logger(r, echo);
  const work = join(HOME, 'work', name, 'analisi');
  try {
    const cfg = loadConfig();
    let recipe;
    let srcDir = null; // sorgente da far leggere all'agente

    if (isGit(src)) {
      recipe = await step(r, log, 'Scarico il progetto', async () => {
        rmSync(work, { recursive: true, force: true });
        const c = await run('git', ['clone', '--depth', '1', src, work]);
        if (c.code !== 0) throw new Error(c.err.trim());
        const ref = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: work })).out.trim() || 'main';
        const dockerfile = ['Dockerfile', 'docker/Dockerfile', 'Dockerfile.prod', 'deploy/Dockerfile', 'build/Dockerfile'].find((f) => existsSync(join(work, f)));
        if (!dockerfile) throw new Error('Nel progetto non c\'è un Dockerfile. Per ora Leanling costruisce solo progetti con un Dockerfile: se esiste un\'immagine ufficiale, aggiungi quella.');
        const d = parseDockerfile(readFileSync(join(work, dockerfile), 'utf8'));
        srcDir = work;
        return {
          status: d.port ? 'ok' : 'avviso',
          detail: `ramo ${ref}, ${dockerfile}${d.port ? `, porta ${d.port}` : ', nessuna porta dichiarata (EXPOSE): impostala tu'}`,
          recipe: {
            name, title: name, type: 'build', repo: src, ref, upstream: src.replace(/\.git$/, ''), dockerfile,
            license: guessLicense(work),
            manifests: MANIFESTS.filter((m) => existsSync(join(work, m))),
            ...baseParts(name, d),
          },
        };
      }).then((x) => x.recipe);
    } else {
      recipe = await step(r, log, 'Scarico l\'immagine', async () => {
        const ref = src.includes(':') && !src.endsWith(':') ? src : `${src}:latest`;
        const p = await run('docker', ['pull', '-q', ref]);
        if (p.code !== 0) throw new Error(p.err.trim());
        const info = JSON.parse((await run('docker', ['image', 'inspect', ref])).out)[0].Config;
        const port = Number(Object.keys(info.ExposedPorts ?? {})[0]?.split('/')[0]) || null;
        const hc = (info.Healthcheck?.Test ?? []).join(' ');
        const path = hc.match(/https?:\/\/[^/\s"']+(?::\d+)?(\/[^\s"'\\)]*)/)?.[1] ?? null;
        const labels = info.Labels ?? {};
        const upstream = labels['org.opencontainers.image.source'] ?? '';
        const [image, tag] = [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)];
        return {
          status: port ? 'ok' : 'avviso',
          detail: `${ref}${port ? `, porta ${port}` : ', nessuna porta dichiarata: impostala tu'}`,
          recipe: {
            name, title: labels['org.opencontainers.image.title'] || name, type: 'image', image, tag, upstream,
            license: labels['org.opencontainers.image.licenses'] || 'Licenza non dichiarata nell\'immagine: controllala',
            ...baseParts(name, { port, path, volumes: Object.keys(info.Volumes ?? {}) }),
          },
        };
      }).then((x) => x.recipe);

      // Per l'analisi serve il sorgente: se l'immagine dice da dove viene, lo scarico
      if (analyze && /^https:\/\/github\.com\//.test(recipe.upstream)) {
        rmSync(work, { recursive: true, force: true });
        const c = await run('git', ['clone', '--depth', '1', recipe.upstream, work]);
        if (c.code === 0) srcDir = work;
      }
    }

    writeRecipe(recipe);
    log(`ricetta di base salvata in ${join(HOME, 'recipes', name)}`);

    if (analyze && agentStatus(cfg).ready && srcDir) {
      await step(r, log, 'Analisi dell\'agente', async () => {
        const proposal = await analyzeWithAgent(cfg, recipe, srcDir, log);
        const notes = [];
        recipe.description = proposal.description || recipe.description;
        recipe.title = proposal.title || recipe.title;
        recipe.notes = proposal.notes ?? '';
        recipe.options = cleanOptions(proposal.options, notes);
        if (recipe.type === 'build') recipe.patches = await savePatches(recipe, proposal.patches ?? [], srcDir, notes);
        if (proposal.test?.path && typeof proposal.test.path === 'string' && proposal.test.path.startsWith('/')) recipe.test.checks = [{ method: 'GET', path: proposal.test.path, ok: true }];
        if (Number(proposal.test?.port)) recipe.test.port = Number(proposal.test.port);
        if (notes.length) recipe.notes = [recipe.notes, ...notes].filter(Boolean).join('\n');
        writeRecipe(recipe);
        return { status: notes.length ? 'avviso' : 'ok', detail: `${recipe.options.length} opzioni, ${recipe.patches?.length ?? 0} patch proposte${notes.length ? `; ${notes.length} scartate` : ''}` };
      });
    } else if (analyze) {
      r.steps.push({ name: 'Analisi dell\'agente', status: 'saltato', detail: agentStatus(cfg).ready ? 'sorgente non disponibile' : agentStatus(cfg).reason });
    }
    return finish(r, 'ok', `Ricetta "${name}" creata: controlla le Selezioni e il Contenitore, poi prepara il figlio`);
  } catch (e) {
    log(`✖ ${e.message}`);
    return finish(r, 'errore', e.message.split('\n')[0]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function baseParts(name, { port, path, volumes }) {
  return {
    description: 'Ricetta creata da Leanling: rivedi le opzioni prima di preparare il figlio.',
    test: { port: port ?? 80, startTimeout: 180, checks: [{ method: 'GET', path: path ?? '/', ok: true }] },
    container: {
      name,
      // Porte basse (80, 443…) spesso sono gia' del proxy: sull'host se ne propone una alta
      ports: port ? [`127.0.0.1:${port < 1024 ? 8000 + port : port}:${port}`] : [],
      volumes: (volumes ?? []).map((v, i) => `${name}-data${i || ''}:${v}`),
      env: {},
    },
    options: [],
    patches: [],
  };
}

async function analyzeWithAgent(cfg, recipe, dir, log) {
  const prompt = `Stai preparando una "ricetta" Leanling per ${recipe.title} (${recipe.upstream || recipe.image}), installato in self-hosted da una persona sola o da un freelancer, senza licenze a pagamento. Il sorgente è nella cartella corrente: leggilo, non eseguire nulla.

Obiettivo: un figlio snello, con solo quello che funziona in self-hosted gratuito, aggiornabile senza perdere le modifiche.

Regole:
- Le opzioni devono usare SOLO interruttori ufficiali del programma (variabili d'ambiente documentate o lette dal codice). Indica per ognuna la variabile esatta.
- Spegni (default true) telemetria, funzioni che richiedono una licenza a pagamento o un servizio cloud del produttore, banner promozionali. Lascia accese (default false) le funzioni utili free.
- Non proporre MAI di sbloccare funzioni a pagamento, togliere controlli di licenza, modificare file di licenza o copyright, o toccare codice sotto licenza commerciale (cartelle o file "ee", "enterprise", "premium").
- Le patch sono solo per il Dockerfile o gli script di build, e solo se portano un vantaggio chiaro (immagine più leggera, layer duplicati, permessi). Ogni patch è un diff unificato applicabile con "git apply" dalla radice del progetto. Se non serve nessuna patch, lista vuota.
- Se non trovi interruttori ufficiali, lista vuota: meglio niente che opzioni inventate.

Rispondi con UN SOLO blocco \`\`\`json, con questa forma:
{
  "title": "nome leggibile",
  "description": "una frase in italiano: cosa fa il programma e cosa toglie il figlio",
  "test": { "port": 1234, "path": "/percorso-di-salute" },
  "options": [
    { "id": "breve-id", "group": "Telemetria | A pagamento | Funzioni facoltative | Risorse", "label": "testo in italiano", "default": true, "env": { "VARIABILE": "valore" } }
  ],
  "patches": [
    { "file": "01-nome.patch", "label": "cosa fa, in italiano", "intent": "scopo in parole semplici, serve per rifarla se il file cambia", "diff": "diff --git a/Dockerfile b/Dockerfile\\n..." }
  ],
  "notes": "cose che l'utente deve sapere: licenza, limiti, cosa hai lasciato fuori e perché"
}
Per le variabili che sono liste separate da virgola usa "list": { "VARIABILE": "elemento" } al posto di "env".`;
  const text = await askAgent(cfg, prompt, { cwd: dir, log });
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].pop()?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(block);
  } catch {
    throw new Error('L\'agente non ha restituito un JSON valido: riprova o scrivi la ricetta a mano');
  }
}

/** Tiene solo opzioni ben formate: id semplice, valori stringa */
export function cleanOptions(list, notes) {
  const out = [];
  for (const o of Array.isArray(list) ? list : []) {
    const strMap = (m) => m && typeof m === 'object' && !Array.isArray(m) && Object.entries(m).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string');
    if (!o || !/^[\w.-]{1,60}$/.test(o.id ?? '') || !(strMap(o.env) || strMap(o.list)) || out.some((x) => x.id === o.id)) {
      notes.push(`opzione scartata: ${JSON.stringify(o).slice(0, 120)}`);
      continue;
    }
    out.push({ id: o.id, group: String(o.group ?? 'Altro').slice(0, 60), label: String(o.label ?? o.id).slice(0, 120), default: o.default === true, ...(strMap(o.env) ? { env: o.env } : {}), ...(strMap(o.list) ? { list: o.list } : {}) });
  }
  return out;
}

/** Salva le patch proposte solo se si applicano davvero al sorgente scaricato */
async function savePatches(recipe, list, dir, notes) {
  const kept = [];
  for (const p of Array.isArray(list) ? list : []) {
    const file = /^[\w.-]+\.patch$/.test(p?.file ?? '') ? p.file : `${String(kept.length + 1).padStart(2, '0')}-proposta.patch`;
    if (typeof p?.diff !== 'string' || !p.diff.includes('@@')) {
      notes.push(`patch scartata (diff mancante): ${p?.label ?? file}`);
      continue;
    }
    const path = join(HOME, 'recipes', recipe.name, 'patches', file);
    writeFileSync(path, p.diff.endsWith('\n') ? p.diff : `${p.diff}\n`);
    const check = await run('git', ['apply', '--check', path], { cwd: dir });
    if (check.code !== 0) {
      rmSync(path);
      notes.push(`patch scartata perché non si applica: ${p.label ?? file}`);
      continue;
    }
    kept.push({ file, label: String(p.label ?? file).slice(0, 120), intent: String(p.intent ?? p.label ?? ''), default: false });
  }
  return kept;
}
