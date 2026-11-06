// Il lavoro vero: preparare il figlio di una nuova versione, provarlo, installarlo, tornare indietro, pulire.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askAgent, agentStatus, parseVerdict } from './agent.js';
import { HOME, loadConfig, loadState, recipeSettings, saveState } from './config.js';
import { buildEnv, containerSpec, getRecipe, resolveOptions, resolvePatches } from './recipes.js';
import { scanImage, scanSource } from './scan.js';
import { freePort, run, sleep } from './sh.js';

export const events = new EventEmitter();
const active = new Map(); // nome ricetta -> run in corso

/* ------------------------------------------------------------------ registro di un'esecuzione */

// Blocco tra processi (CLI e dashboard): un file con il pid di chi sta lavorando sulla ricetta
const lockFile = (recipe) => join(HOME, 'work', `${recipe}.lock`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function lockedBy(recipe) {
  try {
    const { pid, run } = JSON.parse(readFileSync(lockFile(recipe), 'utf8'));
    return alive(pid) ? run : null;
  } catch {
    return null;
  }
}

export function newRun(recipe, kind) {
  if (active.has(recipe) || lockedBy(recipe)) throw new Error(`C'è già un lavoro in corso su ${recipe}`);
  const r = { id: `${Date.now().toString(36)}-${recipe}-${kind}`, recipe, kind, status: 'in corso', startedAt: new Date().toISOString(), steps: [], log: [], report: {} };
  active.set(recipe, r);
  writeFileSync(lockFile(recipe), JSON.stringify({ pid: process.pid, run: r.id }));
  persist(r);
  events.emit('run', r);
  return r;
}

/** Salva l'avanzamento su file (al massimo ogni 2 s): cosi' la dashboard vede anche i lavori partiti da terminale */
const lastSave = new Map();
function persist(r, force = false) {
  const now = Date.now();
  if (!force && now - (lastSave.get(r.id) ?? 0) < 2000) return;
  lastSave.set(r.id, now);
  writeFileSync(join(HOME, 'runs', `${r.id}.json`), JSON.stringify(r, null, 2));
}

export function logger(r, echo) {
  return (line) => {
    const l = `${new Date().toTimeString().slice(0, 8)} ${line}`;
    r.log.push(l);
    if (r.log.length > 2000) r.log.splice(0, r.log.length - 2000);
    if (echo) console.log(l);
    persist(r);
    events.emit('log', { id: r.id, line: l });
  };
}

export async function step(r, log, name, fn) {
  const s = { name, status: 'in corso' };
  r.steps.push(s);
  events.emit('run', r);
  log(`▶ ${name}`);
  try {
    const out = await fn();
    s.status = out?.status ?? 'ok';
    if (out?.detail) s.detail = out.detail;
    return out;
  } catch (e) {
    s.status = 'errore';
    s.detail = e.message;
    throw e;
  } finally {
    persist(r, true);
    events.emit('run', r);
  }
}

export function finish(r, status, message) {
  r.status = status;
  r.message = message;
  r.endedAt = new Date().toISOString();
  active.delete(r.recipe);
  rmSync(lockFile(r.recipe), { force: true });
  persist(r, true);
  lastSave.delete(r.id);
  events.emit('run', r);
  return r;
}

export const activeRuns = () => [...active.values()];
/** Ricetta -> id del lavoro in corso, in questo processo o in un altro */
export const runningId = (recipe) => active.get(recipe)?.id ?? lockedBy(recipe);

/* ------------------------------------------------------------------ docker */

const docker = (args, opts) => run('docker', args, opts);
const imageId = async (ref) => (await docker(['image', 'inspect', '-f', '{{.Id}}', ref])).out.trim() || null;
const imageSizeMB = async (ref) => Math.round(Number((await docker(['image', 'inspect', '-f', '{{.Size}}', ref])).out.trim()) / 1e6);

function containerArgs(spec, image, env, labels) {
  const args = [];
  for (const p of spec.ports ?? []) args.push('-p', p);
  for (const v of spec.volumes ?? []) args.push('-v', v);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  if (spec.memory) args.push('--memory', spec.memory);
  if (spec.network) args.push('--network', spec.network);
  return [...args, image];
}

/** Controlli HTTP del test: stato, campi JSON attesi, testo atteso */
async function httpChecks(port, checks) {
  for (const c of checks) {
    const res = await fetch(`http://127.0.0.1:${port}${c.path}`, {
      method: c.method ?? 'GET',
      headers: c.body ? { 'content-type': 'application/json' } : {},
      body: c.body ? JSON.stringify(c.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    if (c.status && res.status !== c.status) return `${c.path}: stato ${res.status}, atteso ${c.status}`;
    if (c.ok && !res.ok) return `${c.path}: stato ${res.status}`;
    if (c.contains && !text.includes(c.contains)) return `${c.path}: manca "${c.contains}" nella risposta`;
    if (c.json) {
      const body = JSON.parse(text);
      for (const [k, v] of Object.entries(c.json)) if (body[k] !== v) return `${c.path}: ${k}=${JSON.stringify(body[k])}, atteso ${JSON.stringify(v)}`;
    }
  }
  return null;
}

async function waitHealthy(port, test, log) {
  const deadline = Date.now() + (test.startTimeout ?? 120) * 1000;
  let last = 'non risponde';
  while (Date.now() < deadline) {
    try {
      last = await httpChecks(port, test.checks.slice(0, 1));
      if (!last) break;
    } catch (e) {
      last = e.cause?.code ?? e.message;
    }
    await sleep(2000);
  }
  if (last) return `Non pronto entro ${test.startTimeout ?? 120}s: ${last}`;
  log('pronto, eseguo i controlli');
  return httpChecks(port, test.checks);
}

/** Avvia il figlio in un container usa e getta (porta libera, nessun volume) e lo mette alla prova */
async function testImage(recipe, image, env, log) {
  const port = await freePort();
  const name = `leanling-test-${recipe.name}-${port}`;
  const started = Date.now();
  const r = await docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:${recipe.test.port}`, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--label', 'leanling.test=1', image]);
  if (r.code !== 0) throw new Error(`Il container di prova non parte: ${r.err.trim()}`);
  try {
    const fail = await waitHealthy(port, recipe.test, log);
    if (fail) {
      const logs = await docker(['logs', '--tail', '30', name]);
      throw new Error(`${fail}\n--- ultime righe del container ---\n${(logs.out + logs.err).trim()}`);
    }
    const ram = (await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name])).out.trim().split(' / ')[0];
    return { status: 'ok', detail: `pronto in ${Math.round((Date.now() - started) / 1000)}s, RAM ${ram}` };
  } finally {
    await docker(['rm', '-f', name]);
  }
}

/* ------------------------------------------------------------------ preparazione del figlio */

/**
 * Prepara il candidato: scarica, controlla, applica la ricetta, costruisce e prova.
 * Con `deploy` lo installa subito se tutto e' andato bene.
 */
export async function update(name, { force = false, deploy = false, echo = false } = {}) {
  const recipe = getRecipe(name);
  const r = newRun(name, 'aggiorna');
  const log = logger(r, echo);
  try {
    const cfg = loadConfig();
    const settings = recipeSettings(cfg, name);
    const prep = recipe.type === 'build' ? prepareBuild : prepareImage;
    const candidate = await prep(recipe, cfg, settings, r, log, force);
    if (!candidate) return finish(r, 'ok', 'Già aggiornato: nessuna versione nuova');
    const state = loadState();
    state[name] = { ...state[name], candidate: { ...candidate, report: r.report, at: new Date().toISOString() } };
    saveState(state);
    if (deploy || settings.deploy) {
      active.delete(name);
      const d = await promote(name, { echo, parent: r });
      return finish(r, d.status, d.message);
    }
    return finish(r, 'pronto', `Figlio ${candidate.version} pronto e provato: installalo quando vuoi`);
  } catch (e) {
    log(`✖ ${e.message}`);
    return finish(r, 'errore', e.message.split('\n')[0]);
  }
}

async function prepareImage(recipe, cfg, settings, r, log, force) {
  const ref = `${recipe.image}:${recipe.tag ?? 'latest'}`;
  const prev = loadState()[recipe.name]?.current;

  const pulled = await step(r, log, `Scarico ${ref}`, async () => {
    const p = await docker(['pull', '-q', ref]);
    if (p.code !== 0) throw new Error(p.err.trim());
    const id = await imageId(ref);
    // Versione: comando della ricetta, poi etichetta OCI dell'immagine, poi un pezzo dell'id
    const label = (await docker(['image', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.version"}}', ref])).out.trim();
    const v = recipe.versionCmd ? (await docker(['run', '--rm', '--entrypoint', 'sh', ref, '-c', recipe.versionCmd])).out.trim().split('\n').pop() : '';
    const version = v || (label && label !== '<no value>' ? label : id.slice(7, 19));
    return { status: 'ok', id, version, detail: `versione ${version}` };
  });
  if (!force && prev?.imageId === pulled.id) {
    r.steps.push({ name: 'Confronto', status: 'ok', detail: `${pulled.version} è già quella in uso` });
    return null;
  }

  // Cosa offre questa versione: nomi nuovi = da decidere, nomi spariti = da non passare piu'
  let available = null;
  if (recipe.discover) {
    await step(r, log, recipe.discover.description, async () => {
      const d = await docker(['run', '--rm', '--entrypoint', 'sh', ref, '-c', recipe.discover.cmd]);
      available = JSON.parse(d.out.trim().split('\n').pop());
      // `keep` = parti del nucleo che la ricetta lascia sempre accese: non vanno chieste all'utente
      const known = new Set([...resolveOptions(recipe, settings).flatMap((o) => Object.values(o.list ?? {})), ...(recipe.discover.keep ?? [])]);
      const fresh = available.filter((m) => !known.has(m));
      const gone = [...known].filter((m) => !available.includes(m));
      r.report.newItems = fresh;
      r.report.goneItems = gone;
      return { status: fresh.length ? 'avviso' : 'ok', detail: `${available.length} trovati${fresh.length ? `; nuovi da decidere: ${fresh.join(', ')}` : ''}${gone.length ? `; non più presenti: ${gone.join(', ')}` : ''}` };
    });
  }

  if (recipe.upstream?.includes('github.com')) {
    await step(r, log, 'Note di rilascio', async () => {
      const notes = await releaseNotes(recipe.upstream, prev?.version, pulled.version);
      r.report.releaseNotes = notes;
      return { status: 'ok', detail: notes ? `${notes.split('\n## ').length} rilasci letti` : 'nessuna nota trovata' };
    });
  }

  if (cfg.agent.review && agentStatus(cfg).ready && (r.report.newItems?.length || r.report.releaseNotes)) {
    await step(r, log, 'Revisione dell\'agente', async () => {
      const prompt = [
        `Sei il controllore di Leanling. Stiamo aggiornando ${recipe.title} da ${prev?.version ?? '(prima installazione)'} a ${pulled.version}, in self-hosted senza licenza enterprise.`,
        r.report.newItems?.length ? `Elementi nuovi in questa versione: ${r.report.newItems.join(', ')}. Per ognuno di' se è free, enterprise/a pagamento o sperimentale, e se conviene spegnerlo.` : '',
        r.report.releaseNotes ? `Note di rilascio:\n${r.report.releaseNotes.slice(0, 30_000)}` : '',
        'Segnala cambi che possono rompere un\'installazione esistente o che sembrano sospetti (telemetria nuova, connessioni verso servizi esterni, cambi di licenza).',
        'Rispondi in italiano, breve. Ultima riga esattamente: "VERDETTO: OK" oppure "VERDETTO: SOSPETTO - motivo".',
      ].filter(Boolean).join('\n\n');
      const text = await askAgent(cfg, prompt, { cwd: HOME, log });
      const v = parseVerdict(text);
      r.report.review = text;
      if (!v.ok) throw new Error(`Revisione: ${v.line}`);
      return { status: 'ok', detail: v.line };
    });
  }

  const tag = `leanling/${recipe.name}:${safeTag(pulled.version)}`;
  await docker(['tag', ref, tag]);
  const env = buildEnv(recipe, settings, available);
  await scanAndGate(cfg, r, log, () => scanImage(cfg, tag, log), 'Scansione dell\'immagine');
  await step(r, log, 'Prova del figlio', () => testImage(recipe, tag, env, log));
  return { image: tag, imageId: pulled.id, version: pulled.version, env };
}

async function prepareBuild(recipe, cfg, settings, r, log, force) {
  const base = join(HOME, 'work', recipe.name);
  const repo = join(base, 'repo');
  mkdirSync(base, { recursive: true });
  const git = (args, cwd = repo) => run('git', args, { cwd });
  const prev = loadState()[recipe.name]?.current;

  const head = await step(r, log, 'Scarico l\'ultima versione', async () => {
    if (!existsSync(join(repo, '.git'))) {
      const c = await run('git', ['clone', '--filter=blob:none', '--no-checkout', recipe.repo, repo]);
      if (c.code !== 0) throw new Error(c.err.trim());
    }
    const f = await git(['fetch', '--quiet', 'origin', recipe.ref ?? 'main']);
    if (f.code !== 0) throw new Error(f.err.trim());
    const sha = (await git(['rev-parse', 'FETCH_HEAD'])).out.trim();
    const subject = (await git(['log', '-1', '--format=%s (%cd)', '--date=short', sha])).out.trim();
    return { status: 'ok', sha, detail: `${sha.slice(0, 8)} ${subject}` };
  });
  if (!force && prev?.commit === head.sha) {
    r.steps.push({ name: 'Confronto', status: 'ok', detail: 'nessun commit nuovo' });
    return null;
  }

  const tmp = join(base, `tmp-${r.id}`);
  await git(['worktree', 'add', '--detach', tmp, head.sha]);
  try {
    const range = prev?.commit ? `${prev.commit}..${head.sha}` : null;
    if (range) {
      const count = (await git(['rev-list', '--count', range])).out.trim();
      r.report.newCommits = Number(count);
      r.report.changelog = (await git(['log', '--format=- %h %s', range])).out.trim();
    }

    await scanAndGate(cfg, r, log, () => scanSource(cfg, { dir: tmp, range, manifests: recipe.manifests, log }), 'Scanner sul sorgente');

    if (range && cfg.agent.review && agentStatus(cfg).ready) {
      await step(r, log, 'Revisione delle novità (agente)', async () => {
        const stat = (await git(['diff', '--stat', range])).out;
        const diff = (await git(['diff', range, '--', '.', ':(exclude)*.lock', ':(exclude)*.png', ':(exclude)*.svg'])).out;
        const prompt = [
          `Sei il controllore di sicurezza di Leanling. Il progetto ${recipe.title} (${recipe.upstream}) è passato da ${prev.commit.slice(0, 8)} a ${head.sha.slice(0, 8)}. Il sorgente nuovo è nella cartella corrente.`,
          `Commit nuovi:\n${r.report.changelog}`,
          `File cambiati:\n${stat}`,
          diff.length < 150_000 ? `Differenze:\n${diff}` : 'Le differenze sono troppo lunghe da incollare: leggi tu i file cambiati più rilevanti (Dockerfile, script di installazione, dipendenze, codice di rete).',
          'Cerca segni di attacco alla catena di distribuzione: script di installazione nuovi, curl|sh, codice offuscato o in base64, download o connessioni verso domini nuovi, dipendenze appena aggiunte o con nomi simili a quelle note, raccolta di variabili d\'ambiente o chiavi.',
          'Rispondi in italiano, breve: cosa cambia per chi lo installa. Ultima riga esattamente: "VERDETTO: OK" oppure "VERDETTO: SOSPETTO - motivo".',
        ].join('\n\n');
        const text = await askAgent(cfg, prompt, { cwd: tmp, log });
        const v = parseVerdict(text);
        r.report.review = text;
        if (!v.ok) throw new Error(`Revisione: ${v.line}`);
        return { status: 'ok', detail: v.line };
      });
    }

    for (const p of resolvePatches(recipe, settings).filter((x) => x.enabled)) {
      await step(r, log, `Ricetta: ${p.label}`, () => applyPatch(recipe, cfg, p, tmp, log));
    }

    const tag = `leanling/${recipe.name}:${head.sha.slice(0, 12)}`;
    await step(r, log, 'Costruisco l\'immagine', async () => {
      let lines = 0;
      const b = await docker(['build', '-t', tag, '-f', recipe.dockerfile ?? 'Dockerfile', '--label', `leanling.recipe=${recipe.name}`, '--label', `leanling.commit=${head.sha}`, '.'], {
        cwd: tmp,
        env: { DOCKER_BUILDKIT: '1' },
        onLine: (l) => ++lines % 20 === 0 && log(`build: ${l.slice(0, 160)}`),
      });
      if (b.code !== 0) throw new Error(`Build fallita:\n${b.err.split('\n').slice(-20).join('\n')}`);
      const mb = await imageSizeMB(tag);
      r.report.sizeMB = mb;
      if (recipe.maxSizeMB && mb > recipe.maxSizeMB) throw new Error(`Immagine di ${mb} MB, oltre il limite di ${recipe.maxSizeMB} MB: la ricetta non sta più funzionando`);
      return { status: 'ok', detail: `${tag}, ${(mb / 1000).toFixed(2)} GB` };
    });

    await scanAndGate(cfg, r, log, () => scanImage(cfg, tag, log), 'Scansione dell\'immagine');
    const env = buildEnv(recipe, settings, null);
    await step(r, log, 'Prova del figlio', () => testImage(recipe, tag, env, log));
    return { image: tag, imageId: await imageId(tag), version: head.sha.slice(0, 8), commit: head.sha, env };
  } finally {
    await git(['worktree', 'remove', '--force', tmp]);
  }
}

/** Applica una patch; se e' gia' nell'originale la salta, se non si applica piu' chiede all'agente di rifarla */
async function applyPatch(recipe, cfg, p, dir, log) {
  const git = (args) => run('git', args, { cwd: dir });
  if ((await git(['apply', '--check', p.path])).code === 0) {
    await git(['apply', p.path]);
    return { status: 'ok', detail: p.overridden ? 'applicata (versione corretta dall\'agente)' : 'applicata' };
  }
  if ((await git(['apply', '--reverse', '--check', p.path])).code === 0) {
    return { status: 'avviso', detail: 'già presente nell\'originale: questa patch si può togliere dalla ricetta' };
  }
  const three = await git(['apply', '--3way', p.path]);
  if (three.code === 0) return { status: 'ok', detail: 'applicata con unione a tre vie' };
  await git(['checkout', '--', '.']);

  if (!cfg.agent.fixPatches || !agentStatus(cfg).ready) throw new Error(`La patch ${p.file} non si applica più e nessun agente è attivo per sistemarla`);
  log(`la patch ${p.file} non si applica più: la rifà l'agente`);
  const prompt = [
    `Nella cartella corrente c'è la nuova versione di ${recipe.title}. Una modifica che facevamo non si applica più perché il file originale è cambiato.`,
    `Scopo della modifica: ${p.intent ?? p.label}`,
    `Patch vecchia, solo come riferimento:\n${readFileSync(p.path, 'utf8')}`,
    'Applica la stessa modifica al codice attuale modificando i file direttamente. Non cambiare nient\'altro. Alla fine scrivi in una riga cosa hai fatto.',
  ].join('\n\n');
  await askAgent(cfg, prompt, { cwd: dir, mode: 'edit', log });
  const diff = (await git(['diff'])).out;
  if (!diff.trim()) throw new Error('L\'agente non ha modificato nulla');
  const out = join(HOME, 'patches', recipe.name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, p.file), diff);
  return { status: 'avviso', detail: `rifatta dall'agente e salvata in ${join(out, p.file)}: controllala` };
}

async function scanAndGate(cfg, r, log, fn, label) {
  await step(r, log, label, async () => {
    const res = await fn();
    r.report.scans = [...(r.report.scans ?? []), ...res];
    if (!res.length) return { status: 'ok', detail: 'nessuno scanner attivo' };
    const bad = res.filter((x) => x.status === 'bloccante');
    if (bad.length) throw new Error(`Bloccato da ${bad.map((b) => b.id).join(', ')}:\n${bad.map((b) => b.detail).join('\n')}`);
    const warn = res.some((x) => ['avviso', 'errore', 'saltato'].includes(x.status));
    return { status: warn ? 'avviso' : 'ok', detail: res.map((x) => `${x.id}: ${x.status}`).join(', ') };
  });
}

/* ------------------------------------------------------------------ installazione, ritorno, pulizia */

const LABEL = 'leanling.recipe';

/** Installa il candidato al posto della versione in uso; se non risponde torna alla precedente */
export async function promote(name, { echo = false, target = 'candidate', parent = null } = {}) {
  const recipe = getRecipe(name);
  const r = parent ?? newRun(name, target === 'previous' ? 'ripristina' : 'installa');
  if (parent) active.set(name, r);
  const log = logger(r, echo);
  try {
    const cfg = loadConfig();
    const settings = recipeSettings(cfg, name);
    const state = loadState();
    const s = state[name] ?? {};
    const next = s[target];
    if (!next) throw new Error(target === 'previous' ? 'Non c\'è una versione precedente' : 'Nessun figlio pronto: prima "aggiorna"');
    const spec = containerSpec(recipe, settings);
    // Le variabili sono quelle con cui il figlio e' stato provato: se cambi le scelte, va preparato di nuovo
    const env = next.env ?? {};

    await step(r, log, `Installo ${next.version} come "${spec.name}"`, async () => {
      const owner = (await docker(['inspect', '-f', `{{index .Config.Labels "${LABEL}"}}`, spec.name])).out.trim();
      const exists = (await docker(['inspect', spec.name])).code === 0;
      if (exists && owner !== name && !settings.adopt) {
        throw new Error(`Esiste già un container "${spec.name}" che Leanling non ha creato. Scegli un altro nome nella scheda Contenitore oppure attiva "Adotta il container esistente".`);
      }
      if (exists) await docker(['rm', '-f', spec.name]);
      const c = await docker(['run', '-d', '--name', spec.name, '--restart', 'unless-stopped', ...containerArgs(spec, next.image, env, { [LABEL]: name, 'leanling.version': next.version })]);
      if (c.code !== 0) throw new Error(c.err.trim());
      return { status: 'ok', detail: c.out.trim().slice(0, 12) };
    });

    const hostPort = Number((spec.ports?.[0] ?? '').split(':').at(-2));
    if (hostPort && recipe.test) {
      try {
        await step(r, log, 'Controllo dopo l\'installazione', async () => {
          const fail = await waitHealthy(hostPort, recipe.test, log);
          if (fail) throw new Error(fail);
          return { status: 'ok', detail: `risponde su ${hostPort}` };
        });
      } catch (e) {
        if (target !== 'candidate' || !s.current) throw e;
        log('non risponde: torno alla versione di prima');
        await docker(['rm', '-f', spec.name]);
        await docker(['run', '-d', '--name', spec.name, '--restart', 'unless-stopped', ...containerArgs(spec, s.current.image, s.current.env ?? {}, { [LABEL]: name, 'leanling.version': s.current.version })]);
        throw new Error(`${e.message}. Rimessa la versione ${s.current.version}.`);
      }
    }

    const fresh = loadState();
    const cur = fresh[name] ?? {};
    fresh[name] = target === 'previous'
      ? { ...cur, current: cur.previous, previous: cur.current }
      : { ...cur, previous: cur.current ?? null, current: { ...next, env, installedAt: new Date().toISOString() }, candidate: null };
    saveState(fresh);
    if (cfg.keepVersions > 0) await cleanup(name, log);
    if (settings.publishAs && target === 'candidate') await publish(next.image, settings.publishAs, next.version, log);
    return parent ? { status: 'ok', message: `Installato ${next.version}` } : finish(r, 'ok', `Installato ${next.version}`);
  } catch (e) {
    log(`✖ ${e.message}`);
    if (parent) return { status: 'errore', message: e.message.split('\n')[0] };
    return finish(r, 'errore', e.message.split('\n')[0]);
  }
}

export const rollback = (name, opts) => promote(name, { ...opts, target: 'previous' });

/** Tiene solo le immagini in uso (attuale, precedente, candidato) e toglie le altre di questa ricetta */
async function cleanup(name, log) {
  const s = loadState()[name] ?? {};
  const keep = new Set([s.current?.image, s.previous?.image, s.candidate?.image].filter(Boolean));
  const list = (await docker(['images', `leanling/${name}`, '--format', '{{.Repository}}:{{.Tag}}|{{.Size}}'])).out.trim().split('\n').filter(Boolean);
  const removed = [];
  for (const line of list) {
    const [ref, size] = line.split('|');
    if (keep.has(ref)) continue;
    const d = await docker(['rmi', ref]);
    if (d.code === 0) removed.push(`${ref} (${size})`);
  }
  log(removed.length ? `tolte: ${removed.join(', ')}` : 'niente da togliere');
  return removed;
}

export async function clean(name, { echo = false, buildCache = false } = {}) {
  const r = newRun(name, 'pulisci');
  const log = logger(r, echo);
  try {
    const removed = await step(r, log, 'Immagini vecchie', async () => {
      const x = await cleanup(name, log);
      return { status: 'ok', detail: x.length ? `${x.length} tolte` : 'niente da togliere', x };
    });
    await step(r, log, 'Container di prova rimasti', async () => {
      const ids = (await docker(['ps', '-aq', '--filter', 'label=leanling.test=1'])).out.trim().split('\n').filter(Boolean);
      if (ids.length) await docker(['rm', '-f', ...ids]);
      return { status: 'ok', detail: `${ids.length} tolti` };
    });
    if (buildCache) {
      await step(r, log, 'Cache di build di Docker', async () => {
        const p = await docker(['builder', 'prune', '-f']);
        return { status: 'ok', detail: p.out.trim().split('\n').pop() };
      });
    }
    return finish(r, 'ok', `Pulizia fatta${removed.x?.length ? `: ${removed.x.length} immagini tolte` : ''}`);
  } catch (e) {
    return finish(r, 'errore', e.message);
  }
}

async function publish(image, target, version, log) {
  for (const t of [`${target}:${safeTag(version)}`, `${target}:latest`]) {
    await docker(['tag', image, t]);
    const p = await docker(['push', t]);
    log(p.code === 0 ? `pubblicata ${t}` : `pubblicazione di ${t} non riuscita: ${p.err.trim()}`);
  }
}

/* ------------------------------------------------------------------ utilita' */

const safeTag = (v) => String(v).replace(/[^\w.-]/g, '-').slice(0, 120);

const vnum = (v) => (String(v).match(/\d+/g) ?? []).map(Number);
const vcmp = (a, b) => {
  const x = vnum(a);
  const y = vnum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** Note dei rilasci GitHub tra la versione in uso (esclusa) e quella nuova (inclusa) */
async function releaseNotes(upstream, from, to) {
  const repo = upstream.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=40`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return '';
    const list = await res.json();
    return list
      .filter((x) => !x.prerelease && vcmp(x.tag_name, to) <= 0 && (!from || vcmp(x.tag_name, from) > 0))
      .slice(0, 15)
      .map((x) => `## ${x.tag_name}\n${(x.body ?? '').slice(0, 6000)}`)
      .join('\n\n');
  } catch {
    return '';
  }
}

export function recentRuns(limit = 30) {
  const dir = join(HOME, 'runs');
  return run('ls', ['-1t', dir]).then(({ out }) =>
    out.split('\n').filter((f) => f.endsWith('.json')).slice(0, limit).map((f) => {
      const x = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { id: x.id, recipe: x.recipe, kind: x.kind, status: x.status, message: x.message, startedAt: x.startedAt, endedAt: x.endedAt };
    }),
  );
}

export function getRun(id) {
  for (const r of active.values()) if (r.id === id) return r;
  const file = join(HOME, 'runs', `${id.replace(/[^\w-]/g, '')}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
