# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project direction (decided 2026-08-01) — pivot to web / PWA

> **Read this before anything else.** The project is changing target. Most of the document below still
> describes the *current* desktop app, which is accurate but no longer the destination.

The app is being ported to a **web front-end deployed as an installable PWA** (iOS "Add to Home
Screen"), backed by **Cloudflare** (Pages + Workers + D1 + R2), so that recipes, ingredients, meal
plans and the pantry are reachable from a phone and **synced between phone and desktop**.

Consequences:

- The **PySide6/QML desktop app is slated for retirement**. It stays the reference implementation and
  the only usable client until the web app reaches feature parity on what is actually used — then it
  is removed. Do not invest in new QML features unless explicitly asked; port instead.
- `app/domain/` (Pydantic models, nutrition, pricing, units, shopping) and the SQLite schema are the
  parts meant to survive. `app/ui/` is not portable and will be rewritten for the web.
- **Cloudflare D1 is SQLite**, so the schema, the FTS5 virtual table and the triggers port over
  essentially unchanged. Keep that in mind before proposing anything Postgres-flavoured.
- **The project is named Prandia** (Latin *prandium*, the meal). The web app took the name on
  2026-08-12; on 2026-10-09 the repo, npm scope (`@prandia/*`), env vars (`PRANDIA_*`), local DB
  (`prandia.db`), data dir (`~/.prandia/`) and the Cloudflare resources followed. The former name
  must not reappear in new code or docs. Only the project folder and the `id` in `FICHE.md` (which
  never changes) still carry it.

## Stack & key choices

- Python 3.11+, PySide6 (Qt 6) for UI — **QtQuick Controls 2 / QML**. The QtWidgets MVP was migrated to QML in May 2026; only `QApplication` from QtWidgets remains, used as the bootstrap shell.
- The default style **`Basic`** is forced at startup via `QQuickStyle.setStyle("Basic")`. The native `FluentWinUI3` style on Windows refuses customization of `background` / `indicator` / `contentItem`, which would defeat the whole `Theme.qml` design system.
- SQLAlchemy 2.x + SQLite. The DB uses **WAL mode + FTS5** (virtual table `ingredient_fts`) for ingredient search. Do not remove FTS5 from the init script — the dynamic-suggestion widget depends on it.
- Pydantic v2 — all domain models live in `app/domain/models.py` and are the source of truth. ORM rows are mapped to/from Pydantic at the repository boundary. QML never sees Pydantic objects directly: `QAbstractListModel` exposes them via roles, and slots return `QVariantMap` (Python `dict`) for detail views.
- `httpx` (sync) for OpenFoodFacts. API base URL: `https://world.openfoodfacts.org`. No auth needed.
- ~~**No Electron, no WebView, no Tauri.** Native Qt only — this is a hard rule from the project's design.~~
  **Repealed on 2026-08-01.** The rule existed to keep the *desktop* app native, and it did its job.
  It no longer applies: the project is moving to a web front-end (see "Project direction" above).
  Web technologies are now the target stack, not a forbidden one. The rule that replaces it is
  narrower: **no desktop wrapper** — no Electron/Tauri shell around the web app. On desktop the app
  is simply opened in the browser (and installable from there if wanted).

## Jeu d'icônes (web) — `web/src/icons/`

L'application web n'utilise **plus d'émoji**. 67 icônes les remplacent : **10 rayons** et
57 d'interface. Règles complètes : `web/src/icons/README.md`. Les points qui ne se devinent pas :

- **Les dessins viennent de [Lucide](https://lucide.dev)** (0.469.0, ISC + MIT) **et de
  [Tabler](https://tabler.io/icons)** (3.31.0, MIT), versions figées. Les deux fichiers
  `LICENSE-*.txt` sont à conserver — le dépôt est public. Dans `MAP`, un nom préfixé `tabler:`
  va chercher chez Tabler : Lucide n'a pas tout, son `milk` est une bouteille quand le lait
  s'achète en brique.
- **`paths/ui.ts` et `paths/rayons.ts` sont GÉNÉRÉS.** Ne pas éditer à la main : ajouter la ligne
  dans `MAP` (`scripts/import-lucide.mjs`) puis relancer le script, qui récupère, filtre et réécrit.
- **`paths/overrides.ts` ne l'est pas** : c'est là que vivent les dessins maison, fusionnés **en
  dernier** dans `registry.ts` donc prioritaires. Deux tests protègent le mécanisme. **Une seule
  entrée**, le pot de yaourt à opercule, qu'aucun des deux jeux n'a. Avant d'en ajouter une
  autre, chercher chez Tabler : un dessin qu'on n'a pas à maintenir vaut mieux qu'un dessin
  qu'on maintient mal.
- Pas de dépendance `lucide-react` : le paquet laisse chaque icône poser ses propres attributs, ce
  que `Icon.tsx` interdit. On prend les chemins, on garde le cadre — c'est ce qui permet de rendre
  à 1,6 d'épaisseur ce que Lucide publie à 2.
- Une icône ne porte **jamais** de couleur littérale, seulement `none` ou `currentColor`. Un test
  échoue sinon : une couleur en dur raterait la teinte du rayon et le thème sombre.
- **Les 8 nutriments ont leurs icônes dans ce jeu**, plus de PNG. Une image ne se teinte pas, ne
  suit pas le thème sombre et se pixellise à l'agrandissement. Chacune est posée sur une **pastille pâle** et porte l'**encre** de son nutriment, jamais sa teinte. Les deux sous-lignes gardent le lien familial par leur dessin mais ont leur propre couleur : dérivées du parent, leurs pastilles calculaient la même valeur au pixel près. L'énergie porte l'olive de l'application. Le desktop QML garde ses
  propres PNG sous `app/ui/qml/components/icons/nutrient/` : ne pas les supprimer avec.
- **Il n'y a pas d'icône par aliment, et c'est délibéré.** Un ingrédient porte l'icône de son
  rayon (`category_l1`), donnée qu'il a déjà.
- L'ordre compte dans `RAYON_RULES` (`resolve.ts`), contrairement au reste du projet : la première
  règle qui accroche gagne. Deux paires en dépendent, couvertes par un test (`surgelés` avant
  `légumes`, `fruits de mer` avant `fruits`).
- Chaque rayon doit avoir sa teinte dans `styles/icons.css`, sous les deux thèmes. Test dédié.
- **Rayons et icônes éditables** : `category_definition` (nom, icône, couleur) et `custom_icon`
  (SVG collé). Un SVG collé est assaini par `shared/src/svg.ts` — **liste blanche**, 22 tests
  d'attaque — et c'est le **serveur** qui fait foi, jamais le navigateur.
- `node scripts/export-icons.mjs` régénère `docs/icones/` (SVG autonomes + galerie).

## Ligne visuelle (web) — `web/src/styles/theme.css`

L'interface suit un mockup adopté le 2026-08-12. Ce qui ne se devine pas :

- **Deux polices, deux rôles.** Instrument Sans porte ce qui se **lit**, Bricolage Grotesque
  ce qui s'**annonce** — titres d'écran, titres de section, grands chiffres (classe `.chiffre`).
  Bricolage dans un paragraphe lui fait perdre son caractère. Les deux sont **servies par
  l'application** (`@fontsource-variable/*`, licence OFL, importées dans `main.tsx`), jamais par
  un hôte distant : l'app doit s'ouvrir dans un magasin sans réseau.
- **Le tricolore macro a DEUX familles de jetons, et c'est le piège.** `--color-nutrient-X`
  est calibré pour des **surfaces** (barre, arc, fond de pastille) ; `--color-nutrient-X-ink`
  pour du **texte**. Le miel plafonne à 2,2:1 sur blanc : écrit avec sa teinte, il est
  invisible. Règle : *un aplat prend la teinte, un mot ou un chiffre prend l'encre.* C'est la
  même distinction que `--color-primary` / `--color-primary-text`. Les encres et les pastilles
  se retournent avec le thème ; les teintes, non.
- **L'énergie n'est pas une macro** : elle reste neutre partout. Quatre couleurs pour trois
  familles, et le tricolore ne signifie plus rien.
- **Les cartes n'ont pas de bordure**, seulement une ombre presque nulle sur le papier. À dix
  cartes par écran, les traits formaient une grille à traverser avant d'atteindre le contenu.
- **Le titre d'écran vit dans la page, pas dans une barre.** Il est rendu **une seule fois**,
  dans `App.tsx` (`.hero`), pour les cinq onglets — jamais recopié dans les écrans. La barre
  garde le `<h1>` masqué pour les lecteurs d'écran, et le `.hero` est `aria-hidden`. Sur les
  vues empilées, l'ancienne barre titrée revient : le bouton retour a besoin d'un ancrage.
- L'en-tête effacée prend la couleur du **papier**, pas `transparent` : elle est collante, et
  le contenu défilait visiblement derrière.
- **Les 11 teintes de rayon (`styles/icons.css`) ne font pas partie du tricolore.** C'est un
  système de codes calibré pour rester distinct côte à côte dans une liste triée par nom. En
  retoucher une seule le déséquilibre.

## Navigation (web) — `web/src/App.tsx`

**Quatre onglets et un bouton de scan central** : Accueil · Planning · [SCAN] · Objectifs · Profil.
La barre en portait cinq (Ingrédients / Recettes / Semaine / Courses / Frigo) ; elle suit désormais
la forme du mockup. Ce qui ne se devine pas :

- **Le bouton de scan n'est PAS dans `TABS`.** Il n'y a que 4 emplacements d'onglet : le cinquième
  est le bouton, qui mange la colonne centrale. Un élément de `TABS` porte un surtitre, un grand
  titre et un état actif d'onglet — un déclencheur d'action n'en a que faire. Il est inséré par
  `TABS.slice(0, 2)` / `TABS.slice(2)` dans le rendu de la barre.
- **`kicker` fait TROIS choses** : il marque l'entrée comme onglet, il déclenche `.app-header--effacee`,
  et il s'affiche au-dessus du grand titre. Un chemin absent de `TABS` n'a donc ni hero ni en-tête
  effacée. La comparaison est une **égalité stricte** de `pathname`.
- **Bibliothèque, Recettes, Courses et Frigo ne sont plus des onglets.** Leur SEUL point d'entrée est
  le bloc `ACCES` en bas de `AccueilScreen.tsx`. Le supprimer rendrait quatre écrans inatteignables.
  Ils ont rejoint `STACKED` pour retrouver un bouton retour.
- **Les anciennes adresses redirigent** (`/semaine`, `/parametres`, `/parametres/profil`,
  `/diagnostic`) : favoris, historique, et `start_url: '/'` d'une PWA déjà installée. `replace` pour
  ne pas coincer le bouton retour. Le précédent était `/diagnostic`.
- **`/scan` ne résout et n'écrit rien.** Il lit le code, l'affiche pour confirmation, puis **renvoie**
  vers l'écran choisi avec `?scan=<code>` — ou `?ean=` pour la bibliothèque, où le paramètre existait
  déjà et veut dire autre chose (« pré-remplis la référence », pas « traite ce produit »). C'est le
  code déjà éprouvé de chaque destination qui travaille : quantité par défaut, session de courses,
  produit inconnu, doublon de nom. `useScanParam` (`web/src/lib/useScanParam.ts`) rattrape le
  paramètre, le **valide** comme la caméra, l'**efface** de l'URL en `replace` (sinon le geste retour
  rouvre la feuille en boucle) et le **retient** — côté Courses il doit survivre à l'ouverture d'une
  session.
- **Ajouter au chariot exige une session ouverte.** `SessionBar` ouvre d'office sa feuille de
  démarrage quand un code attend, et dit pourquoi.
- **`useDailyTargets`** (`web/src/lib/useDailyTargets.ts`) est la seule source de la cible du jour,
  partagée par `GoalCard` et l'Accueil. Deux copies de ce calcul afficheraient deux objectifs
  différents pour la même journée.
- **L'hydratation** est la **deuxième table cloisonnée par PERSONNE** après `user_profile`. Sa cible
  se recalcule du poids (`hydrationTarget`, 30 ml/kg borné 1,5–4 L), jamais stockée. Le dépôt écrit
  un **delta**, pas un total : deux appareils peuvent ajouter un verre dans la même minute. Le SQL
  utilise des paramètres **numérotés** (`?3` relu dans la branche UPDATE) — avec `excluded.ml` on
  relirait la valeur déjà bornée à zéro et un retrait serait perdu.

## Planning : la semaine et le jour (web)

Deux ecrans, et c'est une decision, pas un accident :

- `/planning` montre **sept lignes de hauteur fixe** : jour, badge, cinq marques de creneau, total,
  tri-barre. Rien qui grandisse avec le nombre de repas. Elle a d'abord porte une puce par repas :
  le mockup en montre trois par jour, la vraie donnee en met huit, et la ligne du mercredi faisait
  trois fois celle du mardi.
- `/planning/:jour` montre **la journee**, avec ses cinq creneaux, le tableau des apports, l'anneau,
  le cout et les outils. Le jour a d'abord ete un depliant sous sa ligne : deux niveaux de cartes
  blanches imbriquees se lisent comme un seul, et l'on ne savait plus si "MATIN" appartenait a
  mercredi ou a jeudi.
- Les **cinq marques** portent la seule information de contenu qui ne grandit pas. Elles ont un
  `aria-label` qui enumere ce qui est prevu et ce qui manque : cinq ronds ne se lisent pas a voix
  haute.
- Le total d'une ligne est celui de **la cuisine** ; le badge "Objectif tenu" compare une part
  **individuelle** (`perEater`) a la cible. Ne jamais ecrire les deux comme un rapport sur la meme
  ligne, ce serait un total de foyer face a une cible personnelle.
- **Ajouter un repas se fait en deux temps, en plein écran** (`semaine/AddEntrySheet.tsx`,
  `components/ChoixBibliotheque.tsx`, variante `plein` de `Sheet`) : choisir parmi toute la
  bibliothèque en tuiles, recettes et ingrédients filtrés par la MÊME recherche, puis doser. Il
  remplace un menu déroulant natif pour les recettes et une liste de suggestions écrasée par le
  clavier. Le même composant sert l'éditeur de recette, en ingrédients seuls (sans `onRecette`).
- **La recherche est en haut, collante, et ne prend pas la mise au point à l'ouverture** : le
  clavier masquerait la moitié des tuiles. En bas, il aurait fallu la remonter au-dessus du clavier,
  ce qu'iOS ne fait pas pour un élément fixe d'une app installée.
- **Le `top` collant est NÉGATIF** (`-var(--space-lg)`) : la position collante se compte depuis le
  bord intérieur du rembourrage de `.sheet__body`. Avec `top: 0`, la barre s'arrêtait 16 px trop
  bas et les tuiles passaient au-dessus d'elle (mesuré).

## Éditeur de recette : les ingrédients (web) — `screens/recettes/RecipeEditor.tsx`

- **Ajouter passe par la bibliothèque en plein écran** (`ChoixBibliotheque`, ingrédients seuls),
  qui reste ouverte pour enchaîner les ajouts ; le pied compte ce qui a été pris.
- **DOUBLON INTERDIT, à deux niveaux** : la tuile d'un ingrédient déjà présent reste visible mais
  marquée « Déjà ajouté » et `disabled` (la cacher ferait chercher un ingrédient qu'on croit
  absent), et `addIngredient` refuse un identifiant déjà là, au cas où deux taps partent avant le
  rendu qui désactive la tuile.
- **Chaque ligne porte la pastille de son rayon** (`useRayonStyle`), les intertitres aussi : on
  reconnaît un légume ou un laitage à sa couleur avant d'avoir lu son nom. Le nom est un lien
  vers la fiche, signalé par un **chevron** ; seul le libellé se tronque.

## Pieds d'action fixes (web)

Six ecrans posent un pied fixe au-dessus de la barre d'onglets (fiche ingredient, liste et editeur
de recettes, frigo, courses, session). Deux regles vont ENSEMBLE, et n'en tenir qu'une casse
l'ecran :

- le pied reserve `--scan-overlap` en bas, sinon le bouton de scan central, qui deborde de 20 px en
  `z-index: 20`, lui prend le tap sur 56 px de large, exactement au centre ;
- **le contenu reserve la hauteur du pied**, `calc(var(--reserve-pied) + N)`, sinon son dernier
  element passe SOUS le pied et devient intapable. `--reserve-pied` porte la part commune ; le `N`
  est propre a chaque pied, leurs hauteurs different.

**Toutes ces regles doivent doubler la classe** (`.screen.screen--X` et non `.screen--X`) : `.screen`
pose `padding: var(--space-lg)` dans `app.css`, et a specificite egale c'est l'ordre des fichiers
qui tranche. Le defaut s'est produit quatre fois dans ce projet, dont une fois sur ce pied precis,
ou "Annuler" est reste inatteignable un moment.

## Quantites et unites (web)

- **La masse est stockee EN GRAMMES**, partout, toujours. C'est ce qui permet d'additionner un
  yaourt compte en pieces et du riz pese en grammes sans convertir a chaque agregation.
- **L'unite de saisie est stockee A COTE**, en colonne `unit`, sur `recipe_ingredient` depuis la
  0001 et sur `meal_plan_entry` depuis la **0011**. Sans elle, "40 g" d'un produit vendu par pieces
  de 100 g rouvrait en "0,4 piece" : la masse etait juste, la lecture ne l'etait plus.
- `NULL` veut dire "aucun choix enregistre" : l'ecran retombe sur son heuristique, la piece quand
  l'ingredient en a une, le gramme sinon. Les entrees anterieures gardent donc leur comportement.
- **Changer d'unite compte comme une modification a enregistrer**, meme quand le nombre de grammes
  ne bouge pas : c'est une decision de lecture, et la feuille rouvrirait sinon sur l'ancienne.
- `QuantityField` accepte deja `unit` et `onUnitChange` : toute nouvelle surface de saisie doit
  brancher les deux, sinon le choix se perd en silence.
- **Une recette se sert en portions OU en grammes** (`semaine/PortionsOuGrammes.tsx`), mais la
  base ne stocke que des PORTIONS : la regle XOR tient. Les grammes se convertissent par le poids
  cuit d'une portion (`cookedGramsPerPortion`, dans `shared/src/nutrition.ts`, meme calcul que le
  poids cuit de la fiche). L'unite `g` (`UNITE_GRAMMES`, `semaine/totals.ts`) est enregistree a
  cote pour relire et rouvrir le repas en grammes ; aucun calcul ne la lit, le serveur la stocke
  telle quelle. Les portions gardent toute leur precision (0,8333...) : arrondies, 350 g se
  rouvriraient en 349. Sans ligne, une recette ne pese rien et ne se dose qu'en portions.

## Comptes et cuisines — `scripts/add-user.mjs`

**UNE CUISINE PAR COMPTE. Il n'existe aucun moyen d'en partager une.** Règle posée le
2026-08-16, après incident. Ce qui ne se devine pas :

- **Le partage ne reviendra que par INVITATION consentie** : le propriétaire émet, l'invité
  accepte. Tant que ce chemin n'existe pas, il n'y en a aucun — ni option, ni défaut, ni
  raccourci. Ajouter un drapeau « rejoindre la cuisine de X » est explicitement hors sujet.
- **`--cuisine="Nom"` est OBLIGATOIRE à la création.** Le script plaçait avant tout compte sans
  cette option dans la cuisine n° 1. L'intention était le cas du conjoint ; le défaut était le
  mauvais, l'option dangereuse étant celle qu'on obtient sans rien taper. Ce qu'il a coûté : un
  compte créé en une commande a ouvert à un tiers les recettes, le frigo, les prix et le planning
  du foyer 1.
- **Plus d'`ON CONFLICT(username) DO UPDATE`.** Il excluait `household_id` — correct pour un
  changement de mot de passe, désastreux avec `--cuisine` : la séquence créait la cuisine, y
  copiait les 3 484 lignes du catalogue, puis tombait dans le `ON CONFLICT` et laissait le compte
  dans sa cuisine d'origine. Le script affichait « données entièrement séparées » sans avoir rien
  déplacé, et abandonnait un foyer sans habitant. **La commande censée réparer le problème
  affichait le succès sans le réparer.** Création et changement de mot de passe sont désormais
  deux instructions distinctes (`INSERT` nu, `UPDATE` nu) et deux modes explicites.
- **L'existence du compte est vérifiée AVANT d'écrire**, parce que `wrangler d1 execute` n'est pas
  transactionnel : rien ne défait la création de cuisine si l'`INSERT` du compte échoue ensuite.
- **Ce contrôle doit passer par `--command`, jamais `--file`.** Avec `--file`, wrangler répond par
  un résumé (« Total queries executed », « Rows read ») et non par les colonnes : un
  `SELECT COUNT(*)` y est introuvable, et le contrôle rendait silencieusement « le compte
  n'existe pas ». Une réponse sans la colonne attendue rend `null`, jamais zéro.
- **Six tables sont cloisonnées par PERSONNE et non par foyer** : `user_profile`,
  `hydration_day`, `weight_log`, et depuis la 0018 les trois tables de notifications
  (`push_subscription`, `notification_pref`, `notification_log`). Poids, taille, objectifs, pesées,
  hydratation et rappels restent donc invisibles aux autres comptes, **y compris dans une même
  cuisine**. Tout le reste (recettes, ingrédients, frigo, prix, tickets et **planning de repas**)
  appartient au foyer.

## Console d'administration — `admin.bat`, `scripts/admin/`

Gestion des comptes, **hors de l'application**. Ce qui ne se devine pas :

- **Elle n'est JAMAIS déployée, et c'est tout le principe.** Administrer, c'est voir tous les
  foyers ; or le serveur entier est bâti sur `Repositories(db, householdId)`, qui rend l'oubli du
  foyer impossible. Un écran d'admin dans la PWA aurait exigé d'ouvrir une échappatoire à cette
  règle dans le Worker déployé, plus un rôle privilégié en base. **Ce qui n'existe pas ne se
  contourne pas** : le site en ligne ne gagne aucune route, et il n'y a pas de compte admin.
- **« Le serveur refuse sauf en local » a été écarté** : le Worker déployé tourne sur le réseau de
  Cloudflare, il n'y a pas de « local » chez lui. On ne pourrait filtrer que sur
  `cf-connecting-ip`, une IP domestique change, et se fier à un en-tête est fragile.
- **Elle emprunte l'authentification de `wrangler`**, elle n'a aucun secret à elle. Qui peut la
  lancer pouvait déjà lancer `wrangler d1 execute` : elle n'ouvre aucun pouvoir nouveau, elle rend
  lisible ce qui se faisait en SQL. Conséquence assumée : **on n'administre pas depuis le
  téléphone**.
- **`127.0.0.1` explicitement, jamais `0.0.0.0`** : sinon une console capable de supprimer des
  comptes en production serait joignable par tout le réseau local.
- **Aucun passe-plat SQL.** Chaque geste est une route nommée dont la requête est écrite dans
  `serveur.mjs`. Les identifiants de chemin sont validés comme **entiers** avant interpolation,
  parce que `wrangler d1 execute --command` ne prend pas de paramètres liés.
- **`--command` pour lire, `--file` pour écrire, et ce n'est pas interchangeable.** Avec `--file`,
  wrangler répond par un résumé (« Total queries executed ») au lieu des colonnes : un `SELECT
  COUNT(*)` y est introuvable et vaut toujours zéro. Le défaut est silencieux.
- **La base de développement est la cible par défaut.** S'ouvrir sur la production inviterait à
  cliquer avant d'avoir regardé où l'on est.
- **La console signale les cuisines habitées par plus d'un compte.** C'est exactement ce qui est
  passé inaperçu le 2026-08-16 ; la règle du projet est une cuisine par compte.
- **Supprimer exige un compte déjà désactivé, puis l'identifiant recopié.** La désactivation coupe
  l'accès immédiatement (le compte est relu à chaque requête) et se défait ; la destruction ne
  s'offre qu'ensuite. Elle ne touche **que** le compte : sa cuisine et son contenu restent, sans
  quoi « supprimer un compte » ferait disparaître une cuisine entière.
- **Les deux cibles ne rendent pas `NULL` pareil** : la production rend un `null` JSON, miniflare
  rend la chaîne `"null"`. Sans ce cas, tout compte jamais connecté affichait « null ».

### Créer un compte : le lien d'invitation

- **L'administrateur ne choisit pas le mot de passe d'autrui.** Le compte naît avec une empreinte
  **tirée au hasard**, qu'aucune saisie ne peut satisfaire : il est inutilisable jusqu'à ce que son
  propriétaire suive le lien. Le mot de passe ne transite ni par le réseau de l'administrateur ni
  par son écran.
- **SHA-256 pour le jeton, PBKDF2 pour un mot de passe**, et ce n'est pas une inconséquence : le
  hachage lent protège un secret **choisi par un humain**, donc devinable. Un jeton fait 256 bits
  tirés au hasard — il n'y a rien à deviner. Seule l'empreinte est stockée, une fuite de la table
  ne doit pas permettre de réclamer les invitations en attente.
- **`/api/invitation` et `/api/invitation/mot-de-passe` sont les SEULES choses que la console
  ajoute au serveur déployé**, et les seules routes publiques en écriture du projet.
- **Le jeton voyage dans le CORPS, jamais dans l'URL de l'appel.** Il est forcément dans l'adresse
  de la page — c'est ce qu'on colle dans un message — mais une chaîne de requête finit dans les
  journaux d'accès et les rapports d'erreur. Chemins **fixes** aussi parce que `PUBLIC_ROUTES`
  compare des chemins exacts : un segment variable aurait obligé à y ouvrir une correspondance
  approximative.
- **`used_at` est marqué AVANT que le mot de passe ne soit posé.** Le `WHERE used_at IS NULL` est
  une prise de verrou : de deux requêtes simultanées, une seule voit `changes = 1`. L'ordre inverse
  laisserait les deux aboutir, et un lien intercepté suffirait à reprendre un compte déjà réclamé.
  `worker/src/invitation.test.ts` vérifie cet ordre dans le source, et le test a été **vu échouer**
  avant d'être gardé.
- **Un seul message pour « inconnu », « déjà utilisé » et « périmé »** : les distinguer apprendrait
  à un curieux qu'un jeton a existé.
- **L'écran d'invitation passe AVANT la garde d'authentification** (`AuthGate`), et la vérification
  de session y est désactivée : son destinataire n'a pas de session, l'envoyer sur l'écran de
  connexion lui demanderait le mot de passe qu'il est justement invité à choisir.
- **La session s'ouvre dans la foulée.** La personne vient de prouver qu'elle détient le jeton et
  de choisir le mot de passe : le lui redemander n'apporte aucune garantie.
- **Le lien n'est affiché qu'une fois**, et la console le dit. Elle ne peut pas le retrouver :
  perdu, il faut supprimer le compte et recommencer.
- **`scripts/lib/cuisine-sql.mjs` porte le SQL de création de cuisine, écrit une seule fois.** La
  ligne de commande et la console le produisent toutes deux ; deux copies auraient divergé, et la
  règle « une cuisine par compte » ne vaut que si les deux chemins l'appliquent à l'identique.

### Cuisines, réinitialisation, contrôle de santé

- **`meta.changes` N'EXISTE PAS sur la cible locale.** La production le renseigne, miniflare ne
  rend qu'une `duration`. Lu `?? 0`, un renommage parfaitement appliqué se lisait « aucune ligne
  modifiée » et l'écran annonçait une erreur sur une opération réussie. `requete()` rend donc
  **`null`** pour « on ne sait pas », et **tout appelant relit la donnée** au lieu de compter les
  lignes. Troisième piège du même genre après `--file` qui ne rend pas les colonnes : sur cette
  console, ne jamais croire un compteur, toujours relire.
- **`scripts/lib/tables-foyer.mjs` liste les tables à vider avant de retirer une cuisine, DANS
  L'ORDRE.** `REFERENCES household (id)` est posé sans `ON DELETE` (0005) : rien ne part tout seul.
  La liste est **écrite et non déduite**, parce qu'une déduction ne connaîtrait pas le bon ordre —
  et `worker/src/administration.test.ts` la compare aux migrations, en suivant les renommages
  `x_new → x` du motif de reconstruction SQLite. Sans ce suivi, l'analyse croit `app_setting` non
  cloisonnée, soit l'inverse de la vérité sur la table qui porte le secret de session.
- **`app_setting` foyer 0 n'est pas une cuisine** : il porte le secret de signature et le compteur
  d'échecs. La suppression ne vise qu'un identifiant réel, mais toute évolution doit garder la
  distinction — effacer le foyer 0 déconnecterait tout le monde.
- **Une cuisine habitée ne se supprime pas.** La retirer sous un compte le laisserait devant une
  application vide, sans rien pour lui dire ce qui s'est passé. Le refus est côté serveur ; le
  bouton grisé ne fait que le refléter.
- **Réinitialiser n'invalide pas l'ancien mot de passe.** Il reste valable jusqu'à ce que le lien
  soit suivi : le révoquer aussitôt couperait quelqu'un qui n'a rien demandé, sur la foi d'un clic.
  Pour couper immédiatement, il y a « Désactiver ». Les invitations précédentes du compte sont en
  revanche **effacées** — deux liens vivants, c'est un lien de trop à intercepter.
- **`user_invite.kind` distingue création et réinitialisation.** Stocké plutôt que déduit de
  `last_login_at IS NULL` : la déduction serait juste presque toujours, et fausse précisément dans
  le cas qu'on regarde — un compte créé, jamais utilisé, dont on réinitialise le mot de passe.
- **Le contrôle de santé porte les vérifications faites à la main le 2026-08-16**, et chacune
  correspond à un désordre **constaté**. Seuls « cuisines partagées », « comptes sans cuisine » et
  l'écart d'index FTS sont marqués graves : un tableau où tout est rouge ne se hiérarchise plus.

## Profil et objectifs (web) — `shared/src/profile.ts`

Cible journalière en kcal et macros, par Mifflin-St Jeor. Le calcul est un module **pur**, testé
comme une spécification (valeurs de référence calculées à la main, pas relevées sur une exécution).
Ce qui ne se devine pas :

- **`user_profile` est la seule table cloisonnée par PERSONNE**, pas par foyer — d'où un dépôt
  construit à part, hors de l'agrégat `Repositories`. Poids et taille sont des données de santé :
  partager une cuisine ne donne pas le droit de les lire. L'identifiant vient du cookie signé, et
  aucun paramètre ne permet de demander le profil de quelqu'un d'autre.
- **`household.eaters` appartient au foyer**, lui, et sert à diviser le total d'une journée avant
  de le comparer à un objectif personnel. `meal_plan_entry` ne dit toujours pas qui mange : la voie
  exacte (une colonne `user_id`) a été écartée en connaissance de cause, elle imposait de repenser
  l'écran Semaine. C'est une approximation, et l'interface le dit plutôt que de diviser en silence.
- **Les cibles ne sont pas stockées** : elles se recalculent du profil, par la même fonction côté
  Worker et côté navigateur. Deux copies d'un même chiffre finissent toujours par diverger.
- **Deux axes séparés, et c'est le point** : `ENERGY_GOALS` décide du COMBIEN (six objectifs, de la
  sèche à la prise de masse), `MACRO_SPLITS` décide du COMMENT (sept répartitions, dont `perso`).
  Chaque objectif *propose* une répartition (`defaultSplit`) que l'utilisateur peut remplacer. La
  version d'origine les soudait dans une liste de trois : « perdre du poids » imposait alors ses
  pourcentages.
- **Un poids visé plus une allure l'emportent sur le pourcentage de l'objectif** : l'écart vient
  alors de `pace × KCAL_PER_KG / 7`. La direction se lit sur l'écart réel au poids visé, jamais sur
  le libellé de l'objectif.
- `estimateTargets` rend **`null`** dès qu'une mesure manque, et ne descend jamais sous
  `MIN_SAFE_KCAL` (1 200 / 1 500) ni au-delà de `MAX_ADJUST` (25 % de la dépense). Quatre drapeaux
  (`floored`, `capped`, `lowProteins`, `lowFats`) obligent l'écran à dire ce qui a été corrigé.
- **`weeksToTarget` est `null` quand le réglage n'avance pas vers la cible** — le plancher peut
  relever l'apport au-dessus de la dépense, ce qui fait grossir qui voulait maigrir. Annoncer une
  date serait promettre l'inverse de ce qui arriverait.
- Le total des pourcentages manuels n'est **jamais bloquant** : `normalizeSplit` le ramène à 100 des
  deux côtés du réseau, et l'écran affiche le résultat.
- `user_profile` a été **reconstruite** en 0009 (SQLite ne sait pas modifier un CHECK). Toute
  évolution de `goal`, `split` ou `pace` demandera la même manœuvre — copie, bascule, vérification
  du nombre de lignes AVANT le `DROP`.

## Tendance de poids (web) — `shared/src/weight.ts`

L'écran `/objectifs` est un **tableau de bord**, pas un formulaire : six blocs, du plus stratégique
(le cap) au plus opérationnel (les mesures). Le formulaire de réglage n'a pas disparu, il vit sous
`/objectifs/reglages`, vue empilée avec bouton retour. Ce qui ne se devine pas :

- **`weight_log` est la troisième table cloisonnée par PERSONNE**, après `user_profile` et
  `hydration_day`, pour la même raison. **Une mesure par jour**, d'où la clé primaire : se peser
  deux fois le même matin est courant, et garder les deux ferait pencher la moyenne selon l'heure.
- **`user_profile.weight_kg` reste**, et ce n'est pas un doublon : c'est la valeur de référence du
  calcul de cible, celle qu'édite l'écran de réglage. Enregistrer une pesée la met à jour, sinon la
  cible se calculerait sur un poids d'il y a trois mois. On peut régler un profil sans se peser.
- **La fenêtre de la moyenne mobile est en JOURS, pas en mesures.** "Les 7 dernières pesées"
  couvriraient une semaine pour qui se pèse chaque matin et six pour qui se pèse le dimanche.
- **Le rythme est une régression des moindres carrés sur la série lissée**, jamais l'écart entre
  deux pesées brutes : une seule journée salée en fin de période ferait basculer la pente.
  `null` sous 7 jours d'étendue.
- **`etaDay` est `null` quand le rythme ne va pas VERS la cible**, même règle que `weeksToTarget`.
  Et l'arrondi du nombre de jours retranche `1e-9` : `3,65 / 0,35 × 7` vaut `73,00000000000001` en
  virgule flottante, ce qui faisait sauter la date d'un jour selon les chiffres saisis.
- **La régularité porte sur la SEMAINE en cours**, pas sur 30 jours comme le mockup : le calendrier
  se charge par semaine, et couvrir un mois coûterait cinq requêtes dont quatre pour une seule
  statistique. Le libellé dit sur quoi il porte plutôt que d'annoncer une fenêtre qu'il n'a pas.
- **Un jour raté est un cercle ouvert, pas un aplat rouge**, et l'écart de poids hebdomadaire ne
  prend aucune couleur de jugement : monter n'est pas une faute quand on vise une prise de masse.
- **Le tour de taille n'entre dans aucun calcul.** Il se lit seul, à côté de l'IMC, parce que la
  balance ne dit pas où sont partis les kilos. Une valeur, pas un historique.
- Contraste : dans cette palette, **seul `--color-text-placeholder` tient 3:1 sur une carte dans
  les deux thèmes** (3,53 clair / 4,57 sombre). `--color-border-hover` tombe à 1,5 et
  `--color-text-disabled` à 1,87 : un trait de courbe ou une pastille qui les porte disparaît.

## Régler mes objectifs (web) — `web/src/screens/reglages/`

`/objectifs/reglages`, vue empilée. Un mockup y pose trois tuiles et une jauge continue là où
le modèle a six objectifs et trois allures. Ce qui ne se devine pas :

- **La tuile (Perdre / Maintenir / Prendre) n'existe pas en base.** C'est une projection de
  `goal`, recalculée à chaque rendu par `directionOf`. `GOAL_DIRECTIONS` regroupe les **six**
  `ENERGY_GOALS`, aucun ne disparaît, et quatre tests gardent l'invariant : couverture
  exhaustive, ordre du plus doux au plus marqué, signe cohérent, et **aucun défaut au-delà de
  10 % d'écart**. Un déficit de 20 % ne s'obtient jamais sans un geste.
- **Aucune tuile n'est présélectionnée quand `goal` est nul.** En présélectionner une ferait
  passer l'écran de "il manque l'objectif" à une estimation complète sans un seul geste, et le
  prochain enregistrement écrirait en base un objectif que personne n'a choisi.
- **Changer de tuile garde l'objectif s'il appartient déjà à la nouvelle direction**
  (`goalForDirection`), sinon prend le plus doux. Conséquence assumée : Sèche → Prendre → Perdre
  rend "Perte progressive". L'alternative, une mémoire par direction, restituerait 20 % d'écart
  sans geste.
- **La contradiction se dit, elle ne se corrige pas toute seule.** Viser plus lourd avec la tuile
  Perdre est possible : `estimateTargets` tranche par l'écart **réel**, jamais par le libellé.
  Retourner la tuile en silence réécrirait aussi la répartition qu'elle propose.
- **L'allure est un CURSEUR CONTINU**, de 0,10 à 1 kg/semaine par pas de 0,05. Elle a d'abord
  été trois arrêts, parce que `user_profile.pace` était une énumération sous CHECK ; la
  migration 0014 en a fait un REEL (`pace_kg_per_week`) et converti les profils enregistrés.
  **Le pouce natif est réduit à 1 px et le rond dessiné à part** : un `input[type=range]` place
  le sien à "demi-pouce + valeur × (largeur - pouce)", ce qui dérive de plusieurs pixels par
  rapport à des frontières de zone posées en pourcentages exacts. Mesuré à cinq positions :
  zéro écart. `null` veut toujours dire "celle de l'objectif", état que le curseur ne sait pas
  porter, d'où le rond caché et le bouton de retour.
- **L'échelle 0 à 1,2 kg/semaine n'est pas décorative** : la bande jusqu'à `SAFE_PACE.min` dit
  "trop lent pour se voir", celle jusqu'à `SAFE_PACE.max` la zone sûre, le reste ce qu'on
  n'offre pas. Qu'aucun des trois arrêts n'y tombe **est** le message.
- **Chaque phrase du bloc "Limites et précautions" a été vérifiée contre le code.** Le mockup
  annonçait quatre choses fausses (refus sous le métabolisme de base, refus au-delà de 1 kg/sem.,
  le verbe "refuser", un recalage hebdomadaire). Une promesse que le code ne tient pas fait
  baisser la garde de qui la lit : avant d'y toucher, relire `MIN_SAFE_KCAL`, `MAX_ADJUST`,
  `PACES` et le fait qu'une **cible saisie à la main échappe aux deux garde-fous**.
- **Il n'y a PAS de case de consentement**, et c'est une décision : une reconnaissance qu'on
  obtient d'un réflexe en deux passages n'en est pas une, et elle bloquait l'enregistrement de
  réglages sans rapport avec la santé. L'encart informe, il ne fait pas signer. La colonne
  `limits_ack_at`, ajoutée puis retirée le lendemain, est partie avec la migration 0014.
- **Les encarts Répartition et La cuisine ont été retirés.** Conséquence à connaître : les sept
  `MACRO_SPLITS` et `eaters` ne sont plus réglables, mais **leurs colonnes restent** et leurs
  valeurs continuent de s'appliquer. Une répartition déjà enregistrée vaut toujours ; à défaut,
  c'est celle que propose l'objectif.
- **L'âge se saisit en années, l'année de naissance est stockée.** `ageFrom` n'est qu'une
  soustraction d'années : l'aller-retour est exact.

## Photo de garde (web) — `shared/src/photo.ts`, `worker/src/routes/photos.ts`

Une photo par recette, stockée dans R2, servie par une route authentifiée. Ce qui ne se devine pas :

- **R2 est le premier magasin du projet SANS colonne de foyer**, et sans possibilité d'en avoir
  une. Dans D1, un `AND household_id = ?` oublié rend une liste vide parce que le dépôt porte le
  foyer structurellement ; dans R2, **tout le cloisonnement est dérivé**. Il n'existe que parce
  que chaque route passe par `repos.recipes.get()` **avant** de toucher au bucket.
- **Vérifier l'appartenance de la RECETTE n'implique pas vérifier celle de la CLÉ.** C'est le
  point le plus subtil du chantier, et c'est pourquoi `imageKey` est **sorti de
  `recipeWriteSchema`** : champ libre en écriture, il permettait de faire pointer sa recette vers
  la photo d'un autre foyer. La photo est une sous-ressource, POST et DELETE sur
  `/api/recipes/:id/image`, et la clé n'est jamais fournie par le client.
- **L'ordre des écritures est la seule garantie**, aucune transaction ne couvre D1 et R2. Règle :
  *D1 ne doit jamais désigner un objet qui n'existe pas.* Dépôt, R2 d'abord ; retrait, D1 d'abord.
  Le bon sens échoue invisiblement (objet orphelin, balayé au dépôt suivant), le mauvais échoue en
  affichant une image cassée.
- **Le `content-type` servi est une constante littérale, et `writeHttpMetadata` n'est JAMAIS
  appelé.** Cette méthode, que la doc Cloudflare montre en exemple, rejoue ce que le client avait
  déclaré : un SVG téléversé en `image/svg+xml` puis ouvert en navigation de premier niveau serait
  un document dont les scripts liraient `/api/profile`. S'y ajoutent `nosniff` et une CSP
  `sandbox`, qui neutralise le scénario même si tout le reste échoue.
- **La clé porte une empreinte SHA-256 du contenu, et l'URL la reprend en `?v=`.** `immutable` et
  clé versionnée **se tiennent debout mutuellement** : prendre l'un sans l'autre casse en silence,
  clé fixe plus `immutable` donnant l'ancienne photo pendant un an. Le serveur **ignore** `v`, ce
  qui fait qu'une vieille URL sert l'image courante au lieu d'une erreur. L'empreinte rend aussi
  le dépôt idempotent.
- **`request.formData()` ne borne rien** : un corps de 100 Mo tue l'isolat, et cette mort n'est
  **pas rattrapable** par le `try/catch` du routeur. Le corps est plafonné dans le flux lui-même,
  `content-length` n'étant qu'un rejet précoce, jamais une garantie.
- **On REFUSE l'EXIF, on ne le retire pas.** L'étiquette Orientation vit dans APP1 ; sur un fichier
  qui n'est pas passé par le canvas, la rotation n'est pas cuite dans les pixels, et effacer
  l'étiquette la rendrait **définitive**. APP0 (JFIF) et APP2 (ICC) sont tolérés, un navigateur
  joignant parfois un profil de couleur à la sortie d'un canvas.
- **Le navigateur réduit, pas le Worker**, et pas d'abord par économie : le décodeur du système est
  **le seul qui lise le HEIC** d'un iPhone, `workerd` n'en a aucun. Trois pièges tenus, tous sur du
  matériel **récent** : la limite de surface d'un canvas iOS (16 777 216 px, un iPhone 15 Pro
  photographie 1,46 fois au-dessus), `imageOrientation: 'from-image'` sans quoi toute photo
  verticale sort couchée, et le repli **silencieux** de `toBlob` sur PNG quand le type est inconnu.
- **`accept="image/*"` et rien d'autre** : depuis Safari 17, mentionner `image/heic` fait convertir
  VERS le HEIC tout ce qu'on donne. Et **pas de `capture`**, qui sur iOS fait disparaître la
  photothèque.
- **Le bucket est sous juridiction `eu`, pas sous une simple zone.** `--location` n'est qu'un
  indice que Cloudflare peut ignorer, et il l'a ignoré : mesuré. Le binding porte donc
  `jurisdiction = "eu"` ; **sans cette ligne le Worker ne trouve plus le bucket du tout**.
- **La pastille aux couverts n'est pas un suppléant d'image manquante**, c'est l'aspect normal
  d'une recette sans photo. Elle occupe la **même boîte** que la vignette, sinon la liste part en
  dents de scie. Le repli sur `onError` ramène la même pastille : une session expirée rend un 401,
  et le carré cassé du navigateur ferait croire à une perte.
- **Le voile bas du bandeau n'est pas une finition** : le dégradé fixe garantissait le contraste du
  texte blanc, une photo détruit cette garantie et il faut la reconstruire dans le pire cas, une
  photo entièrement blanche. Mesuré à 7,13:1. Le bouton, tout en haut, échappe au voile et porte
  seul sa pastille à 55 % de noir, mesurée à 4,40:1.
- **Pas de `runtimeCaching` pour les photos** : ce serait la première exception à la règle écrite
  dans `vite.config.ts`, et un handler `CacheFirst` répondrait **sans repasser par le cookie**.
  Conséquence assumée : au démarrage à froid sans réseau, les photos affichent le suppléant.

## L'anneau et le tableau (web) — `components/MacrosDonut.tsx`

Une seule forme dit la répartition des macros, sur tous les écrans qui l'affichent : la fiche
et l'éditeur de recette, la feuille d'un repas, la journée. Ce qui ne se devine pas :

- **Les arcs sont proportionnels aux GRAMMES**, plus aux calories. L'anneau répondait à
  "d'où viennent les calories", il répond à "de quoi ce plat est fait". Ce n'est pas un
  détail : les lipides pèsent 9 kcal/g contre 4 aux glucides, donc la lecture énergétique
  leur donnait près du double de la place. `massBreakdown` porte le calcul, et un test
  vérifie que les deux lectures divergent bien, pour qu'un retour en arrière casse là.
- **La colonne "Part" du tableau lit la MÊME base** (`massShare`). Elles se suivent à trois
  centimètres : deux bases donneraient deux nombres pour la même chose. Changer l'une sans
  l'autre est le défaut à ne pas refaire.
- **`macroMassG` n'est PAS le poids de l'aliment.** L'eau n'y est pas : 100 g de yaourt ne
  portent qu'environ 12 g de macros. "51 % de glucides" veut dire 51 % des macros, jamais
  51 % de l'assiette.
- **Ce qui reste énergétique le reste** : le nombre au centre de l'anneau est bien des kcal,
  et les `MACRO_SPLITS` du profil sont des parts d'énergie, ce que cette figure n'illustre pas.
- **L'ANNEAU EST TOUJOURS AU-DESSUS DE SON TABLEAU, dans la MÊME carte, sans rien entre les deux.**
  La figure montre, le tableau chiffre ce qu'elle montre. La règle vaut sur les **quatre** surfaces
  qui affichent la paire : fiche de recette, éditeur, journée, feuille d'un repas. Elle a été
  redemandée **quatre fois** parce que chaque correction ne regardait que l'écran signalé pendant
  que les autres gardaient l'ordre inverse. `web/src/components/anneau-tableau.test.ts` la vérifie
  désormais sur les quatre fichiers, et le test a été vu échouer avant d'être gardé.
- **Le tableau de l'éditeur n'est PAS le composant partagé** : il porte trois colonnes d'échelle
  (100 g, portion, recette entière) et vivait donc hors de la règle, ce qui explique qu'il ait été
  le dernier à manquer sa colonne de part. Celle-ci est sa **deuxième** colonne, entre le nom et
  les trois échelles : les échelles forment une famille dont la part ne fait pas partie, puisqu'une
  proportion de masse ne change pas quand on divise par le nombre de portions. Et posée en
  cinquième, elle sortait de l'écran : mesuré sur téléphone, 469 px de tableau pour 311 visibles.
- **Il n'y a PAS de légende, et plus de façon d'en remettre une.** Le composant portait un
  `showLegend?: boolean` optionnel valant `true` : les écrans corrects le posaient à `false`,
  l'éditeur de recette ne le posait pas et gardait donc la sienne. Signalé trois fois, corrigé
  deux fois sans disparaître, parce qu'on corrigeait la VALEUR là où il fallait supprimer le
  RÉGLAGE. Tant qu'un oubli reste exprimable, un nouvel appel le reproduit. Le prop est parti
  avec le balisage, et le typecheck a signalé les deux appels restants.
- **`MacrosRing` existe sans carte autour**, pour la fiche : le sélecteur d'échelle (par
  portion, recette entière, aux 100 g) commande l'anneau ET le tableau, donc les deux vivent
  sous lui dans une seule carte. La version cartée y ferait une carte blanche dans une carte
  blanche, ce que ce projet a déjà payé sur le planning.
- La répartition chiffrée passe dans l'`aria-label` du tracé : quatre arcs ne se lisent pas
  à voix haute.

## Repères nutritionnels (web) — `shared/src/limits.ts`

Quatre repères journaliers affichés sous la cible en calories : trois plafonds (sel, sucres,
acides gras saturés) et un plancher (fibres). Ce qui ne se devine pas :

- **Chaque nombre porte son agence et son année**, dans le code comme à l'écran. C'est la règle
  du module : ne jamais afficher un chiffre de santé que ses sources ne soutiennent pas. Un seuil
  inventé serait cru, et c'est ce qui le rend pire que pas de seuil.
- **L'ANSES n'est PAS citée pour le sel**, et un test le garde : sa page affiche encore les
  objectifs du PNNS 3, différenciés par sexe (8 g homme, 6,5 g femme). Le repère unique de 5 g
  vient de l'OMS et des repères PNNS 2019. Le 12 % des saturés vient de l'**Afssa (avis de
  2010)** et porte sur l'apport énergétique **sans alcool** : identique ici, puisque
  l'application ne suit pas l'alcool, mais ce ne le serait plus si elle le suivait.
- **Seuls les saturés suivent la cible énergétique** (10 % de l'apport, OMS 2023). Les trois
  autres sont des nombres absolus. L'ANSES retient 12 % pour les saturés : la divergence est
  affichée, pas tranchée en silence.
- **Le piège du périmètre sur les sucres.** L'OMS vise 10 % de l'énergie en sucres **libres**,
  qui excluent les fruits entiers et le lactose. CIQUAL et OpenFoodFacts ne donnent que les
  sucres **totaux** : comparer notre total à la cible OMS surestimerait le dépassement. D'où le
  repère ANSES (100 g de sucres totaux hors lactose), le seul dont le périmètre approche la
  donnée, avec la nuance écrite à l'écran.
- **Aucune fonction ne fait dépendre un repère d'un autre, et un test le garde.** L'idée que les
  fibres du jour rachèteraient les sucres du jour est juste dans son mécanisme (une fibre
  visqueuse ralentit le sucre avalé *avec elle*) et fausse à cette échelle : la simultanéité est
  constitutive, le rapport 10:1 de l'AHA juge un **produit** en rayon, et aucune des quatre
  agences qui ont examiné les deux dossiers ne conditionne l'un à l'autre. L'OMS retourne même
  l'intuition : elle ne tolère pas plus de sucres, elle **retire du compte** ceux qui viennent
  avec leur matrice. `dailyLimits` n'accepte donc que la cible énergétique, et un test vérifie
  sa signature pour qu'une future "amélioration" casse là plutôt qu'en silence.
- Les mots **compensé, neutralisé, rattrapé** n'ont pas leur place sur cet écran.

## Serveur local et ecran de connexion (web) : `mobile.bat`

`mobile.bat` construit le site, migre la base locale, demarre le serveur et ouvre un Chromium
emule en iPhone 14 Pro. **Il n'y a pas d'ecran de connexion en local**, et c'est une decision.
Ce qui ne se devine pas :

- **La porte est `devUser()` dans `worker/src/auth.ts`, et elle a DEUX verrous** : `DEV_AUTOLOGIN`
  vaut `'1'` **et** `ENVIRONMENT` ne vaut pas `'production'`. Les deux ne peuvent etre reunis que
  par `.dev.vars`, fichier que `wrangler dev` seul lit, qu'aucun deploiement ne televerse et que
  `.gitignore` couvre depuis l'origine du portage. Le second verrou n'est pas redondant : il tient
  seul si quelqu'un ajoute la variable dans le tableau de bord Cloudflare. Dix tests gardent
  l'ensemble (`worker/src/auth.dev.test.ts`), dont un qui verifie que `DEV_AUTOLOGIN` n'apparait
  **pas** dans `wrangler.toml`, seule voie vers le deploiement.
- **Le cookie passe TOUJOURS en premier.** `devUser()` n'est consulte qu'a defaut de session : le
  chemin normal reste celui de la production, meme sur le poste du developpeur.
- **La connexion auto est appliquee en UN SEUL endroit**, la garde de `index.ts`. C'est pourquoi
  `/api/session` lit `user` du contexte au lieu de rappeler `currentUser` : en le recalculant, il
  serait le seul a manquer le contournement, donc le seul a afficher quand meme l'ecran de
  connexion.
- **Le compte se cree tout seul** si la base locale n'en a aucun, avec une empreinte **aleatoire**
  qu'aucun mot de passe ne peut satisfaire. On reprend sinon le **premier compte actif** : entrer
  sous une autre identite montrerait une cuisine vide alors que les donnees d'essai sont la.
- `mobile.bat connexion` garde l'ecran de connexion pour le tester, et redemande alors un compte
  via `dev-compte.mjs`. `scripts/dev-vars.mjs` ecrit `.dev.vars` en **fusionnant** : un jeton d'API
  deja present y survit.
- **Le lanceur tue ce qui tient le port AVANT de demarrer.** Sans cela, un serveur d'un lancement
  precedent repondait a la sonde d'attente : le demarrage etait declare reussi et le navigateur
  s'ouvrait sur le site d'une heure plus tot. On corrigeait un ecran, on relancait, rien ne
  changeait, et aucun message ne disait pourquoi. Constate avec deux serveurs vivants a la fois.
- **`wrangler pages dev` sert `web/dist`, il ne compile rien.** Toute modification demande un
  `npm --workspace web run build`, que le lanceur fait a chaque fois.
- **`.wrangler/tmp` ne contient rien qui doive survivre, et grossit indefiniment.** Wrangler y
  ecrit un dossier `bundle-*` par demarrage sans jamais le reprendre : 255 bundles pour 68 Mo au
  moment ou le lanceur a commence a les balayer, avec `.wrangler/state` entierement vide a cote.
  L'etat de la base vit sous `%LOCALAPPDATA%\Prandia\dev-state`, pas la. Le balayage vient
  **apres** l'arret du serveur, celui qui tourne tenant son propre bundle ouvert.
- L'etat local (D1 et R2 simules) vit dans `%LOCALAPPDATA%\Prandia\dev-state`, **hors du projet** :
  le chemin du depot contient une espace et un signe plus, sur lesquels miniflare echoue en
  `SQLITE_CANTOPEN` sans rien expliquer.

## Caméra (web) : `web/src/lib/camera.ts`

Un seul flux caméra pour toute la vie de la page. Ce qui ne se devine pas :

- **Installée sur l'écran d'accueil, la PWA redemandait l'autorisation à chaque ouverture du
  viseur**, parce que chacune appelait `getUserMedia`. C'est un défaut WebKit connu depuis 2018
  (bugs 185448 et 215884). Aucun code web ne peut mémoriser l'autorisation : elle appartient au
  système. On évite seulement de reposer la question. La demande au lancement de l'application,
  elle, reste.
- **Le scanner n'ouvre ni ne coupe jamais la caméra** : il emprunte le flux par
  `camera().acquire()` et le rend par `release()`. Un `track.stop()` ajouté ailleurs ferait
  revenir la demande à chaque scan, sans qu'aucun test d'interface ne le voie.
- **Fermer le viseur DÉSACTIVE les pistes** (`enabled = false`), il ne les arrête pas. L'arrêt
  complet vient après `IDLE_STOP_MS` sans viseur ouvert, ou à la fermeture réelle de la page.
- **Une piste désactivée garde la caméra active pour iOS** : le point vert reste allumé tant
  qu'une piste vit (constaté sur iPhone). `IDLE_STOP_MS` est donc un compromis entre deux gênes,
  le point vert d'un côté, une nouvelle demande d'accès de l'autre. Fixé à 30 secondes après
  qu'un premier réglage à 5 minutes a laissé la caméra allumée hors des scans.
- **ZXing passe par `decodeFromVideoElement`, et c'est voulu** : son `stop()` n'arrête que la
  boucle de décodage, jamais les pistes (vérifié dans `@zxing/browser` 0.1.5). Ses méthodes
  `decodeFromConstraints` et `decodeFromVideoDevice` ouvriraient leur propre caméra, donc leur
  propre demande.
- Vérifié en local avec une fausse caméra : deux ouvertures du viseur, une seule demande, le
  même flux réutilisé.
- **La vidéo est ancrée en absolu aux quatre bords de la scène** (`.scanner__video`). En plein
  écran, la scène tient sa hauteur d'un `flex: 1` dans un parent qui n'a qu'une `min-height` :
  un `height: 100%` n'y trouve rien, la vidéo retombait sur sa taille propre (375 x 500 mesurés
  pour une scène de 375 x 700) et l'iPhone montrait parfois un petit rectangle en haut d'un écran
  noir. Ne pas la remettre dans le flux.

## Se comporter comme une application (web)

Ce qui trahissait une page web sur iPhone, et ce qui le corrige. Ce qui ne se devine pas :

- **La barre d'état est `default`, pas `black-translucent`** (`web/index.html`). Depuis iOS 26,
  une application installée qui passe sous la barre d'état reçoit un flou "Liquid Glass" sur la
  centaine de pixels du haut : l'en-tête, ses icônes et le titre devenaient flous. Aucune règle
  CSS ne le coupe. **iOS ne relit cette balise qu'à l'ajout à l'écran d'accueil** : une icône
  déjà installée garde l'ancien réglage, il faut la supprimer et la rajouter.
- **Conséquence sur la hauteur : `--app-height` vaut `100dvh` partout, sans correction iOS.**
  Avec la barre d'état opaque, la page commence SOUS elle et mesure vraiment la zone visible
  (848 px sur un iPhone 11), alors que `100vh` compte toujours l'écran entier (896). L'ancienne
  correction (`100vh` et `--viewport-drift` en mode installé), juste du temps de
  `black-translucent`, poussait la barre d'onglets 48 px sous le bord. Le diagnostic du Profil
  mesure désormais « Sous la barre » contre `innerHeight`, pas contre l'écran physique.
- La barre d'état opaque est peinte de `theme-color`. Ces balises suivant la préférence du
  téléphone, `alignerBarreEtat()` (`web/src/lib/theme.ts`) les aligne sur le thème choisi dans
  l'application, sinon un thème forcé laissait une barre claire sur un écran sombre.
- **Le rebond se coupe sur `html`, pas sur `body`** : le défilement de la page est celui du
  viewport, que Safari règle d'après l'élément racine seulement. La règle posée sur `body`
  laissait tirer l'écran très loin.
- **Toute zone qui défile porte `overscroll-behavior: none`, jamais `contain`** (corps des
  feuilles, liste de suggestions, rangée de filtres). Les deux arrêtent la propagation à la page
  derrière, mais `contain` laisse le rebond élastique de la zone elle-même : dans la feuille
  plein écran, on tirait le contenu et un vide s'ouvrait sous l'en-tête. Une nouvelle zone qui
  défile doit reprendre `none`.
- **Pas de sélection hors des champs** : `user-select: none` sur `html`, rétabli EXPLICITEMENT
  sur `input`, `textarea` et `contenteditable`. Sans ce rétablissement, iOS peut refuser le
  curseur, la loupe, voire la frappe dans un champ. Le préfixe `-webkit-` reste nécessaire.
- **Pas d'ascenseur au doigt**, mais seulement sous `(hover: none) and (pointer: coarse)` : à la
  souris, l'application s'ouvre aussi sur l'ordinateur, et l'ascenseur y sert.
- **Pas d'anneau de mise au point au doigt** (`:focus-visible`, même requête tactile, en
  `!important`) : Safari iOS le dessinait autour de chaque champ touché, un rectangle de couleur.
  Il reste au clavier sur ordinateur. Les champs signalent leur mise au point par leur bordure ;
  un nouveau champ qui n'est pas un `.field__input` doit en faire autant ET couper l'anneau par
  une règle à DEUX classes, car l'ordre des feuilles dans le paquet construit ne suit pas celui
  des imports (le champ de recherche du choix de repas a perdu contre `:focus-visible`).

## Notifications (web) : `shared/src/notifications.ts`, `worker/src/notifier.ts`

Web Push vers l'application installée, réglé dans `/parametres/notifications` : une case et des
heures par type. Sept types déclarés dans `NOTIFICATION_DEFS` ; trois partent (repas du soir,
planifier la semaine, pesée), les quatre autres sont affichés "bientôt" (`disponible: false`)
et le planificateur ne les atteint pas. Ce qui ne se devine pas :

- **Deux déploiements, pas un.** L'API (abonnement, préférences, test) est dans la Pages
  Function et part avec le push sur `main`. La PLANIFICATION est un Worker à part,
  `prandia-notifier` (`notifier/wrangler.toml`), sans route : Pages ne sait pas déclencher une
  action à heure fixe. Il se déploie par `npx wrangler deploy --config notifier/wrangler.toml`,
  jamais tout seul, et **AVANT le site** la première fois : le site se lie à sa classe
  `Horloge`. Une modification de `notifier.ts`, de `push.ts` ou du calcul des heures demande
  les deux déploiements.
- **Pas de déclencheur horaire (cron), et c'est forcé.** Le plan gratuit borne le COMPTE à cinq
  crons, tous pris par d'autres projets : le premier déploiement a été refusé. L'horloge est un
  **Durable Object** (stockage SQLite, le seul du plan gratuit) dont l'alarme sonne toutes les
  cinq minutes, sur un multiple rond (`prochainReveil`). Elle se **re-arme AVANT de travailler**
  et le travail ne lève jamais : lever ferait rejouer l'alarme par le runtime, ne pas se
  re-armer la perdrait. Un test garde l'ordre, vu échouer à l'envers.
- **Une alarme jamais posée ne sonne jamais.** L'API remonte l'horloge (`horloge.ts`) à chaque
  ouverture de l'écran Notifications, à chaque réglage et à chaque abonnement. C'est idempotent :
  une alarme qui attend n'est pas déplacée, sans quoi rouvrir l'écran décalerait les passages.
  Une chaîne rompue se répare donc d'elle-même à la visite suivante. L'appel est au mieux : en
  local, sans le Worker `notifier` lancé, l'écran fonctionne quand même.
- **La clé privée VAPID est un secret, posé DEUX fois** : dans le projet Pages (le bouton
  "Envoyer un test") et dans le Worker planifié. La clé publique est dans les deux
  `wrangler.toml` et doit rester la même : changer de paire désabonne en silence tous les
  appareils, qui ont signé leur abonnement avec l'ancienne. Le sujet est l'URL du site, jamais
  une adresse mail : le dépôt est public. En local, `.dev.vars` porte une paire DIFFÉRENTE.
- **`@block65/webcrypto-web-push` est figé en 2.0.0, et la 1.x ne marche pas chez Apple** : elle
  chiffre en `aesgcm` et signe en `WebPush`, deux formats anciens que le service d'Apple
  refuse. La 2.0.0 fait `aes128gcm` (RFC 8291) et `vapid t=, k=` (RFC 8292). Elle exige
  `--main-fields=module,main` dans `build:api`, sans quoi esbuild ne résout pas une de ses
  dépendances.
- **Réserver AVANT d'envoyer est la seule garantie contre le doublon.** Le planificateur pose la
  clé dans `notification_log` par `INSERT OR IGNORE`, et seul le passage qui obtient
  `changes = 1` compose et envoie. Un envoi qui échoue après la réservation n'est pas retenté :
  une notification manquée vaut mieux qu'une notification reçue en double, qui fait désactiver
  toutes les autres. "Rien à dire" (déjà pesé, semaine suivante remplie) garde la clé posée.
- **Les heures sont celles de Paris, le Worker tourne en UTC.** `parisClock` passe par
  `Intl.DateTimeFormat` avec `Europe/Paris`, jamais par un décalage fixe : deux heures l'été, une
  l'hiver. Une heure n'est due que dans les 60 minutes qui la suivent (`CATCH_UP_MIN`) :
  activer la pesée à 17 h n'envoie pas celle de 7 h 30. Les tests couvrent le changement d'heure
  et minuit à Paris, qui n'est pas minuit en UTC.
- **L'absence de ligne vaut "désactivé"**, jamais "activé par défaut". Une notification
  qu'on n'a pas demandée fait couper toutes les autres.
- **Sur iPhone, seule l'application INSTALLÉE peut s'abonner** (iOS 16.4 et plus) : dans un
  onglet de Safari, `PushManager` n'existe pas, et l'écran le dit au lieu d'offrir un bouton
  inerte. L'autorisation se demande après un TOUCHER, jamais au chargement. Une fois refusée,
  l'application ne peut plus la redemander : seul le réglage du téléphone la rend.
- **L'abonnement appartient à l'APPAREIL, les préférences à la PERSONNE.** Un `endpoint` est
  `UNIQUE` : un téléphone qui change de compte change de propriétaire, il ne reçoit pas les
  rappels des deux. Un 404 ou 410 du service supprime l'abonnement aussitôt.
- **`web/public/push-sw.js` est importé dans le service worker généré** (`importScripts` dans
  `vite.config.ts`). Sans lui, une notification arriverait sans que rien ne sache l'afficher ni
  ouvrir l'écran visé au toucher.

## Common commands

```bash
# Install (editable + dev deps)
pip install -e ".[dev]"

# Run the app
python -m app.main

# Or, on Windows, just double-click run.bat (handles venv + deps + launch)

# Run all tests
pytest

# Run a single test
pytest tests/test_nutrition.py::test_aggregate_recipe_basic

# Lint
ruff check app tests

# Format
ruff format app tests

# (Re)seed CIQUAL 2025 — idempotent, safe to rerun
python -m app.data.seeds.ciqual_loader
```

The SQLite DB lives at `prandia.db` at the repo root by default (override via `PRANDIA_DB_PATH` env var). It is git-ignored — every dev gets a fresh empty DB and seeds CIQUAL on first launch.

## Architecture — the 4 layers, in dependency order

```
domain   <-- pure Python, no Qt, no SQLAlchemy. Pydantic models + pure functions.
data     <-- SQLAlchemy ORM + repositories. Imports domain (for return types).
services <-- orchestration. Imports domain + data + external APIs.
ui       <-- ViewModels (Python/QObject) + QML files. Goes through services for
             cross-layer work, but may use repositories directly for trivial
             reads/writes (kept inside the viewmodel — never inside QML).
```

Rules to keep this structure honest:

- `app/domain/` must not import anything from `app/data/`, `app/services/`, `app/ui/`, `PySide6`, or `sqlalchemy`. If a "domain" function needs a session, it's a service.
- QML files (`app/ui/qml/`) must not open a DB session themselves — they go through their viewmodel via a context property (`ingredientVM`, `recipeListVM`, `recipeEditorVM`, `calendarVM`). ViewModels open sessions via `AppContext.session()` (see `app/ui/app_context.py`).
- ViewModels are `QObject` subclasses (with `@QmlElement` for type registration) that expose state via `Property` and accept calls via `@Slot`. They live in `app/ui/viewmodels/` and own short-lived sessions: every mutation opens, commits, closes (`with ctx.session() as s:`). This avoids the classic stale-identity-map issues from long-lived sessions.
- Lists exposed to QML go through `QAbstractListModel` subclasses in `app/ui/models/`. The viewmodel owns a model instance via composition (not inheritance) and exposes it as a `Property(QObject, constant=True)`. The model is `set_items()`-mutated on refresh — full reset, not granular `dataChanged`.

Adding a new page: create `app/ui/qml/pages/<Feature>Page.qml`, register it in `app/ui/qml/Main.qml` (just add a third element in the `StackLayout` and a fourth `AppTabButton` in the `TabBar`). The viewmodel goes in `app/ui/viewmodels/<feature>_vm.py` and is exposed as a context property in `app/main.py`.

## QML structure

```
app/ui/qml/
├── Theme.qml                     # singleton (pragma Singleton + qmlRegisterSingletonType)
├── Main.qml                      # ApplicationWindow + MenuBar + TabBar + StackLayout
├── components/
│   ├── AppButton.qml             # 4 variants: primary / secondary / ghost / danger
│   ├── AppTabButton.qml          # tab with bottom-border selection indicator
│   ├── AppTextField.qml
│   ├── AppComboBox.qml           # delegate handles ListModel (multi-role) AND string array
│   ├── AppSpinBox.qml            # decimal + emptyOnZero option
│   ├── AppCheckBox.qml
│   ├── AppScrollBar.qml          # fine, fades in on hover
│   ├── AppListItem.qml           # selection bar on the left
│   ├── AppDialog.qml             # in-window modal (rarely used — see dialogs/)
│   ├── AppPopup.qml              # autocomplete popups
│   ├── AppMenu.qml               # styled Menu + MenuItem delegate (no native black)
│   ├── FixedUnitField.qml        # spinbox + read-only unit cell
│   ├── QuantityField.qml         # spinbox + unit dropdown, **piece-aware**
│   ├── IngredientSearch.qml      # textfield + suggestions popup, debounced 200 ms
│   ├── NutritionPanel.qml        # 4 colored chips (kcal / P / G / L)
│   └── MealSlot.qml              # calendar cell, entire surface clickable to add
├── pages/
│   ├── IngredientsPage.qml
│   ├── RecipesPage.qml
│   └── CalendarPage.qml
└── dialogs/
    ├── ImportIngredientDialog.qml     # detachable Window (system-level)
    └── AddCalendarEntryDialog.qml     # detachable Window (system-level)
```

**Theme registration** (`app/main.py`): `Theme.qml` MUST start with `pragma Singleton` and is registered via `qmlRegisterSingletonType(themeUrl, "App", 1, 0, "Theme")`. Other QML files import it with `import App` and use `Theme.colorPrimary`, `Theme.spaceMd`, etc. Context-property registration was tried first but doesn't propagate into MenuBar / Popup / Window sub-trees — singleton is mandatory for global access.

**Dialogs as Windows**: `ImportIngredientDialog` and `AddCalendarEntryDialog` are real `QtQuick.Window` objects, not `Dialog` (which is in-window). They're top-level system windows: detachable, draggable outside the main app, non-modal. Use the helper `openCentered(parentWindow)` / `openFor(...)` to position them at the parent's center.

## Data model — non-obvious points

- **All quantities are normalized to grams** in `recipe_ingredient.quantity_g` and `meal_plan_entry.quantity_g`. Unit conversion is done at the UI boundary by `app/ui/qml/components/QuantityField.qml` (value + unit dropdown) and `app/domain/units.py` (table). Storage stays in grams.
- **Nutrition is stored per 100 g** on `ingredient` (CIQUAL convention). Aggregation always passes through `domain/nutrition.py` — do not re-implement the formula in viewmodels.
- **`meal_plan_entry` uses XOR**: exactly one of `recipe_id` / `ingredient_id` is set. Enforced at the repository layer (the DB-level CHECK is too painful with SQLAlchemy migrations); a `MealPlanEntry` Pydantic validator also rejects the malformed case.
- **`iso_week` is the natural key** for the calendar (`'2026-W18'`). Don't store dates — store ISO week + day-of-week (0=Monday, 6=Sunday). This survives DST, makes "this week" trivial, and indexes well.
- **`ingredient.source`**: `'ciqual' | 'openfoodfacts' | 'manual'`. `source_ref` is the CIQUAL `alim_code` or the EAN barcode. Manual ingredients have `source_ref = NULL`.
- **`ingredient.in_personal_library`** (boolean, added later via inline migration) separates the user's *curated working set* from the catalog rows. CIQUAL/OFF rows are seeded with `False` — they exist locally but **don't show up** in the Ingredients tab. The user picks them via the Import dialog or the recipe/calendar pickers, which flip the flag to `True`. Removing a CIQUAL/OFF row from the personal library only flips the flag back; manual rows are hard-deleted.
- **`ingredient.category_l1` / `category_l2`** (TEXT, added by inline migration in `db.py`) hold CIQUAL's `alim_grp_nom_fr` and `alim_ssgrp_nom_fr`. Used to populate the category dropdown of the Import dialog. NULL for OFF and manual rows.
- **`ingredient.piece_weight_g`** (REAL, nullable, added by inline migration `_migrate_add_piece_weight`) is the gram weight of one "piece" — 1 egg ≈ 60 g, 1 onion ≈ 150 g, 1 garlic clove ≈ 5 g. When non-NULL, the `QuantityField` in QML pickers exposes a "pièce (60 g)" entry at the top of its unit dropdown and switches to it automatically. When NULL, no piece unit is offered (oils, milk, rice, salt, …). Editable via the Ingredient form's "Poids unitaire" field.
- **Inline migrations** : evolutions of the `ingredient` schema use idempotent `_migrate_*` functions in `app/data/db.py` (`PRAGMA table_info` then `ALTER TABLE ADD COLUMN`). No Alembic. Each new column gets its own migration; running them is part of `init_schema()`. Current migrations: `_migrate_add_in_personal_library`, `_migrate_add_categories`, `_migrate_add_piece_weight`.

## ViewModels exposed to QML

Each VM is registered with `@QmlElement` (module `App.ViewModels`) and instantiated Python-side in `app/main.py`, then exposed as a context property:

| Context property | Class | Purpose |
|---|---|---|
| `ingredientVM` | `IngredientViewModel` | Bibliotheque personnelle + import OFF / CIQUAL |
| `recipeListVM` | `RecipeListViewModel` | Liste des recettes |
| `recipeEditorVM` | `RecipeEditorViewModel` | Buffer d'edition d'une recette en cours |
| `calendarVM` | `CalendarViewModel` | Semaine ISO courante + entrees + agregats |

**Conventions for VM↔QML**:

- `Property(QObject, constant=True)` named `items` / `entries` exposes the list model. `constant=True` because we reset the inner model (not its identity) on refresh.
- Slots use `camelCase` (Qt convention from QML) — wrappers around the snake_case Python methods (`refreshList()` → `refresh()`, `getAsDict(id)` → `get(id)` + dict conversion). Both APIs coexist; tests use the Python one.
- Decimal → str. QML doesn't know `decimal.Decimal`; prices are serialized as strings (e.g. `"12.0000"`) and formatted in QML via `Number(parseFloat(x)).toLocaleString(Qt.locale(), 'f', 2)`.
- Pydantic enums (`Source`, `MealSlot`) → `.value` (str) at the role boundary.
- For "save" operations, QML passes a `QVariantMap` (JS object) to `saveFromDict(payload)`. Python validates via Pydantic, persists, returns the saved row as a dict.

## Ingredient search — two distinct flows

### `IngredientSearch` (Recipes / Calendar pickers)

`app/ui/qml/components/IngredientSearch.qml` — the live picker used inside the Recipes editor and the Calendar add dialog. Behavior:

- 200 ms `Timer` debounce on `onTextChanged` — never query on every keystroke.
- Query goes to `ingredientVM.searchOnce(query, scope, limit)` (a `@Slot` returning `QVariantList` of dicts), which runs FTS5 against the local DB. **No HTTP call from the keystroke path** — slow and OFF rate-limits.
- **Default scope is `'personal'`**: the picker only suggests ingredients already in the user's personal library. CIQUAL/OFF source rows do not pollute recipe/calendar composition.
- Keyboard navigation built-in (Up / Down / Enter / Escape).
- Each suggestion shows a colored source badge (CIQUAL green / OFF blue / manuel amber) and, when relevant, a "● 1 pc = X g" indicator for piece-aware ingredients.

### `ImportIngredientDialog` (the explicit catalog browser)

`app/ui/qml/dialogs/ImportIngredientDialog.qml` — opened from the Ingredients tab via "Importer un ingrédient". Real `Window` (detachable / draggable / non-modal). Two tabs (CIQUAL local, OpenFoodFacts online):

- **CIQUAL tab**: debounced 250 ms search via `ingredientVM.searchBySource(query, "ciqual", 50)`.
- **OFF tab**: explicit "Chercher en ligne" button (no debounce — OFF is rate-limited). Calls `ingredientVM.fetchOnlineAndList(query, 30)` which hits Search-a-licious, caches results in DB, returns dicts.
- Result list: card per ingredient with star "🌟" prefix when already in the personal library, "+ Ajouter" button per row.
- Double-click or "+ Ajouter" → `ingredientVM.importExisting(id)` flips `in_personal_library = True`.
- Filter panel + pagination + sort were on the old QtWidgets dialog and will return as Phase 4+ polish — current QML version is intentionally simpler.

The Ingredients tab itself filters via a plain top-of-list `AppTextField` that calls `ingredientVM.setFilter(text)`.

### Search options API (`app/data/repositories.py`)

`IngredientRepo.search_fts` accepts a `SearchOptions` dataclass for the rich case (filters + sort + pagination), or a positional `(query, limit, *, scope, source)` for the legacy picker case. Returns `SearchPage` (matches + total_count + page metadata). Sort fields: `'rank' | 'name' | 'kcal' | 'proteins' | 'carbs' | 'fats'`, all with `sort_desc` flag.

### OpenFoodFacts: client-side macro sort

Search-a-licious **rejects** macro fields as `sort_by` (HTTP 400). `_OFF_SORT_MAP` whitelists only `product_name` and popularity-style fields. For macro sorts, the dialog post-sorts the page client-side and shows a hint that the sort is page-local (not over the full result set).

## CIQUAL seeding

The ANSES file lives under `app/data/seeds/`. The loader (`ciqual_loader.py`) **auto-detects** the format from the extension — `.xls` (binary OLE2, requires `xlrd<2.0`), `.xlsx` (requires `openpyxl`), or `.csv` (`;` separator, decimal comma). The user puts the file there manually; the project's `pyproject.toml` declares `xlrd<2.0` as a runtime dependency so the most common case (the .xls export from ciqual.anses.fr) works out of the box.

The loader is **idempotent**: it uses `IngredientRepo.upsert_by_source_ref` matched on `(source='ciqual', source_ref=alim_code)`. Rerunning **updates** existing rows (refreshing nutrition/category data if ANSES publishes a fix) **without** clobbering the user's `in_personal_library` flag — that's preserved across re-seeds via an explicit guard in the loader.

Empty / `-` / `traces` / `<X` cells must be parsed to `None` or 0 respectively — never raise.

CIQUAL header normalization (`_norm`): the 2025 .xls headers contain `\n` characters and lack the `/` in `(kcal/100 g)`. The loader normalizes via lowercase + strip + accent-folding + `[/\n\t]` → space + collapse-whitespace, then matches against `_COLUMN_CANDIDATES`. Add a new candidate string when ANSES changes a header in a future release.

## OpenFoodFacts client

`app/services/openfoodfacts.py`. Two distinct hosts:

- **Barcode lookup** : `world.openfoodfacts.org/api/v2/product/{ean}` via `lookup_barcode(ean) -> Ingredient | None`. Stable.
- **Free-text search** : `search.openfoodfacts.org/search` (Search-a-licious — OFF's dedicated search backend). The legacy `/cgi/search.pl` and `/api/v2/search` endpoints on the main host are saturated and return 503 most of the time.

`search_by_name(query, *, page=1, page_size=25, sort_by=None, filters=None) -> tuple[list[Ingredient], int]`. Returns `(matches, total_count)` — total comes from the API's `count` field.

- `filters` is a plain dict mirroring `SearchFilters` shape: `min_proteins`, `max_proteins`, `category_tag`, etc. The function builds a Lucene-style `q` (e.g. `tomate AND nutriments.proteins_100g:[10 TO *] AND categories_tags:"fr:legumes"`).
- `sort_by` accepts internal codes (`name_asc`, `name_desc`, `proteins_desc`, …) mapped via `_OFF_SORT_MAP`. **Macro sorts are mapped to `None`** because the API rejects `nutriments.*` as a sort key; the import dialog handles the fallback by sorting client-side (page-local) and informing the user.

Empty query AND no filters → return `([], 0)` without hitting the API (avoids `*:*` paging through OFF's millions of products).

Both functions return Pydantic `Ingredient` models. The HTTP client sends `User-Agent: prandia/0.1.0 (+https://github.com/MarckuusS/prandia)` — OFF rate-limits anonymous clients harder. `langs=fr,en` is always passed for French support.

## Testing conventions

- Domain tests use plain `pytest` — no fixtures needed beyond literal Pydantic instances.
- Repository tests use a SQLite in-memory engine via the `db_session` fixture in `tests/conftest.py`. They run the schema init + FTS5 setup but **do not seed CIQUAL** — too slow.
- UI tests : not yet written for QML. Prefer testing the viewmodel's Python API (`vm.refresh()`, `vm.items.rowCount()`, `vm.items.data(idx, NameRole)`) — this is enough for the data flow. Pure QML rendering can be tested later with `QQuickWidget` + `QtTest::QSignalSpy` if needed.

## Shared widgets — quick reference

All in `app/ui/qml/components/`:

- **`QuantityField.qml`** — spinbox + unit combobox, **piece-aware**. Property `pieceWeightG: real` (0 = no piece unit; > 0 = adds "pièce (Xg)" entry at top of dropdown). Stores grams internally regardless of selected unit. Switching unit preserves the gram amount (1000 g → kg → reads `1.0`). Used in Recipes editor (Ajouter ingrédient + each line of the table), Calendar add dialog, Ingredients tab (Quantité de référence du prix). Static unit table mirrors `app/domain/units.py`.
- **`FixedUnitField.qml`** — spinbox + read-only unit cell on the right. Used for the Ingredients tab macro fields (`g/100g`, `kcal/100g`) and the "Poids unitaire" field. The inner `AppSpinBox` has `emptyOnZero: true` so a zero value renders as **empty** (not `0.0`).
- **`AppButton.qml`** — 4 variants: `"primary"` (full color fill), `"secondary"` (border only), `"ghost"` (no chrome), `"danger"` (red text on transparent — used for ✕ remove buttons). Auto-handles disabled state, focus ring, hover/pressed transitions.

## Theme system (`Theme.qml`)

Singleton with all design tokens. Key categories:

- **Palette**: `colorPrimary` / `colorSecondary` / `colorAccent` / `colorError` / `colorSuccess` / `colorWarning` (each with hover / pressed / disabled variants where applicable), `colorBackground` / `colorSurface` / `colorSurfaceHover` / `colorSurfacePressed`, `colorText` / `colorTextSecondary` / `colorTextDisabled` / `colorTextPlaceholder`, `colorBorder` / `colorBorderHover` / `colorBorderFocus`.
- **Typography**: `fontFamily` (platform-aware Segoe UI / SF Pro / Inter), `fontSizeXs/Sm/Md/Lg/Xl/Title`, `fontWeightRegular/Medium/SemiBold/Bold`.
- **Spacings**: `spaceXs=4 / Sm=8 / Md=12 / Lg=16 / Xl=24 / Xxl=32` (multiples of 4).
- **Radii**: `radiusSm=4 / Md=6 / Lg=10 / Xl=14 / Full=9999`.
- **Animations**: `durationFast=150 / Normal=250 / Slow=400` (ms), easing curves.
- **Shadows**: stacked `Rectangle` opacities (no MultiEffect dependency).
- **Mode toggle**: `darkMode: bool` — flip with `Theme.darkMode = !Theme.darkMode` (also in the Affichage menu, Ctrl+Shift+D). Every color reads `darkMode ? "#xxx" : "#yyy"`.
- **Helpers**: `formatMnemonic(text)` converts Qt's `&X` shortcut markers into HTML `<u>X</u>` (use with `textFormat: Text.RichText`).

## What this project is NOT (avoid scope creep)

> **Stale section — this was the MVP scope of April 2026.** Most of what it excludes has since been
> built (shopping list, recipe photos, dietary tags, pantry, price history, receipt import, recipe
> import by URL). And the three biggest exclusions were reversed on 2026-08-01:
> **mobile companion**, **cloud sync** and **camera barcode scanning** are now the whole point of the
> project — see "Project direction" at the top. Treat the list below as history, not as a rule.

Still genuinely out of scope: PDF export, ingredient deduplication.

A barcode scanner gun (HID) the user may eventually plug in behaves as a keyboard — no special integration code needed.

## When in doubt

- Check `architecture.md` for the bigger picture and current state of evolution.
- French is the user-facing language. Code, comments, and tests are in English.
- Phases of the QML migration (Foundation → ViewModels → Pages → Polish) are documented in `architecture.md` under "QML migration history" if you need to understand why a given decision was made.

---

<!-- Consigne commune ajoutée le 2026-08-18 par l'installation du catalogue. Tout ce qui précède est d'origine. -->

# Consignes communes du catalogue (FICHE.md et JOURNAL.md)

Modèle : application. Ce projet suit la convention commune de `_modele/` : une fiche `FICHE.md`, un journal `JOURNAL.md`, et c'est toi qui les tiens à jour.

## Au début de chaque session
1. Lire `FICHE.md` (fiche d'identité) puis `JOURNAL.md` (historique, dernière entrée en haut).
2. Si des champs de `FICHE.md` sont vides ou valent `AAAA-MM-JJ`, les renseigner : déduire ce qui peut l'être, demander le reste. Pour `id`, proposer une valeur au format `AAAA-MM-JJ-slug` et attendre validation avant de l'écrire.

## En fin de session
1. Ajouter une entrée datée en haut de `JOURNAL.md` : ce qui a été fait, les décisions prises, ce qui reste à faire.
2. Mettre `maj` à jour dans `FICHE.md` avec la date du jour.
3. Si l'état ou la prochaine étape a changé, mettre à jour les sections `État actuel` et `Prochaine étape`. Si le statut a changé, mettre à jour `statut`.

## Règles
- `id` ne se modifie jamais, même si le dossier est renommé, déplacé ou archivé.
- L'en-tête YAML de `FICHE.md` reste simple : une valeur par ligne, listes entre crochets, pas de bloc multi-lignes. Les noms de champs et les valeurs d'énumération restent en ASCII sans accent.
- Pas d'autre fichier de métadonnées (pas de NOTES.md, pas de README parallèle) : tout passe par `FICHE.md` et `JOURNAL.md`. Si un `README.md` est nécessaire (dépôt publié), il reste court et ne remplace pas `FICHE.md`.
- Dans les fichiers Markdown, écrire en français accentué. Une phrase ou un paragraphe tient sur une seule ligne, sans retour à la ligne intermédiaire.
- Dossiers : `src/` pour le code, `tests/` pour les tests, `docs/` pour la documentation. Aucun dossier protégé.
