// Ricette: quelle incluse in recipes/ piu' quelle dell'utente in ~/.leanling/recipes.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './config.js';

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes');
export const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const USER = join(HOME, 'recipes');

export function listRecipes() {
  const out = new Map();
  for (const base of [BUILTIN, USER]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const file = join(base, name, 'recipe.json');
      if (!NAME.test(name) || !existsSync(file)) continue;
      const recipe = JSON.parse(readFileSync(file, 'utf8'));
      out.set(name, { ...recipe, name, dir: join(base, name), user: base === USER });
    }
  }
  return [...out.values()];
}

export function getRecipe(name) {
  const r = listRecipes().find((x) => x.name === name);
  if (!r) throw new Error(`Ricetta sconosciuta: ${name}`);
  return r;
}

/** Opzioni della ricetta + quelle aggiunte dall'utente, con la scelta attuale (true = togli) */
export function resolveOptions(recipe, settings) {
  return [...(recipe.options ?? []), ...settings.extraOptions].map((o) => ({
    ...o,
    remove: settings.choices[o.id] ?? o.default ?? false,
  }));
}

/** Patch attive: una patch corretta dall'agente (in ~/.leanling/patches) ha la precedenza su quella della ricetta */
export function resolvePatches(recipe, settings) {
  return (recipe.patches ?? [])
    .map((p) => {
      const override = join(HOME, 'patches', recipe.name, p.file);
      return { ...p, path: existsSync(override) ? override : join(recipe.dir, 'patches', p.file), overridden: existsSync(override), enabled: settings.choices[`patch:${p.file}`] ?? p.default ?? true };
    });
}

/**
 * Variabili d'ambiente del figlio: base del contenitore + opzioni scelte.
 * Le voci `list` si uniscono con la virgola; `available` (se noto) scarta i nomi che la versione non ha piu',
 * cosi' un modulo rimosso dagli autori non impedisce l'avvio.
 */
export function buildEnv(recipe, settings, available) {
  const env = { ...(recipe.container?.env ?? {}), ...(settings.container.env ?? {}) };
  const lists = {};
  for (const o of resolveOptions(recipe, settings)) {
    if (!o.remove) continue;
    Object.assign(env, o.env ?? {});
    for (const [k, v] of Object.entries(o.list ?? {})) {
      if (available && k === recipe.discover?.listEnv && !available.includes(v)) continue;
      (lists[k] ??= []).push(v);
    }
  }
  for (const [k, v] of Object.entries(lists)) env[k] = [...new Set(v)].join(',');
  return env;
}

export function containerSpec(recipe, settings) {
  return { ...recipe.container, ...Object.fromEntries(Object.entries(settings.container).filter(([k]) => k !== 'env')) };
}

/** Salva una ricetta dell'utente in ~/.leanling/recipes/<nome> */
export function writeRecipe(recipe) {
  const dir = join(USER, recipe.name);
  mkdirSync(join(dir, 'patches'), { recursive: true });
  const { dir: _d, user: _u, ...data } = recipe;
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify(data, null, 2));
  return dir;
}

/** Toglie una ricetta dell'utente (quelle incluse in Leanling non si cancellano) */
export function removeRecipe(name) {
  const r = getRecipe(name);
  if (!r.user) throw new Error('Le ricette incluse in Leanling non si possono togliere');
  rmSync(r.dir, { recursive: true, force: true });
}
