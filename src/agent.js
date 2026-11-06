// L'agente (Claude Code o OpenCode) interviene solo quando serve: leggere le novita' e sistemare le patch.
import { has, run } from './sh.js';

export function agentStatus(cfg) {
  const a = cfg.agent;
  if (a.type === 'none') return { ready: false, reason: 'Nessun agente scelto' };
  const bin = a.type === 'claude' ? 'claude' : 'opencode';
  if (!has(bin)) return { ready: false, reason: `${bin} non installato` };
  if (a.type === 'claude' && a.auth === 'api' && !a.apiKey) return { ready: false, reason: 'Manca la chiave API' };
  return { ready: true, reason: a.type === 'claude' ? `Claude Code (${a.auth === 'api' ? 'chiave API' : 'abbonamento'})` : 'OpenCode' };
}

/** mode: 'read' (solo lettura) o 'edit' (puo' modificare i file in cwd) */
export async function askAgent(cfg, prompt, { cwd, mode = 'read', log }) {
  const a = cfg.agent;
  const status = agentStatus(cfg);
  if (!status.ready) throw new Error(status.reason);

  if (a.type === 'claude') {
    const tools = mode === 'edit' ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob';
    const args = ['-p', prompt, '--allowedTools', tools, '--output-format', 'text'];
    if (a.model) args.push('--model', a.model);
    const env = { ...process.env };
    // Con l'abbonamento una chiave nell'ambiente farebbe pagare a consumo senza volerlo
    if (a.auth === 'api') env.ANTHROPIC_API_KEY = a.apiKey;
    else delete env.ANTHROPIC_API_KEY;
    const r = await runClean('claude', args, { cwd, env, log });
    return r;
  }
  const args = ['run'];
  if (a.model) args.push('--model', a.model);
  args.push(prompt);
  return runClean('opencode', args, { cwd, log });
}

async function runClean(cmd, args, { cwd, env, log }) {
  log?.(`agente: ${cmd} al lavoro…`);
  const r = await run(cmd, args, { cwd, env: env ?? {}, timeout: 900 });
  if (r.code !== 0) throw new Error(`L'agente ha risposto con errore: ${(r.err || r.out).slice(-400)}`);
  return r.out.trim();
}

/** Ultima riga "VERDETTO: OK|SOSPETTO ..." della revisione */
export function parseVerdict(text) {
  const m = [...text.matchAll(/VERDETTO:\s*(OK|SOSPETTO)\b[^\n]*/gi)].pop();
  if (!m) return { ok: false, line: 'Nessun verdetto chiaro dall\'agente: serve una verifica manuale' };
  return { ok: m[1].toUpperCase() === 'OK', line: m[0] };
}
