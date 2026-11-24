# Notre journée magique — Disneyland Paris

Application web (à installer sur l'écran d'accueil du téléphone) qui suit notre journée au parc :

- **Maintenant** : l'étape en cours, qui y va, les boutons *Fait / Passer*, « En retard ? +15 / +30 / +60 », et les conditions du guide remplies en ce moment.
- **Journée** : le programme complet, recalculé et partagé en direct avec toute la famille.
- **Carte** : l'itinéraire numéroté, les temps d'attente sur chaque attraction et la position de la famille.
- **Attentes** : temps d'attente en direct des 2 parcs, Single Rider, Premier Access, spectacles ; 🔔 pour être prévenu.
- **Famille** : qui est qui, lien d'invitation, notifications, partage de position, mode démo.

## Comment ça marche

| Brique | Rôle | Compte nécessaire |
|---|---|---|
| GitHub Pages | Héberge l'application | GitHub (déjà fait) |
| themeparks.wiki | Temps d'attente, horaires, spectacles, coordonnées GPS | Aucun |
| ntfy.sh | Notifications sur le téléphone + synchronisation de la famille | Aucun (appli gratuite) |
| Cloudflare Worker (`worker/`) | Vérifie le guide chaque minute, même téléphones en veille | Cloudflare gratuit |

Le **code famille** (canal ntfy) n'est jamais dans ce dépôt : il est créé sur le premier téléphone et partagé par le lien d'invitation (onglet Famille).

## Modifier le programme et les alertes

Tout est dans `plan.json` :

- `steps` : les étapes (`start` heure prévue, `duration` en minutes, `place` nom d'attraction/restaurant ou `entree`, `gare`, `chateau`, `disney village`, `fixed: true` pour une réservation à heure fixe, `alert: {max, from, to}` pour être prévenu quand l'attente passe sous `max`).
- `rules` : alertes libres — `{"kind": "wait", "ride": "Big Thunder Mountain", "max": 20, "from": "10:00", "to": "18:00"}`, `{"kind": "time", "at": "12:15", "title": "...", "message": "..."}`, `{"kind": "show", "show": "nom du spectacle", "before": 20}`.
- `settings.stepReminderMin` : rappel N minutes avant chaque étape.

## Mettre en route le veilleur (notifications téléphone en veille)

1. Créer un compte gratuit sur cloudflare.com.
2. Sur un ordinateur avec Node.js : `cd worker`, `npx wrangler login`, `npx wrangler secret put FAMILY_CODE` (coller le code famille affiché dans l'onglet Famille), puis `npx wrangler deploy`.
3. Ouvrir l'adresse du veilleur affichée : elle doit répondre `{"at": "...", "sent": [...]}`.

Application personnelle, sans lien avec The Walt Disney Company.
