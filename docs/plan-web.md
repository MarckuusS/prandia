# Plan d'implémentation web

Établi le 2026-08-09 à partir de [parite/ecarts-web.md](parite/ecarts-web.md).
Priorités arbitrées avec l'utilisateur le même jour.

Ordre retenu : **lot 0** (ce qui ment), **lot 1** (interfaces sur API existante), **lot 2** (photos
de recette). Le reste est nommé au chapitre 4, avec la raison du report.

---

## Lot 0 : réparer ce qui ment

Neuf corrections sur du code déjà écrit, qui produit aujourd'hui un chiffre faux, une phrase fausse
ou une impasse. Une seule touche au serveur.

### 0.1 Le coût de la semaine est sous-estimé et annoncé comme sûr

`web/src/screens/semaine/totals.ts:137-153`. `missingCount` ne s'incrémente que si le coût de
l'entrée entière est `null`. Une recette dont 2 ingrédients sur 5 n'ont pas de prix passe donc pour
complète.

Faire remonter le nombre de **lignes** sans prix, comme le desktop. `mealPlanEntryCost` doit rendre
le compte de lignes non valorisées en plus du total, ou `entriesCost` doit descendre dans les lignes
de la recette. Puis afficher l'avertissement dès que ce compte dépasse zéro, en distinguant les deux
cas dans le libellé : "coût partiel, N ingrédients sans prix" plutôt que "N repas sans prix".

Effort : faible. Fichiers : `totals.ts`, `shared/src/pricing.ts`, la carte Coût de `WeekScreen.tsx`.

### 0.2 Le bandeau du Frigo promet deux choses fausses

`web/src/screens/PantryScreen.tsx:101`. Le texte affirme que le stock est "retranché de ta liste de
courses" et qu'un ingrédient couvert "y arrive coché". L'agrégation estampille `inPantryG` et
`isCoveredByPantry` sans rien retrancher, et la ligne arrive décochée.

Réécrire les deux phrases pour décrire ce que le code fait vraiment : le frigo **signale** les
lignes déjà couvertes et propose de les cocher d'un geste.

Effort : faible, purement rédactionnel.

### 0.3 Perte de précision au-delà du kilo

`shared/src/units.ts:104-112`. `formatGrams` donne "1,3 kg" là où le desktop donnait "1,25 kg", et
"2,5 kg" pour 2450 g. L'écart atteint 50 g par ligne, et se propage à la liste de courses, au texte
partagé, à l'écran de session et au frigo.

Porter la règle à trois branches du QML (`app/ui/qml/pages/ShoppingPage.qml:288-306`) : au-dessus
de 1 kg, 2 décimales sous 10 kg et 1 au-delà ; entre 10 g et 1 kg, entier ; sous 10 g, 1 décimale.
**Verrouiller par un test** dans `shared/src/units.test.ts` : aucun test ne garde cette équivalence
aujourd'hui, ce qui explique la dérive.

Effort : faible.

### 0.4 Le mode sombre ne sait plus revenir au suivi système

`web/src/lib/theme.ts:62-64`. `toggle` bascule entre `light` et `dark` seulement. L'état `system`,
qui est celui du premier lancement, devient inatteignable dès le premier appui.

Faire tourner le bouton sur les trois états, ou exposer `setChoice` dans les Réglages avec un choix
Clair / Sombre / Système. La seconde option est plus lisible et la page existe déjà.

Effort : faible.

### 0.5 Un tag créé ne peut plus être renommé ni supprimé

Le web a ouvert la création sans ouvrir la correction. Une faute de frappe reste pour toujours dans
la rangée de filtres. `PUT /api/tags/:id` et `DELETE /api/tags/:id` existent déjà et ne sont appelés
par aucun hook.

Ajouter l'édition dans `RecipeTags.tsx` : appui long ou bouton crayon sur la pastille, feuille avec
nom, couleur et suppression. Prévenir que la suppression détache le tag de toutes les recettes.

Effort : faible. API : déjà servie.

### 0.6 Aucun onglet actif au lancement de la PWA

`web/src/App.tsx:98`. `/` rend `ShoppingScreen`, mais le `NavLink` actif est `/courses`. Le
`start_url` du manifeste vaut `/`, donc l'app installée s'ouvre sans onglet en surbrillance.

Rediriger `/` vers `/courses`, ou marquer l'onglet Courses actif sur les deux chemins.

Effort : faible.

### 0.7 Un homonyme du catalogue bloque une création, sans issue

Le contrôle de doublon porte sur toute la table du foyer, catalogue CIQUAL compris, là où le desktop
ne comparait qu'aux ingrédients manuels. Créer "Tomate" est refusé en désignant une fiche CIQUAL que
l'utilisateur ne voit nulle part.

Deux corrections liées. Côté serveur, restreindre la détection aux lignes de la bibliothèque
personnelle (`in_personal_library = 1`) ou signaler explicitement le cas "existe au catalogue, pas
dans ta bibliothèque". Côté client, lire `extra.existingId` que le 409 renvoie déjà et proposer
"Ouvrir la fiche existante" plutôt que de laisser l'utilisateur bloqué.

Effort : faible. Fichiers : `worker/src/routes/ingredients.ts:35-46`, `repos/ingredients.ts:250-258`,
`web/src/screens/ingredients/IngredientForm.tsx`.

### 0.8 Retirer un lot du frigo est définitif, et "Tout" ne demande rien

Le raccourci "Tout" supprime le lot en un seul appui, sans confirmation, dans une grille de trois
boutons identiques. Aucune annulation ensuite. `Toast.showUndo` existe et sert déjà à l'écran
Semaine pour exactement ce cas.

Brancher `showUndo` sur le retrait et sur la consommation totale. La restauration recrée le lot avec
un nouvel identifiant, ce qui est acceptable pour un lot de frigo.

Effort : faible. Fichiers : `web/src/screens/frigo/LotSheet.tsx`, `PantryScreen.tsx`.

### 0.9 Deux appareils qui éditent la même recette : le dernier écrase l'autre

Le seul point du lot 0 qui touche au serveur, et le plus important des neuf : c'est la promesse même
du portage (téléphone et bureau sur les mêmes données) qui est trahie en silence.

`recipe.updated_at` existe déjà en base (`migrations/0001_core.sql:78`). L'exposer dans la réponse
de `GET /api/recipes/:id`, le renvoyer dans le corps du `PUT`, et refuser en 409 quand il ne
correspond plus à la valeur en base. Côté client, transformer le 409 en question explicite :
"Cette recette a été modifiée ailleurs. Recharger, ou écraser ?"

Le même motif servira ensuite pour le frigo et le calendrier, qui ont tous `updated_at`.

Effort : moyen. Fichiers : `worker/src/routes/recipes.ts:39-57`, `repos/recipes.ts`,
`web/src/lib/queries.ts`, `RecipeEditor.tsx`.

---

## Lot 1 : les interfaces dont l'API existe déjà

Le meilleur rendement de tout l'audit. Regroupé par nature du travail, pas par écran.

### 1.a Les visuels manquants

Ce sont les écarts qui ont motivé l'audit. Aucun ne demande de route nouvelle.

| Visuel | Source de données | Effort |
|---|---|---|
| Courbe d'évolution du prix au 100 g | `GET /api/ingredients/:id/prices`, déjà appelée | moyen |
| Histogramme du coût hebdomadaire, avec moyenne | `GET /api/shopping-history`, déjà appelée | moyen |
| Pictogrammes de nutriments du formulaire ingrédient | `NutrientLabel.tsx` existe et sert ailleurs | faible |
| Tableau 8 nutriments x 7 jours du calendrier | Données déjà chargées, agrégation client | faible |
| Vue d'ensemble de la semaine au-delà de 1024 px | CSS seul, aucune donnée nouvelle | moyen |

Le SVG de `MacrosDonut` donne le patron : tracé maison, sans librairie, légende textuelle permanente
plutôt qu'un survol.

Note sur la vue semaine : `web/src/styles/week.css` est le seul fichier de style d'écran sans aucune
règle de largeur, alors que Recettes, Ingrédients, Frigo et Session en ont toutes une. Ouverte sur un
navigateur de bureau, la page reste une colonne d'un seul jour.

### 1.a bis Le jeu d'icônes — livré le 2026-08-10

Les émojis ont disparu de l'interface web. Ils posaient trois problèmes qu'aucune retouche de CSS ne
réglait : leur dessin change d'un appareil à l'autre (le 🥕 d'un iPhone n'est pas celui d'un
Android), ils gardent leurs couleurs propres en thème sombre, et il n'existe pas d'émoji pour
"rayon boucherie".

**67 icônes** dans `web/src/icons/` : **10 rayons** et 57 d'interface. Les dessins viennent de
[Lucide](https://lucide.dev) (version figée 0.469.0, ISC + MIT pour ce qui dérive de Feather ;
`LICENSE-lucide.txt` est à conserver, le dépôt est public). Ils ont remplacé un jeu dessiné à la
main, qui aurait demandé d'être maintenu à chaque icône manquante et aurait vieilli seul.

Pas de dépendance `lucide-react` : le paquet laisse chaque icône poser ses propres attributs, ce que
`Icon.tsx` interdit. On prend les chemins, on garde le cadre — ce qui permet au passage de rendre à
1,6 d'épaisseur ce que Lucide publie à 2. `paths/*.ts` est **généré** par
`scripts/import-lucide.mjs` ; une retouche à la main serait écrasée.

Coût dans le bundle : **3,9 ko gzip**, contre 58 ko pour les seuls huit pictogrammes PNG de
nutriments.

**Un SVG par rayon, aucun par aliment.** Un dessin par ingrédient obligerait à en ajouter un à
chaque produit scanné, et à faire deviner par une table de mots-clés ce que contient un nom
commercial. Cette table se trompe en silence : elle rend un dessin plausible mais faux, ce que
personne ne va vérifier. Le rayon, lui, est une donnée que l'ingrédient porte déjà.

- `Icon.tsx` pose les attributs communs une fois pour toutes — aucune icône ne peut dériver du
  système en redéfinissant les siens.
- `resolve.ts` va du libellé de rayon à son icône, par fragment reconnu sur un libellé normalisé :
  "Primeur" et "Fruits et légumes" tombent sur le même dessin. Rayon vide ou inconnu → cagette.
- Chaque rayon porte une teinte (`web/src/styles/icons.css`, attribut `data-rayon`). C'est ce qui
  permet de balayer une liste de courses en cherchant "le vert" plutôt qu'en lisant chaque ligne.
- Galerie de contrôle : **Paramètres → Jeu d'icônes**, qui liste aussi les rayons réellement
  présents dans la bibliothèque et combien d'ingrédients n'en ont aucun.
- `node scripts/export-icons.mjs` régénère `docs/icones/` (fichiers `.svg` autonomes + galerie HTML).
  Robinet à sens unique : éditer un `.svg` exporté n'a aucun effet sur l'application.

Où les icônes apparaissent : les cinq onglets, l'en-tête, les en-têtes de section de la liste de
courses, les lignes de la bibliothèque d'ingrédients, le sélecteur d'ingrédient et les repas de la
semaine. **Pas** sur les lignes de la liste de courses : elles sont déjà groupées par rayon, et
répéter l'icône de l'en-tête sur chacun de ses articles n'ajouterait que du bruit.

Reste ouvert : les pictogrammes de nutriments sont toujours des PNG (`web/public/icons/nutrient/`).
Les redessiner dans le même système supprimerait 58 ko et huit requêtes.

### 1.b Le catalogue CIQUAL redevient exploitable

- **Pagination** : `GET /api/catalog` accepte déjà `limit` (max 200) et `offset` et renvoie
  `totalCount`. Aujourd'hui on ne dépasse jamais les 50 premières lignes. Un rayon de 300 entrées est
  inatteignable au-delà de la lettre C. Effort faible.
- **Tri** : aucun choix, toujours par nom croissant. Ajouter les tris macro, côté serveur.
  Effort faible.
- **Filtres macro** : les quatre plages min/max ont disparu. C'est ce qui rend 3 000 entrées
  utilisables. Ajouter les bornes à la route. Effort moyen.
- **Menu Catégorie** : liste toutes les valeurs de `category_l1` du foyer, donc les rayons
  supermarché de l'utilisateur mélangés aux groupes ANSES. Choisir un rayon personnel dans l'onglet
  CIQUAL donne zéro résultat. Ajouter un paramètre `source` à `GET /api/categories`. Effort faible.
- **Sélectionner la page** et **Réinitialiser les filtres**. Effort faible.

### 1.c La bibliothèque d'ingrédients

- **Filtres macro** sur les six axes. Les données sont déjà chargées, le filtrage est client.
- **Les pastilles de rayon des filtres** sont calculées sur les résultats de la recherche en cours,
  donc déjà filtrés. Chercher "tomate" puis ouvrir les filtres ne propose que les rayons des tomates,
  et un rayon actif absent des résultats continue de filtrer sans pastille pour le désactiver. Les
  alimenter depuis `GET /api/categories`.
- **Persistance des options de vue** dans `localStorage`. Elles vivent aujourd'hui en query string
  seulement : elles survivent au rafraîchissement, jamais au changement d'onglet ni à la réouverture.
- **Plafond de 500 lignes** (`repos/ingredients.ts:123`) : latent tant que la bibliothèque compte
  76 lignes, mais tri, groupement et filtres sont tous appliqués côté client sur ce lot. Soit
  accepter le plafond et le dire dans l'interface, soit descendre tri et filtres côté serveur.
  À trancher maintenant, tant que ça ne coûte rien.

### 1.d Navigation

- **Sauter à une semaine** depuis l'historique des coûts : les lignes de la feuille sont inertes.
- **Lien Semaine vers Courses** : l'onglet Courses pointe sur `/courses` nu, donc toujours la semaine
  courante. Atteindre 2026-W36 demande autant d'appuis que de semaines d'écart. L'écran Frigo a déjà
  un lien vers `/courses` : reprendre le motif, avec le paramètre de semaine.
- **Conservation d'état des onglets** : la barre pointe sur les adresses nues, donc revenir sur
  Ingrédients efface recherche, tri, groupement et filtres. Mémoriser la dernière adresse par onglet.

### 1.e Frigo et fiche ingrédient

- **Regrouper les lots d'un même ingrédient.** La pastille "N lots" existe mais n'est pas cliquable,
  et avec le tri par urgence deux pots de yaourt tombent dans deux sections différentes.
  L'inventaire désignait ce regroupement comme l'amélioration la plus rentable du portage.
- **Ajouter au frigo et au calendrier depuis la fiche d'un ingrédient.** Le panneau de pastilles du
  desktop a été classé sans objet parce que le geste de glisser ne se porte pas, mais l'inventaire en
  décrivait l'équivalent tactile, qui n'a jamais été fait. Aujourd'hui il faut mémoriser le nom,
  changer d'onglet et rechercher une seconde fois.

### 1.f Recherche unifiée

Six écarts, dont quatre entièrement couverts par l'existant : `GET /api/ingredients?q=` et
`GET /api/recipes?q=` servent déjà les deux premières sections.

**Attention, la troisième section n'est pas gratuite.** Chercher dans le planning suppose une route
nouvelle qui balaie toutes les semaines, alors que `GET /api/calendar/:week` est indexé par semaine.
Livrer d'abord la palette à deux sections, ajouter le calendrier ensuite.

Corriger au passage les trois défauts connus du desktop : les flèches s'arrêtent sur les en-têtes de
section, Entrée reste sans effet, et l'activation d'un ingrédient ignore son identifiant.

### 1.g Option, une demi-journée : télécharger ses données

Hors périmètre choisi, mentionné une fois puis clos. L'application ne sait rien télécharger du tout :
aucun `createObjectURL`, aucun attribut `download`, aucun `Blob` dans tout `web/src`. Un bouton
"Télécharger mes données" en JSON dans les Réglages coûte une demi-journée et donne au foyer sa
première copie de secours. À glisser dans ce lot si l'occasion se présente.

---

## Lot 2 : les photos de recette

Chantier choisi. Le socle est presque entièrement prévu, mais **le premier pas n'est pas du code**.

### 2.0 Prérequis : levé le 2026-08-10

> **Fait.** R2 activé sur le compte, bucket `prandia-media`, binding `MEDIA` déclaré
> dans `wrangler.toml` et dans `Env` (`worker/src/http.ts`).
> Le repli KV du 2.0 bis n'a plus lieu d'être, il reste documenté pour mémoire.
>
> **Correction du 2026-08-14, et le piège n'était pas celui qu'on croyait.** Ce paragraphe
> annonçait « créé en zone WEUR ». C'était faux : vérification faite avant d'écrire la première
> photo, le bucket était en **ENAM**, côte est des États-Unis, pendant que deux commentaires
> affirmaient le contraire.
>
> Pire, le remède annoncé ne marche pas. Recréé avec `--location weur`, le bucket est **ressorti
> en ENAM** : `--location` n'est qu'un *indice* que Cloudflare est libre d'ignorer, et il l'a
> ignoré. Le mécanisme qui tient vraiment est `--jurisdiction eu`, que la documentation donne
> comme une **garantie** de résidence des données, celui prévu pour le RGPD.
>
> Conséquence à ne pas oublier : un bucket sous juridiction vit dans un espace de noms séparé, et
> le binding doit porter `jurisdiction = "eu"`. Sans cette ligne, le Worker cherche dans la
> juridiction par défaut et **ne trouve plus rien**. La manœuvre était gratuite parce que le
> bucket était vide ; elle ne le sera plus, une juridiction ne se change pas après coup.

Historique du diagnostic, conservé parce qu'il a coûté un aller-retour :

**Le blocage n'est pas celui qu'annonce `wrangler.toml`.** Le commentaire du dépôt parle d'un jeton
sans la portée `r2`. La réalité, constatée le 2026-08-09 : **R2 n'a jamais été activé sur le compte
Cloudflare**. `npx wrangler r2 bucket create` et un appel direct à l'API renvoient tous deux :

```
code 10042 : Please enable R2 through the Cloudflare Dashboard.
```

C'est un état de compte, pas un problème d'identifiants ni de version de wrangler. Se réauthentifier
ne change rien.

**Étape 1, dans le tableau de bord** (`dash.cloudflare.com`, rubrique R2 Object Storage) : activer
R2. L'écran d'activation est un abonnement, il demande donc un moyen de paiement même pour rester
dans le palier gratuit (10 Go-mois de stockage inclus). Une bibliothèque de recettes photographiées
tient très largement dedans : 200 Ko par photo, soit environ 50 000 photos avant le premier centime.
C'est la seule décision à prendre, et elle est d'ordre financier, pas technique.

**Étape 2**, une fois R2 actif :

```bash
npx wrangler r2 bucket create prandia-media --jurisdiction eu
```

Puis décommenter le bloc `[[r2_buckets]]` de `wrangler.toml` (binding `MEDIA`).

### 2.0 bis Repli si l'activation de R2 n'est pas souhaitée

**Workers KV**, déjà inclus dans le plan gratuit sans aucun moyen de paiement, convient à cet usage :
1 Go stocké, 100 000 lectures et 1 000 écritures par jour, valeur unitaire très au-dessus d'une photo
de 200 Ko. Pour une application personnelle comme Prandia, ces plafonds ne seront jamais approchés.

Ce que le repli change dans le plan : une seule ligne. La clé `recipes/<id>.jpg` devient une clé KV
au lieu d'une clé d'objet, le binding s'appelle `MEDIA` de la même façon, et `env.MEDIA.put` /
`env.MEDIA.get` remplacent l'API R2. Le redimensionnement côté navigateur, les routes, l'interface et
la colonne `image_key` sont identiques. Basculer de KV vers R2 plus tard reste possible, avec un
script de recopie.

Les deux réserves à connaître : KV est en cohérence éventuelle, donc une photo remplacée peut mettre
jusqu'à une minute à se propager, ce qui est sans conséquence ici ; et le stockage de binaire n'est
pas son usage nominal, ce qui reste acceptable à cette échelle.

Ne pas retenir la troisième option, un `BLOB` en D1 : la facturation D1 se fait aux lignes lues, et
charger la photo à chaque lecture de recette est le mauvais compromis.

### 2.1 Le serveur

Le schéma anticipe déjà tout : `recipe.image_key` existe, avec en commentaire la convention de clé
`recipes/<id>.jpg` (`migrations/0001_core.sql:72-73`). Aucune migration à écrire.

- `PUT /api/recipes/:id/photo` : accepte un corps `image/jpeg`, écrit `recipes/<id>.jpg` dans R2,
  met `image_key` à jour, journalise l'action. Refuser au-delà d'une taille raisonnable.
- `GET /api/recipes/:id/photo` : lit R2 et renvoie le flux avec un `Cache-Control` long et un `ETag`.
  Vérifier le foyer avant de servir : une clé d'objet ne doit pas franchir la frontière entre deux
  cuisines, comme le prouve déjà `smoke-isolation.mjs` pour le reste.
- `DELETE /api/recipes/:id/photo` : efface l'objet et remet `image_key` à `null`.

Point de vigilance : `PUT /api/recipes/:id` réexpédie `imageKey` à chaque enregistrement
(`draft.ts:173`). Une photo posée par un autre client ne pourrait pas être effacée depuis le web
tant que ce comportement reste. À traiter avec 0.9, qui touche la même route.

### 2.2 Le redimensionnement, côté navigateur

Reproduire les règles du desktop (`app/services/photo_service.py`) : 1024 px au maximum sur le plus
grand côté, ratio préservé, jamais d'agrandissement, orientation EXIF appliquée, aplatissement sur
blanc, JPEG qualité 85.

En navigateur : `createImageBitmap(file, { imageOrientation: 'from-image' })` applique l'EXIF sans
librairie, puis `OffscreenCanvas` et `convertToBlob({ type: 'image/jpeg', quality: 0.85 })`.
L'aplatissement sur blanc consiste à peindre le fond avant l'image, pour les PNG à transparence.

Envoyer le JPEG réduit, jamais l'original : une photo d'iPhone pèse plusieurs mégaoctets et le
téléversement se ferait en 4G.

### 2.3 L'interface

- Bloc photo dans l'éditeur de recette : aperçu, "Prendre une photo", "Choisir une image", "Retirer".
  Sur mobile, `<input type="file" accept="image/*" capture="environment">` ouvre directement
  l'appareil photo, ce qui est l'usage attendu (photographier son plat).
- Vignette carrée dans la liste des recettes, avec un repli quand `imageKey` est nul. La liste est
  aujourd'hui purement textuelle alors que `GET /api/recipes` renvoie déjà `imageKey`.
- Un champ "coller l'URL d'une image" reste facultatif : c'est l'équivalent tactile du glisser du
  desktop, mais il suppose un téléchargement côté Worker et peut attendre.

Effort : 1,5 à 2 jours une fois R2 débloqué. Le blocage, lui, dépend d'une action manuelle.

---

## Lot final : profil et objectifs de macros

Demandé le 2026-08-10, à figer **en fin de parcours**. C'est la fonctionnalité qui donnera un sens
aux chiffres pour quelqu'un qui ne sait pas lire un tableau nutritionnel : des profils tout faits qui
posent des objectifs journaliers, et chaque écran de nutrition qui se met à dire "où tu en es" plutôt
que "combien ça fait".

### Pourquoi la placer en dernier est le bon choix

Trois raisons, dont une technique qui compte.

1. **C'est une lentille, pas une donnée.** Un objectif se compare à des totaux journaliers que
   l'application enregistre déjà correctement. Rien n'a besoin d'être capté aujourd'hui pour rendre
   la fonctionnalité possible demain : le jour où les objectifs arrivent, ils s'appliquent
   rétroactivement à tout l'historique du calendrier, sans migration de données ni perte.
2. **Elle touche presque toutes les surfaces nutritionnelles** : anneau du jour, tableau de la
   semaine, fiche recette, et sans doute la liste de courses. Les construire d'abord, puis y poser
   la ligne d'objectif une seule fois, coûte moins cher que de faire suivre une cible mouvante.
3. **Les profils ne se calibrent qu'avec de l'usage réel.** Un préréglage "sportif" ou "perte de
   poids" n'est crédible qu'une fois qu'on voit ce que l'application enregistre vraiment.

### La seule décision qui ne peut PAS attendre

**Un objectif est-il porté par une personne, ou par le foyer ?**

L'état actuel du schéma : `user` appartient à un `household` (migration 0005), mais
**`meal_plan_entry` ne porte aucune personne**. Un repas est planifié pour la cuisine, pas pour
quelqu'un. Tant que les objectifs n'existent pas, ça ne se voit pas. Le jour où ils arrivent,
comparer le total d'une journée à l'objectif d'une personne est faux d'un facteur égal au nombre de
mangeurs.

Trois voies, par coût croissant :

| Voie | Ce que ça donne | Coût si décidé maintenant | Coût si décidé après |
|---|---|---|---|
| **A. Objectif de foyer** | "Notre cuisine vise 4 000 kcal/jour" | Nul | Nul |
| **B. Objectif par personne, calendrier inchangé** | Le total du jour est divisé par un nombre de mangeurs déclaré | Une colonne sur `household` | Faible |
| **C. Calendrier par personne** | Chaque entrée dit qui mange, chacun a son suivi | Une colonne sur `meal_plan_entry` + toute l'interface du calendrier repensée | **Élevé** : migration, et l'écran Semaine est déjà l'écran le plus contraint en 375 px |

La voie C est la seule qui coûte cher à rattraper. Elle n'a pas à être **construite** maintenant,
mais elle doit être **écartée ou retenue** maintenant : si elle est retenue, la colonne se pose dès
la prochaine migration, à vide, et l'interface suivra plus tard.

### Points à trancher le moment venu

- **Quels profils.** Sédentaire / actif / sportif, perte de poids / maintien / prise de masse.
  Le calcul de référence est le plus souvent Mifflin-St Jeor pour le métabolisme de base, puis un
  facteur d'activité. C'est un standard vérifiable, pas une invention maison.
- **Quelles bornes.** kcal seules, ou kcal plus la répartition P/G/L, ou aussi fibres et sel.
  Commencer par kcal plus les trois macros suffit à tout ce que l'anneau sait déjà montrer.
- **En pourcentage ou en grammes.** Les objectifs de macros s'expriment d'habitude en part de
  l'énergie (30/40/30), ce qui tombe bien : l'anneau parle déjà ce langage.
- **Piège connu, à décider une seule fois.** `MacrosDonut` calcule ses parts sur l'énergie
  **recalculée par Atwater**, alors qu'un objectif en kcal se comparera naturellement à l'énergie
  **déclarée**. Les deux divergent sur les données CIQUAL. Il faudra dire laquelle fait foi pour le
  suivi, sinon deux chiffres cohabiteront sur le même écran sans que rien ne l'explique.
- **Ton des messages.** Le public visé est celui qui ne sait pas. Un dépassement doit se lire comme
  une information, jamais comme une faute.

---

## Ce qui est repoussé, et pourquoi

| Bloc | Écarts | Raison du report |
|---|---:|---|
| Import de recette par URL | 14 | Chantier entier, choisi après les photos |
| Tickets de caisse | 18 | Le plus gros, deux verrous techniques réels |
| Lidl Plus | 7 | Arbitrage produit non tranché sur les identifiants tiers |
| Sauvegarde et restauration | 7 | Version minimale proposée en 1.g |
| Quoi cuisiner avec ce que j'ai | 4 | Algorithme de couverture à porter, effort élevé |
| Gestion des rayons | 4 | Demande une vraie table de catégories en D1 |

Décision déjà prise, à ne pas rouvrir : **reprendre une semaine et appliquer un modèle continuent de
remplacer la semaine cible**, pas de l'enrichir.
