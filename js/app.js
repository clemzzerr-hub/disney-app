import * as C from './core.js';

// ---------- Utilitaires ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CFG_KEY = 'dlp-cfg-v1';
const cfg = (() => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; } })();
const saveCfg = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* stockage indisponible */ } };

// Code famille : partagé via le lien d'invitation (#f=...). Jamais stocké dans le dépôt.
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('f')) { cfg.topic = hash.get('f'); saveCfg(); history.replaceState(null, '', location.pathname); }
if (!cfg.topic) {
  const r = crypto.getRandomValues(new Uint8Array(10));
  cfg.topic = 'dlp-' + Array.from(r, (b) => (b % 36).toString(36)).join('');
  saveCfg();
}
const T = C.topics(cfg.topic);

const app = {
  plan: null, entities: [], live: [], hours: {}, liveAt: null, liveErr: false,
  fam: C.emptyState(), lastStateId: null, positions: {},
  view: 'now', map: null, layers: {}, myPos: null, wFilter: { park: 'all', type: 'ATTRACTION', sort: 'wait', q: '' },
  sentLocal: new Set(JSON.parse(sessionStorage.getItem('dlp-sent') || '[]')),
};

const now = () => {
  const n = C.parisNow();
  if (cfg.demo && cfg.demoTime) n.min = C.toMin(cfg.demoTime);
  return n;
};
const member = (id) => app.plan.family.find((m) => m.id === id);
const avatar = (m, dim) => m ? `<span class="av${dim ? ' dim' : ''}"><i style="--c:${esc(m.color)}">${esc(m.emoji || m.name[0])}</i>${esc(m.name)}</span>` : '';
const waitClass = (w) => (w == null ? 'x' : w <= 15 ? 'g' : w <= 40 ? 'o' : 'r');
const STATUS = { OPERATING: 'Ouvert', CLOSED: 'Fermé', DOWN: 'Interrompu', REFURBISHMENT: 'En rénovation' };

function toast(msg, ms = 4000) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- Données en direct ----------
function demoLive() {
  // Mode démo : attentes simulées, qui changent toutes les 5 minutes.
  const slot = Math.floor(now().min / 5);
  return app.entities.filter((e) => e.entityType === 'ATTRACTION').map((e) => {
    let h = 0; for (const c of e.id + slot) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return { id: e.id, name: e.name, entityType: e.entityType, parkId: e.parentId, status: h % 13 === 0 ? 'DOWN' : 'OPERATING', queue: { STANDBY: { waitTime: (h % 14) * 5 } } };
  });
}

async function refreshLive() {
  try {
    if (!app.entities.length) {
      app.entities = await C.fetchEntities();
      try { localStorage.setItem('dlp-entities', JSON.stringify(app.entities)); } catch { /* plein */ }
    }
    app.live = cfg.demo ? demoLive() : await C.fetchLive();
    app.liveAt = new Date(); app.liveErr = false;
  } catch (e) {
    app.liveErr = true;
    if (!app.entities.length) { try { app.entities = JSON.parse(localStorage.getItem('dlp-entities')) || []; } catch { /* rien */ } }
  }
  $('#live-dot').className = 'live-dot ' + (app.liveErr ? 'err' : 'ok');
  checkAlerts(); render();
}

async function refreshHours() {
  const today = C.parisNow().date;
  for (const [id, name] of Object.entries(C.PARKS)) {
    try {
      const s = (await C.fetchSchedule(id)).filter((x) => x.date === today);
      app.hours[id] = { name, items: s };
    } catch { /* horaires indisponibles */ }
  }
  render();
}

// ---------- Synchronisation famille (ntfy) ----------
async function loadFamily() {
  const today = C.parisNow().date;
  try {
    const msgs = await C.ntfyPoll(T.state);
    app.fam = C.stateFromMessages(msgs, today);
    app.lastStateId = msgs.at(-1)?.id || null;
    const pos = await C.ntfyPoll(T.pos, '2h');
    for (const m of pos) { try { const p = JSON.parse(m.message); app.positions[p.m] = { ...p, t: m.time }; } catch { /* ignoré */ } }
  } catch { toast('Synchronisation famille indisponible (hors ligne ?)'); }
  subscribe(T.state, (m) => {
    try { C.applyAction(app.fam, JSON.parse(m.message), C.parisNow().date); } catch { return; }
    checkAlerts(); render();
  });
  subscribe(T.pos, (m) => {
    try { const p = JSON.parse(m.message); app.positions[p.m] = { ...p, t: m.time }; } catch { return; }
    if (app.view === 'map') drawMap(); else if (app.view === 'family') render();
  });
  render();
}

function subscribe(topic, onMsg) {
  const es = new EventSource(`${C.NTFY}/${encodeURIComponent(topic)}/sse`);
  es.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.event === 'message') onMsg(m); } catch { /* ignoré */ } };
}

async function act(a) {
  const full = { ...a, day: C.parisNow().date, by: cfg.me || null };
  C.applyAction(app.fam, full, full.day);
  render();
  try { await C.ntfyPublish(T.state, { message: JSON.stringify(full) }); }
  catch { toast('Pas de réseau : la modification n\'est pas encore partagée.'); }
}

// ---------- Alertes ----------
async function checkAlerts() {
  if (!app.plan || !app.entities.length) return;
  const n = now();
  const hits = C.evaluate({ plan: app.plan, state: app.fam, entities: app.entities, live: app.live, now: n });
  for (const h of hits) {
    if (app.fam.alerts[h.key] || app.sentLocal.has(h.key)) continue;
    app.sentLocal.add(h.key);
    sessionStorage.setItem('dlp-sent', JSON.stringify([...app.sentLocal]));
    notifyLocal(h);
    if (cfg.demo) continue; // en démo, rien n'est envoyé à la famille
    act({ k: 'alert', key: h.key, t: Date.now(), title: h.title, message: h.message });
    C.ntfyPublish(T.alerts, { title: h.title, message: h.message, tags: [h.kind === 'wait' ? 'stopwatch' : h.kind === 'show' ? 'sparkles' : 'round_pushpin'], priority: h.kind === 'wait' ? 4 : 3, click: location.origin + location.pathname }).catch(() => {});
  }
}

async function notifyLocal(h) {
  toast(`🔔 ${h.title}${h.message ? ' — ' + h.message : ''}`, 8000);
  navigator.vibrate?.([200, 100, 200]);
  if (cfg.notif && 'Notification' in window && Notification.permission === 'granted') {
    try { (await navigator.serviceWorker.ready).showNotification(h.title, { body: h.message, tag: h.key, icon: 'icons/icon-192.png' }); }
    catch { try { new Notification(h.title, { body: h.message }); } catch { /* non pris en charge */ } }
  }
}

// ---------- Thèmes des films (stickers dessinés, clins d'œil) ----------
const STICKERS = {
  cars: `<svg class="sticker" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="#ffd23f" stroke="#fff" stroke-width="6"/><path d="M58 8 22 56h24l-8 36 40-52H54z" fill="#e8322b" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><text x="50" y="62" font-family="Fredoka,sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#fff" stroke="#23204a" stroke-width="1">95</text></svg>`,
  toy: `<svg class="sticker" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="#fff"/><path d="M50 8l11 24 26-3-17 20 17 20-26-3-11 24-11-24-26 3 17-20-17-20 26 3z" fill="#ffd400" stroke="#c99400" stroke-width="3" stroke-linejoin="round"/><circle cx="50" cy="51" r="13" fill="#ffe680" stroke="#c99400" stroke-width="3"/><circle cx="87" cy="29" r="4" fill="#ffd400"/><circle cx="13" cy="29" r="4" fill="#ffd400"/></svg>`,
  monsters: `<svg class="sticker" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="54" r="40" fill="#8fe04a" stroke="#fff" stroke-width="6"/><path d="M28 22 22 6l14 10M72 22l6-16-14 10" fill="#f3f0e0" stroke="#fff" stroke-width="3"/><circle cx="50" cy="46" r="18" fill="#fff"/><circle cx="52" cy="47" r="9" fill="#23b26d"/><circle cx="54" cy="45" r="4" fill="#23204a"/><path d="M32 72q18 12 36 0" fill="none" stroke="#23204a" stroke-width="4" stroke-linecap="round"/><path d="M42 75v5h6v-4M54 76v4h5v-5" fill="#fff"/></svg>`,
  stitch: `<svg class="sticker" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="#fff"/><g fill="#ff4f98" stroke="#fff" stroke-width="3">${[0, 72, 144, 216, 288].map((a) => `<ellipse cx="50" cy="28" rx="16" ry="22" transform="rotate(${a} 50 50)"/>`).join('')}</g><circle cx="50" cy="50" r="9" fill="#ffd23f"/><path d="M50 50l18 -26" stroke="#ffd23f" stroke-width="3" stroke-linecap="round"/><circle cx="68" cy="24" r="4" fill="#ffd23f"/></svg>`,
};
const HEROES = {
  now: ['cars', 'Ka-chow ! On fonce.', 'Vitesse… mais dans l\'ordre du programme.'],
  day: ['toy', 'Vers l\'infini et au-delà !', 'Tout le programme de la journée, partagé avec la famille.'],
  waits: ['monsters', 'Le cri-mètre des files d\'attente', 'Plus c\'est vert, moins on attend. Touchez 🔔 pour être prévenu.'],
  family: ['stitch', 'Ohana signifie famille.', 'Et dans la famille, personne n\'est abandonné, ni oublié.'],
};
const THEME_COLOR = { now: '#d7262b', map: '#d7262b', day: '#1e6fd9', waits: '#6a3fd1', family: '#2f6fe4' };
function hero(view) {
  const [k, title, sub] = HEROES[view];
  const cls = { cars: 'cars', toy: 'toy', monsters: 'monsters', stitch: 'stitch' }[k];
  return `<div class="hero ${cls}">${STICKERS[k]}<b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
}

// ---------- Rendu ----------
function render() {
  if (!app.plan) return;
  const n = now();
  $('#clock').textContent = C.fmt(n.min) + (cfg.demo ? ' (démo)' : '');
  ({ now: renderNow, day: renderDay, map: drawMap, waits: renderWaits, family: renderFamily })[app.view]();
}

function schedule() { return C.computeSchedule(app.plan, app.fam, app.entities); }
function liveFor(entity) { return entity ? app.live.find((x) => x.id === entity.id) : null; }

function currentIndex(sch, min) {
  const todo = sch.filter((s) => s.status === 'todo');
  if (!todo.length) return -1;
  const cur = todo.filter((s) => s.start <= min).at(-1) || todo[0];
  return sch.indexOf(cur);
}

function stepCard(s, n, isCurrent) {
  const e = s.place?.entity;
  const l = liveFor(e);
  const w = C.waitOf(l);
  const when = isCurrent && s.start <= n.min ? `Maintenant · ${C.fmt(s.start)} → ${C.fmt(s.end)}` : `Prochaine étape · ${C.fmt(s.start)}`;
  const who = (s.who || app.plan.family.map((m) => m.id)).map((id) => avatar(member(id))).join('');
  return `
  <div class="card">
    <div class="label">${esc(when)}</div>
    <h2>${esc(s.title)}</h2>
    <div class="row small">
      <span class="tag ${esc(s.type)}">${esc(s.type || 'étape')}</span>
      <span class="muted">${s.place && C.norm(s.place.name) !== C.norm(s.title) ? esc(s.place.name) + ' · ' : ''}${s.duration} min</span>
      ${e?.entityType === 'ATTRACTION' ? `<span class="wait ${waitClass(w)}">${w != null ? w + ' min' : esc(STATUS[l?.status] || '—')}</span>` : ''}
    </div>
    ${s.note ? `<p class="note small">${esc(s.note)}</p>` : ''}
    ${s.alert ? `<p class="small muted">🔔 Alerte si l'attente passe sous ${esc(s.alert.max)} min.</p>` : ''}
    <div class="avatars" style="margin:10px 0 14px">${who}</div>
    <div class="row">
      <button class="btn gold" data-step="${esc(s.id)}" data-status="done">Fait</button>
      <button class="btn" data-step="${esc(s.id)}" data-status="skipped">Passer</button>
      ${s.place ? `<button class="btn ghost" data-goto="${esc(s.id)}">Voir sur la carte</button>` : ''}
    </div>
  </div>`;
}

function renderNow() {
  const n = now(); const sch = schedule(); const i = currentIndex(sch, n.min);
  const hits = C.evaluate({ plan: app.plan, state: app.fam, entities: app.entities, live: app.live, now: n }).filter((h) => h.kind !== 'step');
  const recent = Object.entries(app.fam.alerts).sort((a, b) => b[1].t - a[1].t).slice(0, 3);
  let html = hero('now');
  if (app.plan.exemple) html += `<div class="card thanks small"><b>Programme d'exemple.</b> Envoie ton guide de la journée parfaite à Claude : il remplacera ce programme et ses alertes.</div>`;
  if (hits.length) {
    html += `<div class="card alert-card"><div class="label">C'est le moment</div>${hits.map((h) => `
      <div class="alert-item"><span>🔔</span><div class="grow"><b>${esc(h.title)}</b><span class="small muted">${esc(h.message)}</span></div>
      ${h.entity ? `<button class="btn small" data-focus="${esc(h.entity.id)}">Carte</button>` : ''}</div>`).join('')}</div>`;
  }
  if (i >= 0) {
    html += stepCard(sch[i], n, true);
    html += `<div class="card"><div class="spread"><span class="muted small">En retard ?</span>
      <div class="row">${[15, 30, 60].map((d) => `<button class="btn small" data-delay="${d}">+${d}</button>`).join('')}
      ${app.fam.delay ? `<button class="btn small ghost" data-delay="0">À l'heure</button>` : ''}</div></div>
      ${app.fam.delay ? `<p class="small muted" style="margin:8px 0 0">Tout le programme est décalé de ${app.fam.delay} min (sauf les réservations à heure fixe).</p>` : ''}</div>`;
    const next = sch.slice(i + 1).filter((s) => s.status === 'todo').slice(0, 3);
    if (next.length) {
      html += `<div class="card"><div class="label">Ensuite</div><div class="list">${next.map((s) => `
        <div class="item"><b class="serif" style="color:var(--gold);min-width:52px">${C.fmt(s.start)}</b><div class="grow"><div class="name">${esc(s.title)}</div>
        <div class="sub">${esc(s.place?.name || '')}${s.walk ? ` · ~${s.walk} min à pied` : ''}</div></div><span class="tag ${esc(s.type)}">${esc(s.type || '')}</span></div>`).join('')}</div></div>`;
    }
  } else {
    html += `<div class="card"><div class="label">Journée terminée</div><h2>Bravo, tout le programme est fait ✨</h2><p class="muted">Tu peux réinitialiser la journée depuis l'onglet Journée.</p></div>`;
  }
  if (recent.length) {
    html += `<div class="card"><div class="label">Dernières alertes envoyées</div><div class="list">${recent.map(([, a]) => `
      <div class="item"><div class="grow"><div class="name">${esc(a.title)}</div><div class="sub">${esc(a.message || '')}</div></div>
      <span class="small muted">${new Date(a.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' })}</span></div>`).join('')}</div></div>`;
  }
  const hrs = Object.values(app.hours).map((h) => {
    const op = h.items.find((x) => x.type === 'OPERATING'); const ex = h.items.find((x) => x.type === 'EXTRA_HOURS');
    if (!op) return `<div class="item"><div class="grow name">${esc(h.name)}</div><span class="muted small">Horaires inconnus</span></div>`;
    return `<div class="item"><div class="grow"><div class="name">${esc(h.name)}</div>${ex ? `<div class="sub">Extra Magic Time dès ${C.fmt(C.isoToParisMin(ex.openingTime))}</div>` : ''}</div>
      <b>${C.fmt(C.isoToParisMin(op.openingTime))} – ${C.fmt(C.isoToParisMin(op.closingTime))}</b></div>`;
  }).join('');
  if (hrs) html += `<div class="card"><div class="label">Horaires du jour</div><div class="list">${hrs}</div></div>`;
  $('#view-now').innerHTML = html;
}

function renderDay() {
  const n = now(); const sch = schedule(); const ci = currentIndex(sch, n.min);
  const rows = sch.map((s, i) => {
    const moved = s.status === 'todo' && C.toMin(s.start) !== null && C.toMin(app.plan.steps.find((x) => x.id === s.id)?.start) !== s.start;
    const planned = app.plan.steps.find((x) => x.id === s.id)?.start;
    return `<div class="step ${s.status} ${i === ci ? 'current' : ''}">
      <div class="time">${C.fmt(s.start)}${moved ? `<s>${esc(planned.replace(':', 'h'))}</s>` : ''}</div>
      <div><div class="title name">${esc(s.title)}</div>
        <div class="small muted">${esc(s.place?.name && C.norm(s.place.name) !== C.norm(s.title) ? s.place.name : '')}${s.fixed ? ' · heure fixe' : ''}${s.alert ? ` · 🔔 ≤ ${esc(s.alert.max)} min` : ''}</div>
        <span class="tag ${esc(s.type)}">${esc(s.type || 'étape')}</span></div>
      <div class="acts">${s.status === 'todo'
        ? `<button title="Fait" data-step="${esc(s.id)}" data-status="done">✓</button><button title="Passer" data-step="${esc(s.id)}" data-status="skipped">✕</button>`
        : `<button title="Annuler" data-step="${esc(s.id)}" data-status="">↺</button>`}
        <button title="Plus tôt" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button title="Plus tard" data-move="${i}" data-dir="1" ${i === sch.length - 1 ? 'disabled' : ''}>↓</button></div>
    </div>`;
  }).join('');
  const done = sch.filter((s) => s.status !== 'todo').length;
  $('#view-day').innerHTML = hero('day') + `
    <div class="card"><div class="spread"><div><div class="label">Le programme</div><h3 style="margin:4px 0 0">${done} / ${sch.length} étapes</h3></div>
      <div class="row">${app.fam.delay ? `<span class="tag">+${app.fam.delay} min</span>` : ''}</div></div>
      <p class="small muted" style="margin:8px 0 0">Coche une étape faite ou passée : la suite se recalcule sur le téléphone de toute la famille. ↑ ↓ pour échanger deux étapes.</p></div>
    <div class="card"><div>${rows}</div></div>
    <button class="btn ghost" id="reset-day">Réinitialiser la journée</button>`;
}

function renderWaits() {
  const f = app.wFilter; const n = now();
  const idx = C.liveIndex(app.live);
  const myRules = Object.values(app.fam.rules);
  let items = app.entities.filter((e) => e.entityType === f.type && (f.park === 'all' || e.parentId === f.park));
  if (f.q) items = items.filter((e) => C.norm(e.name).includes(C.norm(f.q)));
  items = items.map((e) => ({ e, l: idx.get(e.id), w: C.waitOf(idx.get(e.id)) }));
  if (f.type === 'SHOW') {
    items.forEach((x) => { x.next = (x.l?.showtimes || []).map((t) => C.isoToParisMin(t.startTime)).filter((m) => m >= n.min).sort((a, b) => a - b); });
    items = items.filter((x) => x.next.length).sort((a, b) => a.next[0] - b.next[0]);
  } else if (f.sort === 'wait') items.sort((a, b) => (a.w ?? 999) - (b.w ?? 999) || a.e.name.localeCompare(b.e.name));
  else items.sort((a, b) => a.e.name.localeCompare(b.e.name));

  const rowsHtml = items.map(({ e, l, w, next }) => {
    const rule = myRules.find((r) => r.ride === e.id || r.show === e.id);
    let sub = C.PARKS[e.parentId] || '';
    if (f.type === 'ATTRACTION') {
      sub += ` · ${STATUS[l?.status] || 'Pas de données'}`;
      const sr = l?.queue?.SINGLE_RIDER?.waitTime; if (typeof sr === 'number') sub += ` · Single Rider ${sr} min`;
      const pa = l?.queue?.PAID_RETURN_TIME; if (pa?.price?.formatted) sub += ` · Premier Access ${pa.price.formatted}${pa.state === 'FINISHED' ? ' (épuisé)' : ''}`;
    } else sub += ` · ${next.slice(0, 4).map(C.fmt).join(', ')}`;
    const badge = f.type === 'ATTRACTION' ? `<span class="wait ${waitClass(w)}">${w != null ? w + ' min' : esc(STATUS[l?.status] || '—')}</span>` : `<span class="wait">${C.fmt(next[0])}</span>`;
    return `<div class="item"><div class="grow"><div class="name">${esc(e.name)}</div><div class="sub">${esc(sub)}</div>
      ${f.type === 'ATTRACTION' && w != null ? `<div class="meter"><i style="width:${Math.max(6, Math.min(100, w / 90 * 100))}%"></i></div>` : ''}
      ${rule ? `<div class="sub" style="color:var(--gold)">🔔 ${rule.kind === 'wait' ? `alerte sous ${esc(rule.max)} min` : `alerte ${esc(rule.before)} min avant`}</div>` : ''}</div>
      ${badge}<button class="icon-btn ${rule ? 'on' : ''}" data-bell="${esc(e.id)}" aria-label="Alerte">🔔</button></div>`;
  }).join('') || `<p class="muted">Aucun résultat${app.liveErr ? ' (données indisponibles)' : ''}.</p>`;

  $('#view-waits').innerHTML = hero('waits') + `
    <div class="chips">${[['ATTRACTION', 'Attractions'], ['SHOW', 'Spectacles']].map(([k, v]) => `<button class="chip ${f.type === k ? 'on' : ''}" data-wtype="${k}">${v}</button>`).join('')}
      <button class="chip ${f.park === 'all' ? 'on' : ''}" data-wpark="all">Les 2 parcs</button>
      ${Object.entries(C.PARKS).map(([id, nm]) => `<button class="chip ${f.park === id ? 'on' : ''}" data-wpark="${id}">${esc(nm)}</button>`).join('')}</div>
    <div class="row"><input id="wq" placeholder="Rechercher…" value="${esc(f.q)}" style="flex:1">
      ${f.type === 'ATTRACTION' ? `<button class="btn small" id="wsort">${f.sort === 'wait' ? 'Tri : attente' : 'Tri : A → Z'}</button>` : ''}</div>
    <div class="card"><div class="list">${rowsHtml}</div></div>
    <p class="small footnote">${cfg.demo ? 'Mode démo : attentes simulées. ' : ''}Mis à jour ${app.liveAt ? app.liveAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—'} · Source : themeparks.wiki. Touchez 🔔 pour être prévenu.</p>`;
  const q = $('#wq'); q.oninput = () => { f.q = q.value; renderWaits(); const nq = $('#wq'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); };
}

function renderFamily() {
  const fam = app.plan.family;
  const pos = (id) => { const p = app.positions[id]; if (!p) return 'Position non partagée'; const m = Math.round((Date.now() / 1000 - p.t) / 60); return `Vu il y a ${m < 1 ? 'moins d\'1' : m} min`; };
  const invite = location.origin + location.pathname + '#f=' + cfg.topic;
  const planRules = C.allRules(app.plan, { rules: {} });
  const myRules = Object.values(app.fam.rules);
  $('#view-family').innerHTML = hero('family') + `
    <div class="card"><div class="label">La famille</div><div class="list">${fam.map((m) => `
      <div class="item">${avatar(m)}<div class="grow"><div class="sub">${esc(pos(m.id))}</div></div>
      <button class="btn small ${cfg.me === m.id ? 'gold' : ''}" data-me="${esc(m.id)}">${cfg.me === m.id ? "C'est moi" : 'Je suis…'}</button></div>`).join('')}</div></div>

    <div class="card"><div class="label">Inviter la famille</div>
      <p class="small">Envoie ce lien aux autres : tout le monde partage le même programme, les mêmes alertes et les positions.</p>
      <div class="row"><code style="flex:1">${esc(invite)}</code><button class="btn small" id="copy-invite">Copier</button></div></div>

    <div class="card"><div class="label">Notifications</div>
      <div class="switch"><div><b>Sur ce téléphone</b><div class="small muted">Quand l'appli est ouverte.</div></div>
        <button class="btn small ${cfg.notif ? 'gold' : ''}" id="tg-notif">${cfg.notif ? 'Activées' : 'Activer'}</button></div>
      <div class="switch"><div><b>Même téléphone en veille</b><div class="small muted">1. Installe l'appli gratuite <b>ntfy</b> (App Store / Play Store).<br>2. Abonne-toi au canal : <code>${esc(T.alerts)}</code></div></div>
        <button class="btn small" id="copy-topic">Copier</button></div>
      <div class="switch"><div><b>Tester</b><div class="small muted">Envoie une alerte d'essai à toute la famille.</div></div>
        <button class="btn small" id="test-alert">Envoyer</button></div></div>

    <div class="card"><div class="label">Partage de position</div>
      <div class="switch"><div><b>Partager ma position</b><div class="small muted">Visible par la famille sur la carte, mise à jour chaque minute.</div></div>
        <button class="btn small ${cfg.share ? 'gold' : ''}" id="tg-share">${cfg.share ? 'Activé' : 'Activer'}</button></div></div>

    <div class="card"><div class="label">Alertes du guide</div><div class="list">${planRules.map((r) => `
      <div class="item"><div class="grow"><div class="name">${esc(r.title || r.ride || r.show || 'Rappel')}</div><div class="sub">${esc(ruleText(r))}</div></div></div>`).join('') || '<p class="muted small">Aucune.</p>'}</div>
      ${myRules.length ? `<div class="label" style="margin-top:12px">Ajoutées depuis l'onglet Attentes</div><div class="list">${myRules.map((r) => `
      <div class="item"><div class="grow"><div class="name">${esc(nameOf(r.ride || r.show))}</div><div class="sub">${esc(ruleText(r))}</div></div>
      <button class="icon-btn" data-unrule="${esc(r.id)}" aria-label="Supprimer">✕</button></div>`).join('')}</div>` : ''}
      ${app.plan.settings?.stepReminderMin ? `<p class="small muted">+ rappel ${app.plan.settings.stepReminderMin} min avant chaque étape.</p>` : ''}</div>

    <div class="card"><div class="label">Mode démo</div>
      <p class="small muted">Pour tester l'appli à la maison : attentes simulées et heure choisie. Les alertes restent sur ce téléphone.</p>
      <div class="row"><button class="btn small ${cfg.demo ? 'gold' : ''}" id="tg-demo">${cfg.demo ? 'Démo activée' : 'Activer la démo'}</button>
        <input type="time" id="demo-time" value="${esc(cfg.demoTime || '')}" style="width:auto" ${cfg.demo ? '' : 'disabled'}></div></div>
    <p class="small footnote">Données d'attente : themeparks.wiki · Carte : © OpenStreetMap. Application personnelle, sans lien avec Disney.</p>`;
}

const nameOf = (idOrName) => app.entities.find((e) => e.id === idOrName)?.name || idOrName;
function ruleText(r) {
  const win = r.from || r.to ? ` entre ${r.from || 'l\'ouverture'} et ${r.to || 'la fermeture'}` : '';
  if (r.kind === 'wait') return `Attente ≤ ${r.max} min${win}`;
  if (r.kind === 'time') return `À ${String(r.at).replace(':', 'h')}${r.message ? ' — ' + r.message : ''}`;
  if (r.kind === 'show') return `${r.before || 20} min avant chaque représentation${win}`;
  return '';
}

// ---------- Carte ----------
function initMap() {
  if (app.map || !window.L) return;
  app.map = L.map('map', { zoomControl: false, attributionControl: true }).setView([48.8722, 2.7765], 16);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(app.map);
  app.layers = { waits: L.layerGroup().addTo(app.map), route: L.layerGroup().addTo(app.map), steps: L.layerGroup().addTo(app.map), fam: L.layerGroup().addTo(app.map) };
  app.map.on('popupopen', (ev) => bindActions(ev.popup.getElement()));
}

function drawMap() {
  initMap(); if (!app.map) return;
  setTimeout(() => app.map.invalidateSize(), 50);
  const sch = schedule(); const L_ = app.layers; const idx = C.liveIndex(app.live);
  Object.values(L_).forEach((l) => l.clearLayers());
  for (const e of app.entities) {
    if (e.entityType !== 'ATTRACTION' || !e.location?.latitude) continue;
    const w = C.waitOf(idx.get(e.id)); if (w == null) continue;
    L.marker([e.location.latitude, e.location.longitude], { icon: L.divIcon({ className: '', html: `<div class="wpin ${waitClass(w)}">${w}</div>`, iconSize: [0, 0] }) })
      .bindPopup(`<b>${esc(e.name)}</b><br>${w} min d'attente<br><button class="btn small" data-bell="${esc(e.id)}" style="margin-top:8px">🔔 Me prévenir</button>`).addTo(L_.waits);
  }
  const pts = [];
  if (app.myPos) pts.push([app.myPos.lat, app.myPos.lng]);
  sch.forEach((s, i) => {
    if (!s.place) return;
    if (s.status === 'todo') pts.push([s.place.lat, s.place.lng]);
    L.marker([s.place.lat, s.place.lng], { icon: L.divIcon({ className: '', html: `<div class="pin ${s.status !== 'todo' ? 'done' : esc(s.type)}">${s.status !== 'todo' ? '✓' : i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }), zIndexOffset: 500 })
      .bindPopup(`<div class="label">${C.fmt(s.start)} · ${s.duration} min</div><b>${esc(s.title)}</b><br><span class="muted small">${esc(s.place.name)}</span>
        ${s.note ? `<p class="small">${esc(s.note)}</p>` : '<br>'}${s.status === 'todo' ? `<div class="row" style="margin-top:6px"><button class="btn small gold" data-step="${esc(s.id)}" data-status="done">Fait</button><button class="btn small" data-step="${esc(s.id)}" data-status="skipped">Passer</button></div>` : '<i class="muted">Terminé</i>'}`)
      .addTo(L_.steps);
  });
  if (pts.length > 1) L.polyline(pts, { color: '#3d5bff', weight: 5, opacity: .8, dashArray: '2 9', lineCap: 'round' }).addTo(L_.route);
  for (const [id, p] of Object.entries(app.positions)) {
    const m = member(id); if (!m || (Date.now() / 1000 - p.t) > 3600) continue;
    L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<div class="fpin" style="--c:${esc(m.color)}">${esc(m.emoji || m.name[0])}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }), zIndexOffset: 1000 })
      .bindPopup(`<b>${esc(m.name)}</b><br>${esc(Math.round((Date.now() / 1000 - p.t) / 60))} min`).addTo(L_.fam);
  }
  if (app.myPos && !app.positions[cfg.me]) L.circleMarker([app.myPos.lat, app.myPos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#3d7bff', fillOpacity: 1 }).addTo(L_.fam);
  let walk = 0, prev = app.myPos; const todo = sch.filter((s) => s.status === 'todo');
  for (const s of todo) { if (s.place) { if (prev) walk += C.walkMin(prev, s.place); prev = s.place; } }
  const me = member(cfg.me);
  $('#map-panel').innerHTML = `<div class="spread"><b>${todo.length} étapes · ~${walk} min de marche</b>
      <button class="btn small" id="locate">📍 Me localiser</button></div>
    <div class="spread small muted"><span>${cfg.share ? `Position partagée en tant que ${esc(me?.name || '?')}` : 'Position non partagée'}</span>
      <button class="btn small ${cfg.share ? 'gold' : ''}" id="tg-share">${cfg.share ? 'Partage activé' : 'Partager'}</button></div>`;
}

function focusMap(lat, lng) { show('map'); setTimeout(() => app.map?.setView([lat, lng], 18), 80); }

// ---------- Géolocalisation ----------
let geoWatch = null, lastSent = 0;
function startGeo(prompted) {
  if (!('geolocation' in navigator)) { if (prompted) toast('Géolocalisation non disponible.'); return; }
  if (geoWatch != null) return;
  geoWatch = navigator.geolocation.watchPosition((p) => {
    app.myPos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (cfg.share && cfg.me && Date.now() - lastSent > 60000) {
      lastSent = Date.now();
      C.ntfyPublish(T.pos, { message: JSON.stringify({ m: cfg.me, lat: +app.myPos.lat.toFixed(5), lng: +app.myPos.lng.toFixed(5) }) }).catch(() => {});
    }
    if (app.view === 'map') drawMap();
  }, () => { if (prompted) toast('Autorise la localisation dans les réglages du navigateur.'); geoWatch = null; }, { enableHighAccuracy: true, maximumAge: 20000 });
}

// ---------- Interactions ----------
function bindActions(root) {
  root.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { act({ k: 'step', id: b.dataset.step, status: b.dataset.status || null }); app.map?.closePopup(); }; });
  root.querySelectorAll('[data-bell]').forEach((b) => { b.onclick = () => bellDialog(b.dataset.bell); });
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.view) return show(d.view);
  if (d.step !== undefined) return act({ k: 'step', id: d.step, status: d.status || null });
  if (d.delay !== undefined) return act({ k: 'delay', v: Number(d.delay) ? (app.fam.delay || 0) + Number(d.delay) : 0 });
  if (d.move !== undefined) {
    const ids = schedule().map((s) => s.id); const i = Number(d.move), j = i + Number(d.dir);
    [ids[i], ids[j]] = [ids[j], ids[i]]; return act({ k: 'order', ids });
  }
  if (d.goto) { const s = schedule().find((x) => x.id === d.goto); if (s?.place) focusMap(s.place.lat, s.place.lng); return; }
  if (d.focus) { const e = app.entities.find((x) => x.id === d.focus); if (e?.location) focusMap(e.location.latitude, e.location.longitude); return; }
  if (d.bell) return bellDialog(d.bell);
  if (d.unrule) return act({ k: 'unrule', id: d.unrule });
  if (d.me) { cfg.me = d.me; saveCfg(); return render(); }
  if (d.wtype) { app.wFilter.type = d.wtype; return renderWaits(); }
  if (d.wpark) { app.wFilter.park = d.wpark; return renderWaits(); }
  switch (b.id) {
    case 'wsort': app.wFilter.sort = app.wFilter.sort === 'wait' ? 'name' : 'wait'; return renderWaits();
    case 'reset-day': if (confirm('Remettre toutes les étapes à faire pour toute la famille ?')) act({ k: 'reset' }); return;
    case 'copy-invite': return copy(location.origin + location.pathname + '#f=' + cfg.topic);
    case 'copy-topic': return copy(T.alerts);
    case 'tg-notif': return toggleNotif();
    case 'tg-share':
      if (!cfg.me) { show('family'); return toast('Choisis d\'abord qui tu es dans la famille.'); }
      cfg.share = !cfg.share; saveCfg(); if (cfg.share) { lastSent = 0; startGeo(true); } return render();
    case 'locate': startGeo(true); if (app.myPos) app.map.setView([app.myPos.lat, app.myPos.lng], 18); return;
    case 'test-alert':
      return C.ntfyPublish(T.alerts, { title: 'Test : tout fonctionne ✨', message: 'Les alertes de la journée arriveront ici.', tags: ['sparkles'] })
        .then(() => toast('Alerte d\'essai envoyée.')).catch(() => toast('Échec de l\'envoi (réseau ?)'));
    case 'tg-demo': cfg.demo = !cfg.demo; if (!cfg.demo) cfg.demoTime = ''; saveCfg(); return refreshLive();
    default: break;
  }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'demo-time') { cfg.demoTime = ev.target.value; saveCfg(); refreshLive(); }
});

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copié !'); } catch { prompt('Copie ce texte :', text); }
}

async function toggleNotif() {
  if (cfg.notif) { cfg.notif = false; saveCfg(); return render(); }
  if (!('Notification' in window)) return toast('Ce navigateur ne gère pas les notifications. Sur iPhone : ajoute d\'abord l\'appli à l\'écran d\'accueil.');
  const p = await Notification.requestPermission();
  cfg.notif = p === 'granted'; saveCfg(); render();
  if (!cfg.notif) toast('Notifications refusées. Utilise l\'appli ntfy à la place.');
}

function bellDialog(entityId) {
  const e = app.entities.find((x) => x.id === entityId); if (!e) return;
  const existing = Object.values(app.fam.rules).find((r) => r.ride === e.id || r.show === e.id);
  const isShow = e.entityType === 'SHOW';
  const dlg = $('#dlg');
  dlg.innerHTML = `<form method="dialog" style="display:flex;flex-direction:column;gap:12px">
    <div class="label">Alerte</div><h3 style="margin:0">${esc(e.name)}</h3>
    ${isShow ? `<label class="field">Me prévenir combien de minutes avant ?<input name="v" type="number" min="5" max="120" value="${esc(existing?.before || 20)}"></label>`
      : `<label class="field">Me prévenir quand l'attente passe sous (minutes)<input name="v" type="number" min="5" max="180" step="5" value="${esc(existing?.max || 20)}"></label>`}
    <div class="row"><label class="field" style="flex:1">À partir de<input name="from" type="time" value="${esc(existing?.from || '')}"></label>
      <label class="field" style="flex:1">Jusqu'à<input name="to" type="time" value="${esc(existing?.to || '')}"></label></div>
    <p class="small muted" style="margin:0">L'alerte est partagée avec toute la famille et envoyée une fois dans la journée.</p>
    <div class="row" style="justify-content:flex-end">
      ${existing ? '<button value="del" class="btn ghost">Supprimer</button>' : ''}<button value="cancel" class="btn ghost">Annuler</button><button value="ok" class="btn gold">Enregistrer</button></div></form>`;
  dlg.showModal();
  dlg.onclose = () => {
    const f = dlg.querySelector('form'); const v = Number(f.v.value);
    if (dlg.returnValue === 'del' && existing) act({ k: 'unrule', id: existing.id });
    if (dlg.returnValue !== 'ok' || !v) return;
    const rule = { id: existing?.id || 'u' + Date.now().toString(36), kind: isShow ? 'show' : 'wait', from: f.from.value || undefined, to: f.to.value || undefined };
    if (isShow) { rule.show = e.id; rule.before = v; } else { rule.ride = e.id; rule.max = v; }
    act({ k: 'rule', rule }); toast('Alerte enregistrée 🔔');
  };
}

function show(view) {
  app.view = view;
  document.body.dataset.theme = view;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[view]);
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + view; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  try { sessionStorage.setItem('dlp-view', view); } catch { /* rien */ }
  window.scrollTo(0, 0); render();
}

// ---------- Écran d'accueil animé ----------
function splash() {
  const el = $('#splash');
  if (sessionStorage.getItem('dlp-splash')) return;
  el.hidden = false;
  $('#splash-title').textContent = app.plan.title;
  $('#splash-sub').textContent = app.plan.subtitle + (app.plan.date ? ' · ' + new Date(app.plan.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '');
  const fam = app.plan.family; const box = $('#splash-avatars');
  box.innerHTML = fam.map((m, i) => {
    const a = (Math.PI * (i + .5)) / fam.length; const x = 50 - Math.cos(a) * 36; const y = 6 + Math.sin(a) * 14;
    return `<span class="av" style="left:calc(${x}% - 31px);top:${y}%">${avatar(m).replace(/^<span class="av">|<\/span>$/g, '')}</span>`;
  }).join('');
  const cv = $('#fireworks'); const ctx = cv.getContext('2d'); let parts = []; let run = true;
  const resize = () => { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; }; resize();
  const colors = ['#f4c04f', '#ff8fc8', '#8fd3ff', '#b69cff', '#7dffc1'];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function burst() {
    const x = cv.width * (.15 + Math.random() * .7), y = cv.height * (.1 + Math.random() * .35), c = colors[Math.floor(Math.random() * colors.length)];
    for (let i = 0; i < 60; i++) { const a = Math.random() * 6.28, s = (1 + Math.random() * 3) * devicePixelRatio; parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, c }); }
  }
  function frame() {
    if (!run) return;
    ctx.fillStyle = 'rgba(10,13,42,.22)'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (Math.random() < .05) burst();
    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) { p.x += p.vx; p.y += p.vy; p.vy += .03 * devicePixelRatio; p.life -= .012; ctx.globalAlpha = Math.max(p.life, 0); ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, 2.5 * devicePixelRatio, 2.5 * devicePixelRatio); }
    ctx.globalAlpha = 1; requestAnimationFrame(frame);
  }
  if (!reduce) { burst(); frame(); }
  $('#splash-go').onclick = () => { run = false; el.hidden = true; sessionStorage.setItem('dlp-splash', '1'); if (!cfg.me) show('family'); };
}

// ---------- Démarrage ----------
async function start() {
  app.plan = await (await fetch('plan.json', { cache: 'no-cache' })).json();
  document.title = app.plan.title;
  $('#hdr-title').textContent = app.plan.title;
  $('#hdr-sub').textContent = app.plan.subtitle;
  splash();
  show(sessionStorage.getItem('dlp-view') || 'now');
  await Promise.all([refreshLive(), loadFamily()]);
  refreshHours();
  if (cfg.share) startGeo(false);
  setInterval(refreshLive, 60000);
  setInterval(() => { checkAlerts(); if (app.view !== 'map') render(); else $('#clock').textContent = C.fmt(now().min); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
start().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<p class="card" style="margin:16px">Impossible de charger l'appli : ${esc(e.message)}</p>`); });
