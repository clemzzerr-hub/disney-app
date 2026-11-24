// Logique partagée entre l'application (navigateur) et le veilleur (Cloudflare Worker).
// Aucune dépendance au DOM ici.

export const API = 'https://api.themeparks.wiki/v1';
export const DESTINATION_ID = 'e8d0207f-da8a-4048-bec8-117aa946b2c2';
export const PARKS = {
  'dae968d5-630d-4719-8b06-3d107e944401': 'Disneyland Park',
  'ca888437-ebb4-4d50-aed2-d227f7096968': 'Disney Adventure World',
};
export const NTFY = 'https://ntfy.sh';

// Lieux utiles qui ne sont pas des attractions (coordonnées approximatives).
export const PLACES = {
  'entree': { name: 'Entrée des parcs', lat: 48.8713, lng: 2.7790 },
  'gare': { name: 'Gare Marne-la-Vallée – Chessy', lat: 48.8700, lng: 2.7830 },
  'disney village': { name: 'Disney Village', lat: 48.8695, lng: 2.7860 },
  'chateau': { name: 'Château de la Belle au Bois Dormant', lat: 48.8730, lng: 2.7763 },
};

// ---------- Heure de Paris ----------
export function parisNow(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
export const toMin = (hhmm) => {
  if (hhmm == null || hhmm === '') return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};
export const fmt = (min) => {
  if (min == null) return '';
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}h${String(m % 60).padStart(2, '0')}`;
};
export function isoToParisMin(iso) {
  return parisNow(new Date(iso)).min;
}

// ---------- Recherche d'une attraction par son nom ----------
export const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[®™*"“”’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function findEntity(entities, query) {
  if (!query || !entities?.length) return null;
  const byId = entities.find((e) => e.id === query);
  if (byId) return byId;
  const q = norm(query);
  // On préfère les attractions/spectacles/restaurants aux gares du train.
  const pool = entities.filter((e) => e.entityType !== 'PARK');
  return pool.find((e) => norm(e.name) === q)
    || pool.find((e) => norm(e.name).startsWith(q))
    || pool.find((e) => norm(e.name).includes(q))
    || pool.find((e) => q.includes(norm(e.name)) && norm(e.name).length > 4)
    || null;
}

export function placeOf(step, entities) {
  if (step.lat && step.lng) return { name: step.place || step.title, lat: step.lat, lng: step.lng };
  const key = norm(step.place);
  if (PLACES[key]) return PLACES[key];
  const e = findEntity(entities, step.place);
  if (e?.location?.latitude) return { name: e.name, lat: e.location.latitude, lng: e.location.longitude, entity: e };
  return null;
}

// Temps de marche estimé (distance à vol d'oiseau x 1,4, 4 km/h).
export function walkMin(a, b) {
  if (!a || !b) return 0;
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  const meters = 2 * R * Math.asin(Math.sqrt(h)) * 1.4;
  return Math.round(meters / 67);
}

// ---------- État partagé de la famille ----------
// L'état est reconstruit en rejouant les messages du canal « -etat » (ntfy garde 12 à 24 h).
export function emptyState() {
  return { steps: {}, delay: 0, order: null, rules: {}, alerts: {}, day: null };
}

export function applyAction(state, a, today) {
  if (!a || typeof a !== 'object') return state;
  if (a.day && today && a.day !== today) return state; // on ignore les actions d'un autre jour
  switch (a.k) {
    case 'step': state.steps[a.id] = a.status; if (!a.status) delete state.steps[a.id]; break;
    case 'delay': state.delay = Number(a.v) || 0; break;
    case 'order': state.order = Array.isArray(a.ids) ? a.ids : null; break;
    case 'rule': if (a.rule?.id) state.rules[a.rule.id] = a.rule; break;
    case 'unrule': delete state.rules[a.id]; break;
    case 'alert': state.alerts[a.key] = { t: a.t, title: a.title, message: a.message }; break;
    case 'reset': { const alerts = state.alerts; Object.assign(state, emptyState(), { alerts }); break; }
    default: break;
  }
  return state;
}

export function stateFromMessages(messages, today) {
  const s = emptyState();
  for (const m of messages) {
    try { applyAction(s, JSON.parse(m.message), today); } catch { /* message illisible : ignoré */ }
  }
  return s;
}

// ---------- Planning recalculé ----------
export function orderedSteps(plan, state) {
  const steps = plan.steps || [];
  if (!state.order) return steps;
  const map = new Map(steps.map((s) => [s.id, s]));
  const out = state.order.map((id) => map.get(id)).filter(Boolean);
  for (const s of steps) if (!state.order.includes(s.id)) out.push(s);
  return out;
}

export function computeSchedule(plan, state, entities = []) {
  let cursor = null;
  let prevPlace = null;
  return orderedSteps(plan, state).map((step) => {
    const status = state.steps[step.id] || 'todo';
    const planned = toMin(step.start);
    const duration = Number(step.duration) || 30;
    const place = placeOf(step, entities);
    let start = planned;
    if (status === 'todo') {
      if (step.fixed) start = planned;
      else {
        start = planned != null ? planned + (state.delay || 0) : cursor;
        if (cursor != null && (start == null || start < cursor)) start = cursor;
      }
      const end = (start ?? 0) + duration;
      cursor = end;
      if (place && prevPlace) cursor += 0; // la durée de l'étape inclut la marche
    }
    const walk = place && prevPlace ? walkMin(prevPlace, place) : 0;
    if (place) prevPlace = place;
    return { ...step, status, start, end: start != null ? start + duration : null, duration, place, walk };
  });
}

// ---------- Règles d'alerte ----------
// Types : wait (attente <= max), time (heure fixe), show (spectacle qui commence bientôt),
// plus les rappels automatiques d'étape (settings.stepReminderMin).
export function allRules(plan, state) {
  const rules = [...(plan.rules || [])];
  for (const s of plan.steps || []) {
    if (s.alert && s.place) {
      rules.push({
        id: `step-${s.id}`, kind: 'wait', ride: s.alert.ride || s.place, max: s.alert.max, queue: s.alert.queue,
        from: s.alert.from, to: s.alert.to, stepId: s.id, title: s.alert.title, message: s.alert.message,
      });
    }
  }
  for (const r of Object.values(state.rules || {})) rules.push(r);
  return rules;
}

export function liveIndex(live) {
  const idx = new Map();
  for (const x of live || []) idx.set(x.id, x);
  return idx;
}

export function waitOf(liveItem, queue = 'STANDBY') {
  if (!liveItem || liveItem.status !== 'OPERATING') return null;
  const w = liveItem.queue?.[queue]?.waitTime;
  return typeof w === 'number' ? w : null;
}

function inWindow(rule, min) {
  const from = toMin(rule.from), to = toMin(rule.to);
  if (from != null && min < from) return false;
  if (to != null && min > to) return false;
  return true;
}

// Renvoie les conditions remplies maintenant. `key` sert à n'envoyer chaque alerte qu'une fois.
export function evaluate({ plan, state, entities, live, now }) {
  const out = [];
  const idx = liveIndex(live);
  const schedule = computeSchedule(plan, state, entities);

  for (const r of allRules(plan, state)) {
    if (r.stepId && state.steps[r.stepId]) continue; // étape déjà faite ou passée
    if (r.kind === 'wait') {
      if (!inWindow(r, now.min)) continue;
      const e = findEntity(entities, r.ride);
      const w = waitOf(idx.get(e?.id), r.queue || 'STANDBY');
      if (e && w != null && w <= Number(r.max)) {
        const sr = r.queue === 'SINGLE_RIDER' ? ' en Single Rider' : '';
        out.push({
          key: `w|${r.id}|${now.date}`, rule: r, entity: e, wait: w, kind: 'wait',
          title: r.title ? `${r.title} (${w} min)` : `${e.name} : ${w} min${sr}`,
          message: r.message || `Seulement ${w} min d'attente${sr} (seuil : ${r.max} min). C'est le moment d'y aller !`,
        });
      }
    } else if (r.kind === 'time') {
      const at = toMin(r.at);
      if (at != null && now.min >= at && now.min < at + (Number(r.span) || 20)) {
        out.push({ key: `t|${r.id}|${now.date}`, rule: r, kind: 'time', title: r.title || `Il est ${fmt(at)}`, message: r.message || '' });
      }
    } else if (r.kind === 'show') {
      const e = findEntity(entities, r.show);
      const times = (idx.get(e?.id)?.showtimes || []).map((t) => isoToParisMin(t.startTime)).filter((m) => m > now.min);
      const next = times.sort((a, b) => a - b)[0];
      const before = Number(r.before) || 20;
      if (e && next != null && next - now.min <= before && inWindow(r, now.min)) {
        out.push({
          key: `s|${r.id}|${now.date}|${next}`, rule: r, entity: e, kind: 'show',
          title: r.title || `${e.name} à ${fmt(next)}`,
          message: r.message || `Le spectacle commence dans ${next - now.min} min. Pars maintenant pour être bien placé.`,
        });
      }
    }
  }

  const reminder = Number(plan.settings?.stepReminderMin);
  if (reminder > 0) {
    for (const s of schedule) {
      if (s.status !== 'todo' || s.start == null) continue;
      const until = s.start - now.min;
      if (until <= reminder && until > -5) {
        out.push({
          key: `r|${s.id}|${now.date}|${s.start}`, kind: 'step', step: s,
          title: `${fmt(s.start)} · ${s.title}`,
          message: [s.place?.name, s.note].filter(Boolean).join(' — '),
        });
      }
    }
  }
  return out;
}

// ---------- ntfy (notifications + canal partagé, sans compte) ----------
export async function ntfyPublish(topic, { message, title, tags, priority, click }) {
  const body = { topic, message: message || ' ' };
  if (title) body.title = title;
  if (tags) body.tags = tags;
  if (priority) body.priority = priority;
  if (click) body.click = click;
  const r = await fetch(NTFY, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
  return r.json();
}

export async function ntfyPoll(topic, since = '24h') {
  const r = await fetch(`${NTFY}/${encodeURIComponent(topic)}/json?poll=1&since=${since}`);
  if (!r.ok) throw new Error(`ntfy ${r.status}`);
  const text = await r.text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === 'message');
}

export const topics = (base) => ({ alerts: base, state: `${base}-etat`, pos: `${base}-pos` });

// ---------- Données du parc ----------
export async function fetchEntities() {
  const r = await fetch(`${API}/entity/${DESTINATION_ID}/children`);
  if (!r.ok) throw new Error(`themeparks ${r.status}`);
  return (await r.json()).children;
}
export async function fetchLive() {
  const r = await fetch(`${API}/entity/${DESTINATION_ID}/live`);
  if (!r.ok) throw new Error(`themeparks ${r.status}`);
  return (await r.json()).liveData;
}
export async function fetchSchedule(parkId) {
  const r = await fetch(`${API}/entity/${parkId}/schedule`);
  if (!r.ok) throw new Error(`themeparks ${r.status}`);
  return (await r.json()).schedule;
}
