// Dashboard di Leanling: niente framework, una pagina che parla con /api.
const token = new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem('leanling-token') ?? '';
if (token) sessionStorage.setItem('leanling-token', token);

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (iso) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '');
const badge = (s) => `<span class="badge ${esc(String(s).replace(/\s/g, '-'))}">${esc(s)}</span>`;

let data = null;
let selected = location.hash.slice(1) || null;
let tab = 'choices';
let watchedRun = null; // run mostrato in "Attivita'"

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-leanling-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? res.statusText);
  return out;
}

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', role: 'status', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function load() {
  try {
    data = await api('/api/overview');
  } catch (e) {
    $('#main').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  if (!selected || !data.recipes.some((r) => r.name === selected)) selected = data.recipes[0]?.name;
  renderNav();
  renderRecipe();
}

function renderNav() {
  $('#recipes').innerHTML = data.recipes
    .map((r) => {
      const v = r.state.current?.version ?? 'non installato';
      const extra = r.running ? badge('in corso') : r.state.candidate ? badge('pronto') : '';
      return `<button data-name="${esc(r.name)}" aria-current="${r.name === selected}"><strong>${esc(r.title)}</strong><small>${esc(v)} ${extra}</small></button>`;
    })
    .join('');
}

$('#recipes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-name]');
  if (!b) return;
  selected = b.dataset.name;
  location.hash = selected;
  watchedRun = null;
  renderNav();
  renderRecipe();
});

function renderRecipe() {
  const r = data.recipes.find((x) => x.name === selected);
  if (!r) return void ($('#main').innerHTML = '<p class="empty">Nessun programma ancora: premi "Aggiungi programma".</p>');
  const el = $('#tpl-recipe').content.firstElementChild.cloneNode(true);
  $('h1', el).textContent = r.title;
  $('.desc', el).textContent = r.description;

  const s = r.state;
  const card = (title, v, sub) => `<div class="card"><h3>${title}</h3><div class="v">${esc(v?.version ?? '—')}</div><small>${esc(sub ?? '')}</small></div>`;
  $('.versions', el).innerHTML =
    card('In uso', s.current, s.current ? `installato ${when(s.current.installedAt)}` : 'non ancora installato') +
    card('Pronto da installare', s.candidate, s.candidate ? `provato ${when(s.candidate.at)}` : 'prepara un aggiornamento') +
    card('Precedente', s.previous, s.previous ? 'per tornare indietro' : '');

  for (const b of el.querySelectorAll('.actions button')) {
    const act = b.dataset.act;
    b.disabled = !!r.running || (act === 'install' && !s.candidate) || (act === 'rollback' && !s.previous);
    b.addEventListener('click', () => action(r, act));
  }

  for (const t of el.querySelectorAll('[role=tab]')) {
    t.setAttribute('aria-selected', t.dataset.tab === tab);
    t.addEventListener('click', () => {
      tab = t.dataset.tab;
      renderRecipe();
    });
  }
  for (const p of el.querySelectorAll('.tab')) p.hidden = p.dataset.panel !== tab;

  $('[data-panel=choices]', el).append(choicesPanel(r));
  $('[data-panel=container]', el).append(containerPanel(r));
  $('[data-panel=activity]', el).append(activityPanel(r));
  $('[data-panel=info]', el).innerHTML = `
    <p><strong>Licenza:</strong> ${esc(r.license)}</p>
    <p><strong>Origine:</strong> <a href="${esc(r.upstream)}" rel="noopener" target="_blank">${esc(r.upstream)}</a></p>
    <p><strong>Tipo di ricetta:</strong> ${r.type === 'build' ? 'costruita dal sorgente con le patch della ricetta' : 'immagine ufficiale con un profilo di configurazione (nessun file modificato)'}</p>
    ${r.notes ? `<h4>Note dell'analisi</h4><div class="notes">${esc(r.notes)}</div>` : ''}
    ${r.user ? '<p class="hint">Ricetta tua, salvata in ~/.leanling/recipes.</p><button class="ghost" data-remove>Togli questa ricetta</button>' : ''}
    <p class="hint">Leanling non ridistribuisce il programma: scarica la versione ufficiale sulla tua macchina e applica la ricetta lì. Non tocca file di licenza, avvisi di copyright o codice enterprise.</p>`;

  $('[data-remove]', el)?.addEventListener('click', async () => {
    if (!confirm(`Togliere la ricetta "${r.title}"? Il container installato e le immagini restano: usa prima Pulisci se vuoi liberare spazio.`)) return;
    try {
      await api(`/api/recipes/${r.name}/remove`, {});
      selected = null;
      location.hash = '';
      await load();
    } catch (e) {
      toast(e.message);
    }
  });

  $('#main').replaceChildren(el);
}

/* -------- aggiungi programma */
const addDlg = $('#add');
const addForm = $('#add-form');
$('#open-add').addEventListener('click', () => {
  addForm.reset();
  $('#add-agent').textContent = data?.agent.ready ? `Agente: ${data.agent.reason}` : `Agente non attivo (${data?.agent.reason ?? '?'}): la ricetta sarà solo di base. Puoi sceglierlo nelle Impostazioni.`;
  addDlg.showModal();
});
addDlg.addEventListener('close', async () => {
  if (addDlg.returnValue !== 'add') return;
  try {
    const { name, id } = await api('/api/recipes', { source: addForm.source.value, name: addForm.name.value, analyze: addForm.analyze.checked });
    toast('Analizzo il progetto…');
    selected = name;
    location.hash = name;
    watchedRun = id;
    tab = 'activity';
    await load();
  } catch (e) {
    toast(e.message);
  }
});

function choicesPanel(r) {
  const wrap = document.createElement('div');
  const lastReport = r.state.candidate?.report ?? {};
  const fresh = (lastReport.newItems ?? []).filter((m) => !r.options.some((o) => o.id === m));
  let html = '';
  if (fresh.length) {
    html += `<div class="new-items"><strong>Novità trovate nell'ultima versione</strong>
      <p class="hint">Non sono nella ricetta: decidi tu. Aggiungendole compaiono qui sotto e puoi spegnerle.</p>
      ${fresh.map((m) => `<button class="ghost" data-add="${esc(m)}">+ ${esc(m)}</button>`).join('')}</div>`;
  }
  if (r.options.length) {
    html += '<p class="legend">Spunta quello che <strong>non vuoi</strong> nel figlio. Le modifiche valgono dal prossimo "prepara".</p>';
    const groups = Map.groupBy ? Map.groupBy(r.options, (o) => o.group ?? 'Altro') : r.options.reduce((m, o) => m.set(o.group ?? 'Altro', [...(m.get(o.group ?? 'Altro') ?? []), o]), new Map());
    for (const [g, opts] of groups) {
      html += `<div class="group"><h4>${esc(g)} <button class="ghost" data-all="${esc(g)}">togli tutti</button><button class="ghost" data-none="${esc(g)}">tieni tutti</button></h4><div class="opts">
        ${opts.map((o) => `<label class="check"><input type="checkbox" data-opt="${esc(o.id)}" ${o.remove ? 'checked' : ''}><span>${esc(o.label)}<small>${esc(o.id)}</small></span></label>`).join('')}
      </div></div>`;
    }
  }
  if (r.patches.length) {
    html += '<div class="group"><h4>Patch della ricetta</h4>';
    html += r.patches.map((p) => `<label class="check"><input type="checkbox" data-patch="${esc(p.file)}" ${p.enabled ? 'checked' : ''}><span>${esc(p.label)}<small>${esc(p.file)}${p.overridden ? ' · versione rifatta dall\'agente' : ''}</small></span></label>`).join('');
    html += '</div>';
  }
  if (!r.options.length && !r.patches.length) html += '<p class="empty">Questa ricetta non ha scelte.</p>';
  html += `<details><summary>Variabili che riceverà il figlio</summary><pre class="log">${esc(Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join('\n') || '(nessuna)')}</pre></details>`;
  wrap.innerHTML = html;

  const save = async (choices, extraOptions) => {
    await api(`/api/recipes/${r.name}/settings`, { choices, extraOptions });
    await load();
  };
  wrap.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.opt) save({ [t.dataset.opt]: t.checked });
    if (t.dataset.patch) save({ [`patch:${t.dataset.patch}`]: t.checked });
  });
  wrap.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const g = t.dataset.all ?? t.dataset.none;
    if (g) save(Object.fromEntries(r.options.filter((o) => (o.group ?? 'Altro') === g).map((o) => [o.id, t.dataset.all !== undefined])));
    if (t.dataset.add) {
      const listEnv = Object.keys(r.options.find((o) => o.list)?.list ?? {})[0];
      const extra = (data.config.recipes?.[r.name]?.extraOptions ?? []).concat({ id: t.dataset.add, group: 'Aggiunte da te', label: t.dataset.add, default: false, ...(listEnv ? { list: { [listEnv]: t.dataset.add } } : {}) });
      save({}, extra);
    }
  });
  return wrap;
}

function containerPanel(r) {
  const c = r.container;
  const f = document.createElement('form');
  f.className = 'form';
  f.innerHTML = `
    <p class="hint">Come viene installato il figlio su questa macchina. Usa indirizzi 127.0.0.1 e metti davanti il tuo proxy (Caddy, Nginx…).</p>
    <label class="field">Nome del container <input name="name" value="${esc(c.name)}" required pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*"></label>
    <label class="field">Porte (una per riga, host:container) <textarea name="ports">${esc((c.ports ?? []).join('\n'))}</textarea></label>
    <label class="field">Volumi (uno per riga) <textarea name="volumes">${esc((c.volumes ?? []).join('\n'))}</textarea></label>
    <label class="field">Limite di memoria (es. 1g, vuoto = nessuno) <input name="memory" value="${esc(c.memory ?? '')}"></label>
    <label class="field">Rete Docker (vuoto = predefinita) <input name="network" value="${esc(c.network ?? '')}"></label>
    <label class="field">Variabili in più (CHIAVE=valore, una per riga) <textarea name="env">${esc(Object.entries(r.containerEnv).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea></label>
    <label class="check"><input type="checkbox" name="deploy" ${r.deploy ? 'checked' : ''}><span>Installa da solo dopo le prove<small>altrimenti il figlio resta "pronto" finché non premi Installa</small></span></label>
    <label class="check"><input type="checkbox" name="adopt" ${r.adopt ? 'checked' : ''}><span>Adotta il container esistente con questo nome<small>serve per sostituire un'installazione fatta a mano: i volumi restano</small></span></label>
    <label class="field">Pubblica l'immagine dopo l'installazione (facoltativo) <input name="publishAs" value="${esc(r.publishAs)}" placeholder="ghcr.io/utente/nome"></label>
    <div><button>Salva</button></div>`;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    const env = Object.fromEntries(lines(v.env).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    try {
      await api(`/api/recipes/${r.name}/settings`, {
        container: { name: v.name, ports: lines(v.ports), volumes: lines(v.volumes), memory: v.memory || undefined, network: v.network || undefined, env },
        deploy: !!v.deploy, adopt: !!v.adopt, publishAs: v.publishAs.trim(),
      });
      toast('Salvato');
      await load();
    } catch (err) {
      toast(err.message);
    }
  });
  return f;
}

function activityPanel(r) {
  const wrap = document.createElement('div');
  const id = watchedRun ?? r.running ?? data.runs.find((x) => x.recipe === r.name)?.id;
  wrap.innerHTML = '<div id="run-view"><p class="empty">Nessuna attività ancora.</p></div>';
  if (id) showRun(id, wrap);
  const mine = data.runs.filter((x) => x.recipe === r.name);
  if (mine.length) {
    wrap.insertAdjacentHTML('beforeend', `<h4>Storico</h4><table class="history"><tbody>${mine
      .map((x) => `<tr><td>${when(x.startedAt)}</td><td>${esc(x.kind)}</td><td>${badge(x.status)}</td><td>${esc(x.message ?? '')}</td><td><button class="ghost" data-run="${esc(x.id)}">apri</button></td></tr>`)
      .join('')}</tbody></table>`);
  }
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-run]');
    if (b) {
      watchedRun = b.dataset.run;
      showRun(watchedRun, wrap);
    }
  });
  return wrap;
}

async function showRun(id, wrap = document) {
  const box = $('#run-view', wrap);
  if (!box) return;
  const run = await api(`/api/runs/${id}`).catch(() => null);
  if (!run) return;
  box.dataset.id = run.id;
  const rep = run.report ?? {};
  box.innerHTML = `
    <h4>${esc(run.kind)} · ${when(run.startedAt)} ${badge(run.status)}</h4>
    ${run.message ? `<p>${esc(run.message)}</p>` : ''}
    <ul class="steps">${run.steps.map((s) => `<li>${badge(s.status)}<div>${esc(s.name)}${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}</div></li>`).join('')}</ul>
    ${rep.review ? `<h4>Revisione dell'agente</h4><div class="review">${esc(rep.review)}</div>` : ''}
    ${rep.changelog ? `<details><summary>Commit nuovi (${rep.newCommits})</summary><pre class="log">${esc(rep.changelog)}</pre></details>` : ''}
    ${rep.releaseNotes ? `<details><summary>Note di rilascio</summary><pre class="log">${esc(rep.releaseNotes)}</pre></details>` : ''}
    <details ${run.status === 'in corso' ? 'open' : ''}><summary>Registro</summary><pre class="log" id="log">${esc(run.log.join('\n'))}</pre></details>`;
  const log = $('#log', box);
  log.scrollTop = log.scrollHeight;
}

async function action(r, act) {
  const labels = { update: 'Preparo il figlio della nuova versione…', install: 'Installo…', rollback: 'Torno alla versione precedente…', clean: 'Pulizia…' };
  if (act === 'install' && !confirm(`Sostituire il container "${r.container.name}" con il figlio ${r.state.candidate.version}?`)) return;
  if (act === 'rollback' && !confirm(`Rimettere la versione ${r.state.previous.version}?`)) return;
  const body = act === 'clean' ? { buildCache: confirm('Svuotare anche la cache di build di Docker? (libera spazio, la prossima build sarà più lenta)') } : {};
  try {
    const { id } = await api(`/api/recipes/${r.name}/${act}`, body);
    toast(labels[act]);
    watchedRun = id;
    tab = 'activity';
    await load();
  } catch (e) {
    toast(e.message);
  }
}

/* -------- impostazioni globali */
const dlg = $('#settings');
const form = $('#settings-form');
$('#open-settings').addEventListener('click', () => {
  const c = data.config;
  form.agentType.value = c.agent.type;
  form.agentAuth.value = c.agent.auth;
  form.apiKey.value = c.agent.apiKey;
  form.model.value = c.agent.model;
  form.review.checked = c.agent.review;
  form.fixPatches.checked = c.agent.fixPatches;
  form.keepVersions.value = c.keepVersions;
  $('#agent-status').textContent = `Stato: ${data.agent.reason}`;
  $('#scanners').innerHTML = Object.entries(data.scanners)
    .map(([id, s]) => `<label class="check"><input type="checkbox" name="scan-${id}" ${s.enabled ? 'checked' : ''}><span>${esc(s.label)} ${s.installed ? badge('ok') : badge('non installato')}<small>${esc(s.what)}${s.installed ? '' : ` · ${esc(s.install)}`}</small></span></label>`)
    .join('');
  syncAgentFields();
  dlg.showModal();
});
form.addEventListener('change', syncAgentFields);
function syncAgentFields() {
  $('.when-claude', form).hidden = form.agentType.value !== 'claude';
  $('.when-api', form).hidden = form.agentAuth.value !== 'api';
}
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save') return;
  try {
    await api('/api/settings', {
      agent: { type: form.agentType.value, auth: form.agentAuth.value, apiKey: form.apiKey.value, model: form.model.value.trim(), review: form.review.checked, fixPatches: form.fixPatches.checked },
      scanners: Object.fromEntries(Object.keys(data.scanners).map((id) => [id, form[`scan-${id}`].checked])),
      keepVersions: form.keepVersions.value,
    });
    toast('Impostazioni salvate');
    await load();
  } catch (e) {
    toast(e.message);
  }
});

/* -------- aggiornamenti in diretta */
let pending = null;
const es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
es.addEventListener('log', (e) => {
  const { id, line } = JSON.parse(e.data);
  const box = $('#run-view');
  if (box?.dataset.id !== id) return;
  const log = $('#log', box);
  log.textContent += `\n${line}`;
  log.scrollTop = log.scrollHeight;
});
es.addEventListener('run', () => {
  // Molti eventi ravvicinati durante un lavoro: un solo ricaricamento ogni tanto
  clearTimeout(pending);
  pending = setTimeout(async () => {
    const open = [...document.querySelectorAll('details[open] summary')].map((s) => s.textContent);
    await load();
    for (const s of document.querySelectorAll('details summary')) if (open.includes(s.textContent)) s.parentElement.open = true;
  }, 400);
});

// I lavori partiti da terminale non mandano eventi: finche' c'e' qualcosa in corso, si ricontrolla ogni 3 s
setInterval(async () => {
  if (!data?.recipes.some((r) => r.running) || document.hidden) return;
  await load();
}, 3000);

window.addEventListener('hashchange', () => {
  selected = location.hash.slice(1);
  load();
});
load();
