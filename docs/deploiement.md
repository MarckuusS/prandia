# Déploiement

Le front est servi par **Cloudflare Pages**, l'API par un **Worker** sur `/api/*`,
les données vivent dans **D1**, les photos et tickets dans **R2**.

Production : https://prandia.pages.dev

---

## 1. Le front (Cloudflare Pages)

À faire **une seule fois**, dans le tableau de bord Cloudflare →
*Workers & Pages* → projet `prandia` → *Settings* → *Builds & deployments*.

Connecter le dépôt GitHub `MarckuusS/prandia`, branche de production `main`,
puis renseigner :

| Réglage | Valeur |
|---|---|
| Framework preset | `None` |
| Build command | `npm install && npm run build --workspace @prandia/web` |
| Build output directory | `web/dist` |
| Root directory | *(laisser vide — la racine du dépôt)* |

La version de Node est lue dans `.node-version` à la racine (22). Sans ce
fichier, Pages utilise une version ancienne sur laquelle Vite 6 refuse de
démarrer.

Ensuite, **chaque push sur `main` déclenche une construction et un déploiement**.
Aucun identifiant Cloudflare n'est nécessaire en local — ce qui est le
comportement voulu pour un dépôt public.

### Pourquoi `web/public/_redirects` est indispensable

L'application utilise de vraies URL (`/courses`, `/recettes`). Sans ce fichier,
ouvrir directement `https://…/courses` renvoie un 404 : Pages y cherche un
fichier qui n'existe pas. La règle `/* /index.html 200` sert `index.html` en
conservant l'URL, et le routeur prend le relais côté client.

La règle `/api/*` placée **avant** est tout aussi importante : sans elle, un
appel d'API sur un chemin inconnu renverrait `index.html` avec un code 200, et
le client planterait en essayant de parser du HTML comme du JSON.

---

## 2. L'API — une Pages Function, pas un Worker séparé

L'API n'est **pas** déployée à part. Le build produit `web/dist/_worker.js`, que
Pages exécute devant chaque requête : il traite `/api/*` et délègue le reste aux
fichiers statiques.

Ce n'est pas un détail d'implémentation, c'est une contrainte : une route Worker
du type `prandia.pages.dev/api/*` est **impossible**, car les routes
Worker exigent un domaine qu'on possède — et `pages.dev` appartient à
Cloudflare. Sans domaine personnalisé, l'API doit être livrée *avec* le site.

Conséquence pratique : `wrangler deploy` n'est jamais utilisé. Un `git push`
suffit.

### Créer la base, une seule fois

```bash
npx wrangler login
npx wrangler d1 create prandia
```

La commande affiche un `database_id` à reporter dans `wrangler.toml`. Ce n'est
**pas** un secret : il n'autorise rien sans les identifiants du compte, et peut
donc vivre dans un dépôt public. Les liaisons déclarées dans `wrangler.toml`
sont lues par Pages au déploiement — rien à saisir dans le tableau de bord.

### Charger le schéma et les données

```bash
npm run db:migrate:remote     # tables, index FTS5, tags, comptes
npm run db:export             # relit le SQLite local -> scripts/_dump/d1-seed.sql
npm run db:load:remote        # charge les données dans D1
```

Le dump est émis en `INSERT` multi-lignes par lots de 100. Une instruction par
ligne dépassait les limites de taille de requête de `wrangler`.

### R2 — pas encore fait

Le bucket des photos de recettes reste à créer :

```bash
npx wrangler r2 bucket create prandia-media --jurisdiction eu
npx wrangler r2 object put prandia-media/recipes/6.jpg   --file="$HOME/.prandia/recipe_photos/6.jpg" --jurisdiction eu
```

⚠️ Le jeton `wrangler` actuel n'a **pas** la portée `r2`. Il faudra relancer
`wrangler login` et l'autoriser avant que ces commandes fonctionnent. La
liaison correspondante est commentée dans `wrangler.toml`.

---

## 3. « Le site n'a pas changé » — la version affichée sur l'appareil

Le déploiement peut être terminé et l'appareil montrer encore l'ancienne
version. Ce sont deux choses différentes, à diagnostiquer séparément.

**Ce que le serveur envoie** — sans ambiguïté possible, le numéro du commit est
compilé dans le bundle :

```bash
curl -s https://prandia.pages.dev/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

**Ce que l'appareil exécute** : **Paramètres → Application → Version**. C'est le
même numéro de commit. S'il diffère de celui du dépôt, la page tourne sur une
copie en cache, et le déploiement n'y est pour rien.

### Pourquoi ça arrivait

`vite-plugin-pwa` injecte un script de chargement qui se contente
d'enregistrer le service worker. Avec `skipWaiting`, le nouveau worker prend
bien la main sur le cache — mais la page déjà ouverte continue d'exécuter le
JavaScript qu'elle a chargé la veille, et rien ne la recharge.

Sur un navigateur de bureau le défaut se corrige seul à la visite suivante. Sur
une PWA installée sur iPhone, non : iOS ne ferme jamais l'application, il la
suspend. Il n'y a donc pas de visite suivante, et l'écran peut rester
plusieurs jours en arrière.

`web/src/lib/appUpdate.ts` comble le trou : vérification d'une nouvelle version
à chaque passage au premier plan et à chaque mise en arrière-plan, puis
rechargement **quand la page n'est pas sous les yeux de l'utilisateur** — jamais
pendant la frappe, le tampon d'édition d'une recette ne vivant qu'en mémoire.

### Forcer la mise à jour maintenant

Le correctif ne peut pas sauver une page déjà bloquée : c'est l'ancien code qui
tourne, et il ne contient pas encore la surveillance. Une fois, à la main :

- **PWA installée sur iPhone** : fermer l'application depuis le sélecteur
  d'applications (glisser vers le haut), puis la rouvrir. Si elle résiste, la
  retirer de l'écran d'accueil et la réinstaller depuis Safari.
- **Navigateur** : rechargement forcé, `Ctrl+Shift+R` (`Cmd+Shift+R` sur Mac).

---

## 4. Vérifier

```bash
curl https://prandia.pages.dev/api/health
```

Ou, depuis l'application, l'écran **Diagnostic** (bouton `⋯` en haut à droite) :
il affiche la version déployée, la joignabilité de l'API, l'état de la base et
le nombre d'ingrédients.

---

## 5. Installer sur l'iPhone

Ouvrir https://prandia.pages.dev dans **Safari** (Chrome iOS ne sait pas
installer de PWA), puis *Partager* → **Sur l'écran d'accueil**.

L'application se lance alors en plein écran, sans barre d'adresse. L'écran
Diagnostic indique « installée sur l'écran d'accueil » quand c'est bien le cas.

---

## 6. Les notifications

Deux pièces, et seule la première part avec le push sur `main`.

L'API (abonnement d'un appareil, préférences, bouton "Envoyer un test") est dans la Pages Function, comme le reste.

La planification est un Worker à part, `prandia-notifier`, sans route : son horloge, un Durable Object, se réveille toutes les cinq minutes par une alarme, lit la base `prandia` et envoie les rappels dus. Pas de déclencheur horaire (cron) : le plan gratuit en accorde cinq au compte entier, et d'autres projets les occupent. Il se déploie à la main, après chaque modification de `worker/src/notifier.ts`, `worker/src/push.ts` ou `shared/src/notifications.ts`, et avant le site la toute première fois, car le site se lie à son horloge :

```bash
npx wrangler deploy --config notifier/wrangler.toml
```

L'horloge démarre à la première ouverture de l'écran Notifications, et se relance d'elle-même à la visite suivante si elle s'est arrêtée.

La clé privée VAPID est un secret, posé une fois de chaque côté, jamais écrit dans le dépôt :

```bash
npx wrangler pages secret put VAPID_PRIVATE_KEY --project-name prandia
```

```bash
npx wrangler secret put VAPID_PRIVATE_KEY --config notifier/wrangler.toml
```

La clé publique correspondante est dans `wrangler.toml` et dans `notifier/wrangler.toml`, identique dans les deux. Changer de paire de clés désabonne tous les appareils sans les prévenir : chacun devra retoucher "Activer les notifications".

Pour lire ce que fait le planificateur en direct :

```bash
npx wrangler tail prandia-notifier
```

## 7. La lecture des étiquettes (bouton Scanner)

Le bouton Scanner (date, prix, quantité) envoie une photo recadrée à la Pages Function, qui la fait lire par Claude Haiku 5.5. La clé est un secret du projet Pages, jamais écrite dans le dépôt, qui est public :

```bash
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name prandia
```

Un secret ne s'applique qu'aux déploiements suivants : après l'avoir posé, il faut redéployer (un nouveau push sur `main`, ou "Retry deployment" dans le tableau de bord). Sans clé, le bouton répond que la lecture n'est pas configurée, et rien d'autre ne change.

La clé vient d'un espace de travail "Prandia" de la Console Anthropic, avec un plafond de dépense mensuel : c'est le vrai garde-fou des crédits. Le serveur ajoute le sien, 150 lectures par jour et par cuisine. Une lecture coûte environ 500 tokens d'image, soit quelques centièmes de centime.

---

## Avant chaque mise en production

```bash
npm run test         # domaine partagé
npm run typecheck    # TypeScript strict
npm run db:verify    # fidélité de la migration des données
```

## Authentification

Plusieurs identifiants, **une seule cuisine**. Chacun son compte et son mot de
passe, révocable indépendamment — mais les recettes, le frigo, le planning et
la liste de courses sont communs.

Ce choix n'est pas qu'une simplification : comme aucune donnée n'appartient à
personne en particulier, **il n'existe aucune requête où l'on puisse oublier un
`AND user_id = ?` et fuiter les données de l'autre**. SQLite n'ayant pas de
Row-Level Security, cette garantie ne viendrait de nulle part ailleurs.

### Créer un compte

```bash
node scripts/add-user.mjs marius "Marius"
```

Le script demande le mot de passe de façon masquée, calcule son empreinte **en
local**, puis applique directement en production. Le mot de passe ne transite
par aucun réseau et n'apparaît dans aucun historique de commandes.

| Option | Effet |
|---|---|
| *(aucune)* | applique sur la production |
| `--local` | applique sur la base de développement |
| `--print` | affiche seulement le SQL, sans rien appliquer |

La même commande, rejouée sur un identifiant existant, **change son mot de
passe**.

Note d'implémentation : le SQL est passé à `wrangler` par un fichier
temporaire, et wrangler est appelé via son entrée JavaScript plutôt que par
`npx`. Une requête contenant apostrophes et espaces passée en argument se fait
réinterpréter par le shell — c'est ce qui cassait la version précédente, qui
demandait un copier-coller manuel.

### Comment ça marche

| | |
|---|---|
| Stockage du mot de passe | PBKDF2-SHA256, 210 000 itérations, sel unique par compte |
| Cookie de session | `userId.expiration.signature` en HMAC-SHA256, valable 90 jours |
| Attributs du cookie | `HttpOnly`, `Secure`, `SameSite=Strict` |
| Secret de signature | généré au hasard à la première utilisation, rangé dans `app_setting` |
| Limitation | 10 échecs → 15 minutes de blocage |

PBKDF2 pour **stocker**, HMAC pour **signer** : ce ne sont pas les mêmes
besoins. Signer doit être rapide ; stocker doit être lent, pour qu'une fuite de
la table `user` ne se casse pas à des milliards d'essais par seconde. Le détail
est en tête de [`shared/src/password.ts`](../shared/src/password.ts) et de
[`worker/src/auth.ts`](../worker/src/auth.ts).

### Journal d'activité

Chaque ajout, modification et suppression est enregistré avec son auteur,
consultable dans l'application via le bouton `⋯`.

Une table dédiée plutôt que des colonnes `created_by` / `updated_by` : celles-ci
disparaissent avec la ligne qu'elles décrivent, or c'est précisément la
suppression qu'on veut pouvoir expliquer trois jours plus tard. Le libellé est
figé au moment de l'action — « a supprimé Chili con carne » reste lisible même
quand la recette n'existe plus.

### Déverrouiller après trop de tentatives

```bash
npx wrangler d1 execute DB --remote   --command "DELETE FROM app_setting WHERE key='auth.failures'"
```

### Déconnecter tout le monde immédiatement

```bash
npx wrangler d1 execute DB --remote   --command "DELETE FROM app_setting WHERE key='auth.session_secret'"
```

Un nouveau secret sera généré au prochain appel : toutes les sessions ouvertes
deviennent invalides, sur tous les appareils.

### Désactiver un compte sans effacer son historique

```bash
npx wrangler d1 execute DB --remote   --command "UPDATE user SET is_active = 0 WHERE username = 'invite'"
```

L'effet est immédiat — le compte est relu en base à chaque requête, sans
attendre l'expiration de son cookie. Le journal, lui, conserve ses actions.

### Pourquoi pas Cloudflare Access

Access a été utilisé en premier et protégeait mieux — il refusait la requête
avant même d'atteindre notre code. Mais sa page de connexion vit sur une autre
origine, et un `fetch()` ne peut pas lire une réponse issue d'une redirection
cross-origin : l'API devenait « injoignable » dès que la session expirait, sans
qu'on puisse le distinguer d'une panne de réseau. Inutilisable dans une PWA
installée.

Le compromis est assumé : cette vérification s'exécute *dans* le Worker, donc
un bug ici ouvre la porte, là où Access rendait cela impossible.

---

## Sécurité

Le dépôt est **public**. Trois règles :

- aucun secret dans `wrangler.toml` — utiliser `npx wrangler secret put <NOM>`,
  et `.dev.vars` en local (git-ignoré) ;
- aucune adresse mail dans le code — OpenFoodFacts accepte l'URL du projet
  comme moyen de contact dans le `User-Agent` ;
- aucune donnée personnelle — la base locale, les dumps `scripts/_dump/` et les
  tickets de caisse sont git-ignorés.
