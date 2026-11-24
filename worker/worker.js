// Veilleur Cloudflare : toutes les minutes, vérifie les conditions du guide
// et envoie une notification ntfy, même quand tous les téléphones sont en veille.
import * as C from '../js/core.js';

async function tick(env) {
  const topic = env.FAMILY_CODE;
  if (!topic) throw new Error('Variable FAMILY_CODE manquante');
  const T = C.topics(topic);
  const now = C.parisNow();
  const [plan, entities, live, stateMsgs] = await Promise.all([
    fetch(new URL('plan.json', env.SITE_URL), { cf: { cacheTtl: 60 } }).then((r) => r.json()),
    C.fetchEntities(), C.fetchLive(), C.ntfyPoll(T.state),
  ]);
  const state = C.stateFromMessages(stateMsgs, now.date);
  const hits = C.evaluate({ plan, state, entities, live, now });
  const sent = [];
  for (const h of hits) {
    if (state.alerts[h.key]) continue; // déjà envoyée (par le veilleur ou par un téléphone)
    await C.ntfyPublish(T.state, { message: JSON.stringify({ k: 'alert', key: h.key, t: Date.now(), title: h.title, message: h.message, day: now.date, by: 'veilleur' }) });
    await C.ntfyPublish(T.alerts, {
      title: h.title, message: h.message, priority: h.kind === 'wait' ? 4 : 3,
      tags: [h.kind === 'wait' ? 'stopwatch' : h.kind === 'show' ? 'sparkles' : 'round_pushpin'],
      click: env.SITE_URL,
    });
    sent.push(h.title);
  }
  return { at: C.fmt(now.min), checked: hits.length, sent };
}

export default {
  async scheduled(_event, env, ctx) { ctx.waitUntil(tick(env)); },
  // Ouvrir l'adresse du veilleur dans un navigateur lance une vérification (utile pour tester).
  async fetch(_req, env) {
    try { return Response.json(await tick(env)); } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
  },
};
