# Journal

<!-- Dernière entrée en haut. Une entrée par session de travail ou par décision. Date au format AAAA-MM-JJ. -->

## 2026-10-09
- Demande : abandonner l'ancien nom du projet. Alimy a d'abord été validé, puis écarté quand il est apparu que l'application web s'appelait déjà Prandia depuis le 2026-08-12 (commit c864b12). Décision finale : Prandia partout.
- Le dossier de travail avait 76 commits de retard sur origin/main (dernier fetch le 2026-08-09). Le travail local non commité (lecteur de code-barres et styles, environ 370 lignes, absent d'origin/main) est conservé sur la branche locale `sauvegarde-avant-alimy`, avec un premier renommage obsolète dans un second commit. Il n'a pas été réappliqué : il chevauche du code réécrit sur l'autre machine, à reprendre à la main si besoin. `main` a été avancé en fast-forward sur origin/main.
- Renommage sur la version à jour : interface desktop et web, documentation, scripts, paquets (`prandia`, `@prandia/*`), variables d'environnement `PRANDIA_*`, base locale `prandia.db`, spec `prandia.spec`, User-Agent, clé de stockage du navigateur. Les scripts désignent la base D1 par son binding `DB` et non plus par son nom. Données locales déplacées : `~/.prandia`, réglages Qt copiés dans la clé de registre `prandia` (ancienne clé supprimée après comparaison valeur par valeur), sauvegarde préalable dans le dossier temporaire de la session.
- Cloudflare : nouvelle base D1 `prandia` (id b8a05209-f6d0-4cbb-84e8-2fea44cf7e87) avec les 17 migrations, nouveau bucket R2 `prandia-media` en juridiction UE (l'ancien était vide), `wrangler.toml` mis à jour. L'ancien projet Pages, l'ancienne base et l'ancien bucket sont intacts et servent toujours la production. Aucun secret Pages n'était défini.
- Copie des données de production vers la nouvelle base, par un script rejouable qui relit ensuite la nouvelle base et la compare ligne à ligne : le premier chargement a été refusé par D1 (clé étrangère, ordre alphabétique des tables) et annulé en bloc ; le second, parents avant enfants, est passé mais la comparaison a révélé des retours chariot ajoutés dans les textes multilignes (défaut d'écriture du script sous Windows), corrigé ensuite. Le script doit de toute façon être rejoué juste avant l'ouverture, pour reprendre les écritures faites entre-temps sur l'ancien site.
- Décision : l'`id` de la fiche reste inchangé (règle du catalogue, il ne change jamais).
- Vérifié : tests Python verts (5 ignorés), 477 tests TypeScript verts, typecheck, build web (manifeste et titre Prandia), démarrage de l'app desktop avec les nouveaux chemins. Le venv, incomplet depuis son changement de machine, a été réparé.
- Reste à faire : le compte GitHub connecté sur cette machine (mamalric) n'a que la lecture sur le dépôt de MarckuusS, donc rien n'a été poussé ni renommé. À faire avec le compte propriétaire : renommer le dépôt en `prandia`, pousser le commit de renommage, créer le projet Pages `prandia` (build `npm install && npm run build --workspace @prandia/web`, sortie `web/dist`), rejouer la copie des données juste avant l'ouverture, réinstaller la PWA sur l'iPhone, supprimer les anciennes ressources Cloudflare, renommer le dossier du projet.

## 2026-09-09
- Fiche modifiée depuis le gestionnaire : site.
- Fiche modifiée depuis le gestionnaire : statut (statut : actif vers pause).

## 2026-08-18
- Fiche créée à partir du modèle `application` lors de la mise en place du catalogue. Projet existant depuis le 2026-04-29, dernière activité observée le 2026-08-12.
- Sections de la fiche rédigées par Claude Code d'après FICHE.md, JOURNAL.md, CLAUDE.md, README.md, architecture.md (confiance haute). À relire.
