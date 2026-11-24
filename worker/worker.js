// Veilleur Cloudflare : toutes les minutes, vérifie les conditions du guide
// et envoie une notification ntfy, même quand tous les téléphones sont en veille.
import * as C from '../js/core.js';

async function tick(env) {
  const topic = env.FAMILY_CODE;
  if (!topic) return { configured: false, help: 'Ajoute le secret FAMILY_CODE (code famille de l\'onglet Famille).' };
  const T = C.topics(topic);
  const now = C.parisNow();
  const [plan, entities, live, stateMsgs] = await Promise.all([
    fetch(new URL('plan.json', env.SITE_URL), { cf: { cacheTtl: 60 } }).then((r) => r.json()),
    C.fetchEntities(), C.fetchLive(), C.ntfyPoll(T.state, '24h', env.NTFY_TOKEN),
  ]);
  const state = C.stateFromMessages(stateMsgs, now.date);
  if (!state.watch) return { at: C.fmt(now.min), watch: false, sent: [] }; // alertes en pause (pas au parc)
  const hits = C.evaluate({ plan, state, entities, live, now });
  const sent = [];
  for (const h of hits) {
    if (state.alerts[h.key]) continue; // déjà envoyée (par le veilleur ou par un téléphone)
    await C.ntfyPublish(T.state, { message: JSON.stringify({ k: 'alert', key: h.key, t: Date.now(), title: h.title, message: h.message, day: now.date, by: 'veilleur' }) }, env.NTFY_TOKEN);
    await C.ntfyPublish(T.alerts, {
      title: h.title, message: h.message, priority: h.kind === 'wait' ? 4 : 3,
      tags: [h.kind === 'wait' ? 'stopwatch' : h.kind === 'show' ? 'sparkles' : 'round_pushpin'],
      click: env.SITE_URL,
    }, env.NTFY_TOKEN);
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
