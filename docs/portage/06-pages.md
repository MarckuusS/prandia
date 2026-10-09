# 06 — Pages QML : inventaire d'écrans pour le portage web

Source lue : `app/ui/qml/Main.qml` + `app/ui/qml/pages/{IngredientsPage, RecipesPage, CalendarPage,
ShoppingPage, PantryPage}.qml`, complété par les composants réellement utilisés par ces pages
(`components/*.qml`) et par les rôles exposés par les modèles Python (`app/ui/models/*.py`) quand le
delegate lit `model.<role>`.

Ce document décrit **ce que l'utilisateur voit et fait**. Les libellés français sont cités **mot pour
mot** (ils sont en dur dans le QML, sans fichier de traduction actif). Les noms de code (slots,
propriétés, rôles) restent en anglais.

Convention de lecture :
- « VM » = view-model Python exposé à QML comme *context property* (voir §1.7).
- Les dimensions sont en pixels logiques Qt. Les jetons `Theme.*` sont résolus en §9.
- ⚠️ = point d'ambiguïté ou comportement suspect relevé dans le code (listés aussi en §12).

---

## 1. Main.qml — la coquille applicative

### 1.1 Fenêtre

| Propriété | Valeur |
|---|---|
| Titre | `Prandia` |
| Taille initiale | 1280 × 800 |
| Taille minimale | 980 × 600 |
| Fond | `Theme.colorBackground` (#f8fafc clair / #0f172a sombre) |

Structure verticale, de haut en bas : **barre de menus → barre d'onglets → zone de contenu (5 pages
empilées) → barre de statut (22 px)**.

### 1.2 Barre de menus (4 menus)

Les libellés contiennent le marqueur Qt `&` (mnémonique Alt+lettre) ; il est rendu comme la lettre
**soulignée** via `Theme.formatMnemonic()` + `textFormat: RichText`. Chaque entrée de la barre fait
30 px de haut, padding horizontal 12 px, fond `colorSurfaceHover` + texte `colorPrimary` au survol.

#### Menu `Fichier`

| Libellé exact | Raccourci | Action |
|---|---|---|
| `Restaurer une sauvegarde…` | — | ouvre `RestoreBackupDialog` centré sur la fenêtre |
| *(séparateur)* | | |
| Libellé **dynamique** Lidl Plus (voir ci-dessous) | — | ouvre `LidlPlusSetupDialog` centré |
| *(séparateur)* | | |
| `Paramètres → Rayons d'ingrédients…` | — | ouvre `SettingsCategoriesDialog` centré |
| *(séparateur)* | | |
| `Quitter` | `StandardKey.Quit` | `Qt.quit()` |

Libellé Lidl Plus, résolu dans cet ordre :
1. VM absent → `Lidl Plus auto-fetch (expérimental)…`
2. `!lidlPlusVM.isAvailable` → `Lidl Plus auto-fetch (lib manquante)…`
3. `!lidlPlusVM.isConnected` → `Lidl Plus auto-fetch (non configuré)…`
4. `lidlPlusVM.enabled` → `Lidl Plus auto-fetch · ✓ activé` sinon `Lidl Plus auto-fetch · désactivé`

⚠️ `StandardKey.Quit` n'est pas mappé sur Windows par défaut : l'entrée « Quitter » n'a
probablement **aucun raccourci visible** sur la plateforme cible actuelle.

#### Menu `Affichage`

| Libellé exact | Raccourci | Action |
|---|---|---|
| `Mode sombre` (bascule en `Mode clair` quand le sombre est actif) | `Ctrl+Shift+D` | `Theme.darkMode = !Theme.darkMode` |

C'est la **seule** entrée du menu. Un ancien toggle « afficher/masquer les en-cas du calendrier » a
été retiré (commentaire explicite dans le code) : les 5 créneaux sont désormais toujours visibles.

#### Menu `Navigation`

| Libellé exact | Raccourci | Action |
|---|---|---|
| `1. Ingrédients` | `Ctrl+1` | onglet 0 |
| `2. Recettes` | `Ctrl+2` | onglet 1 |
| `3. Calendrier` | `Ctrl+3` | onglet 2 |
| `4. Liste de courses` | `Ctrl+4` | onglet 3 |
| `5. Frigo / Cellier` | `Ctrl+5` | onglet 4 |

#### Menu `Aide`

| Libellé exact | Raccourci | Action |
|---|---|---|
| `Raccourcis clavier` | `Ctrl+/` | ouvre `ShortcutsDialog` |
| *(séparateur)* | | |
| `Ouvrir le dossier de logs` | — | `Qt.openUrlExternally("file:///" + logDirPath)` (chemin injecté par Python, `~/.prandia/logs/`) |

### 1.3 Barre d'onglets

5 onglets, hauteur 40 px, largeurs fixes : `Ingrédients` 160, `Recettes` 160, `Calendrier` 160,
`Liste de courses` 180, `Frigo / Cellier` 180. Fond `colorSurface` + bordure basse 1 px.

État d'un onglet (`AppTabButton`) :
- **sélectionné** : texte `colorPrimary` semi-gras, fond `primary` à 6 %, **barre 2 px `colorPrimary` en bas** ;
- **survolé** : texte `colorText`, fond `colorSurfaceHover` ;
- **repos** : texte `colorTextSecondary`, fond transparent ;
- **survolé pendant un drag** : fond `primary` à 20 % + barre 2 px `colorPrimary` **en haut**.

**Onglets magnétiques** : chaque onglet est une `DropArea`. Si un drag reste au-dessus pendant
**300 ms**, l'onglet devient courant automatiquement (façon dock macOS). L'onglet ne reçoit jamais le
drop lui-même — c'est la page cible qui le traite. C'est le mécanisme qui permet de glisser un
ingrédient depuis l'onglet Ingrédients jusqu'à l'onglet Frigo / Cellier.

### 1.4 Zone de contenu

`StackLayout` : les 5 pages sont **instanciées en permanence** et conservent leur état (sélection,
scroll, formulaire en cours). Au changement d'onglet, une animation fait passer l'opacité de la pile
de **0.55 → 1.0 en 250 ms** (easing OutCubic) — un « clignotement » doux, pas de slide.

### 1.5 Barre de statut (hauteur 22 px, bordure haute 1 px)

De gauche à droite :

1. **Badge tickets en attente** — visible si `receiptImportVM.pendingFileCount > 0`.
   Texte : `📥 N ticket en attente` / `📥 N tickets en attente` (pluriel dès 2).
   Style : hauteur 18, radius 4, fond `primary` 18 %, bordure `primary`, texte `primary` XS semi-gras.
   Tooltip (400 ms) : `Cliquer pour importer le prochain ticket en attente`.
   Clic → `receiptImportVM.loadNextPending()` ; si un chemin est renvoyé →
   `receiptImportDialog.openForPending(window)`.

2. **Badge Lidl** — visible si `lidlPlusVM.pendingTicketCount > 0`.
   Texte : `🛒 Lidl · N ticket` / `… N tickets`. Couleur `colorAccent` (cyan), même gabarit.
   Tooltip : `Cliquer pour importer le prochain ticket Lidl`.
   Clic → prend le 1er id de `pendingTicketIds()`, `fetchTicketDetailAsDict(id)`,
   `receiptImportVM.loadFromLidlJson(detail)`, ouvre le dialog, puis `removePendingTicketId(id)`.

3. *(espace flexible)*

4. **Indicateur réseau** (aligné à droite) : pastille 8 px verte (`colorSuccess`) si
   `networkVM.online`, sinon rouge (`colorError`), + libellé `OpenFoodFacts en ligne` /
   `OpenFoodFacts indisponible` (XS, secondaire).
   Tooltip : `Dernière vérification : <networkVM.lastCheckedHuman>` + nouvelle ligne +
   `Clique pour re-vérifier maintenant.`
   **Toute la barre de statut** est cliquable → `networkVM.checkNow()`.

### 1.6 Recherche unifiée `Ctrl+K` (UnifiedSearchDialog)

Raccourci global `Ctrl+K` (contexte fenêtre). Popup modale **640 × 520**, centrée horizontalement,
positionnée à `hauteur_fenêtre / 4` verticalement. Fermeture : `Échap` ou clic hors du popup.
Animation d'entrée : opacité 0→1 + scale 0.96→1 en 150 ms.

- **Champ** : `AppTextField` pleine largeur, taille de police Lg, placeholder
  `Rechercher dans tout — ingrédients, recettes, calendrier…`. Debounce **200 ms**.
- **3 sections** interrogées en parallèle à chaque recherche :
  - `🥕 Ingrédients` ← `ingredientVM.searchOnce(q, "personal", 12)`
  - `🍽 Recettes` ← `recipeListVM.searchOnce(q, 12)`
  - `📅 Calendrier · semaine courante` ← `calendarVM.searchOnce(q, 12)`
  Une section n'apparaît que si elle a au moins un résultat.
- **Ligne d'en-tête de section** : 28 px, fond `colorBackground`, texte XS semi-gras **majuscules**.
- **Ligne de résultat** : 44 px, radius 4 ; sélectionnée = fond `primary` 12 % ; survolée =
  `colorSurfaceHover`. Contenu : icône, libellé (Md), sous-libellé (XS secondaire), et `↩` en
  `colorPrimary` sur la ligne sélectionnée.
  - Ingrédient — sous-libellé : `CIQUAL` | `OpenFoodFacts` | `perso`, suivi de `  ·  🌱 de saison`
    si l'ingrédient est de saison ce mois-ci.
  - Recette — sous-libellé : `N portion(s)  ·  M ingrédient(s)`.
  - Calendrier — sous-libellé : `<Jour> <créneau>` avec la table
    `morning→matin`, `noon→midi`, `evening→soir`, `snack_morning→10 h`, `snack_afternoon→16 h`.
- **Clavier** : `↑`/`↓` déplacent l'index dans la liste **plate** (en-têtes inclus), `Entrée` active,
  `Échap` ferme. Après une recherche, le curseur se pose sur le premier élément non-en-tête.
- **État vide** : `Tape pour chercher dans tout — Ctrl+K depuis n'importe quel onglet.` si la requête
  est vide, sinon `Aucun résultat.`
- **Pied** : `↑ / ↓ pour naviguer · Entrée pour ouvrir · Esc pour fermer`
- **Activation** (routage dans Main.qml) :
  - `ingredient` → bascule sur l'onglet 0. ⚠️ **`payload.id` est ignoré** : rien n'est sélectionné.
  - `recipe` → onglet 1 + `recipeEditorVM.loadById(payload.id)`.
  - `meal_entry` → onglet 2 + `calendarVM.setIsoWeek(payload.isoWeek)` (le jour/créneau sont dans le
    payload mais non utilisés).

### 1.7 Dialogues globaux + contrat inter-pages

Instanciés dans Main.qml et donc partagés : `RestoreBackupDialog`, `ShortcutsDialog`,
`UnifiedSearchDialog`, `ReceiptImportDialog`, `LidlPlusSetupDialog`, `SettingsCategoriesDialog`,
`CategoryPickerDialog`, `IngredientFilterDialog`.
Quatre sont ré-exposés aux pages enfants via alias : `window.receiptImportDialog`,
`window.lidlPlusSetupDialog`, `window.categoryPickerDialog`, `window.ingredientFilterDialog`.

Fonction publique de la fenêtre : `navigateToIngredient(ingredientId)` → bascule sur l'onglet 0 puis,
en `Qt.callLater`, appelle `ingredientsPageRef._loadIngredient(id)` (remplit le formulaire).
⚠️ Cela ne déplace **pas** la sélection dans la liste de gauche et ne garantit pas que l'ingrédient
soit présent dans la liste filtrée courante.

VM disponibles globalement (context properties, `app/main.py`) : `ingredientVM`, `recipeListVM`,
`recipeEditorVM`, `calendarVM`, `shoppingVM`, `tagVM`, `backupVM`, `networkVM`, `pantryVM`,
`receiptImportVM`, `recipeUrlImportVM`, `lidlPlusVM`, `categoryVM`, plus `appCtx` et `logDirPath`.

Code mort : le composant interne `PagePlaceholder` (vitrine de composants de la Phase 1) n'est plus
instancié — à ne pas porter.

### 1.8 Dialogue « Raccourcis clavier » (Aide → Ctrl+/)

Fenêtre système non modale 540 × 580 (min 420 × 400), scrollable. Titre `Raccourcis clavier`, puis un
texte d'intro : « Les raccourcis sont contextuels — Ctrl+N crée un nouvel ingrédient sur l'onglet
Ingrédients, une nouvelle recette sur l'onglet Recettes. »
5 catégories ; chaque ligne = une « touche » (rectangle 130 × 24, police monospace) + un libellé.

| Catégorie | Entrées (touche → libellé) |
|---|---|
| NAVIGATION | `Ctrl+1..Ctrl+5` → les 5 onglets ; `Ctrl+K` → Recherche unifiée ; `Ctrl+/` → cette aide ; `Échap` → Fermer le dialog ouvert |
| ACTIONS GLOBALES | `Ctrl+N` → Créer ; `Ctrl+S` → Enregistrer ; `Suppr` → Retirer l'élément sélectionné ; `Ctrl+F` → Focus recherche |
| CALENDRIER | `Ctrl+←` / `Ctrl+→` → semaine précédente / suivante ; `Ctrl+T` → semaine courante |
| AFFICHAGE | `Ctrl+Shift+D` → clair / sombre |
| DIAGNOSTIC | `Menu Aide` → dossier de logs ; `PRANDIA_DEBUG=1` → activer DEBUG (relance requise) |

---

## 2. Onglet 1 — Ingrédients (`IngredientsPage.qml`)

### 2.1 Structure

`ColumnLayout` (marges 16, espacement 12) :

1. **Barre de recherche** (ligne 1)
2. **Barre tri / groupement / filtres** (ligne 2)
3. **SplitView horizontal** occupant le reste :
   - **panneau gauche** : `42 %` de la largeur du splitter, minimum 280 px — boutons + liste ;
   - **poignée** 5 px (transparente au repos, `colorBorder` au survol, `colorBorderHover` pressée) ;
   - **panneau droit** : le reste — formulaire d'édition dans un `Flickable` (scroll vertical seul).

Le formulaire est bridé à `min(largeur_disponible − 24, 720) px` et décalé de 16 px en x et en y.

### 2.2 Barre supérieure

| Élément | Libellé / placeholder | Comportement |
|---|---|---|
| Champ recherche (pleine largeur) | `Rechercher dans ma bibliothèque personnelle…` | debounce **200 ms** → `ingredientVM.setFilter(text)` |
| Bouton secondaire | `Importer (CIQUAL / OFF)` | ouvre `ImportIngredientDialog` centré (fenêtre détachable). À sa fermeture, `libraryChanged` → `ingredientVM.refreshList()` |

### 2.3 Barre tri / groupement / filtres

- Libellé `Trier :` + liste déroulante (200 px), 18 entrées, mappées 1-pour-1 :

  | Libellé | Code | Libellé | Code |
  |---|---|---|---|
  | `Nom (A→Z)` | `name_asc` | `Nom (Z→A)` | `name_desc` |
  | `Énergie ↑` | `kcal_asc` | `Énergie ↓` | `kcal_desc` |
  | `Protéines ↑` | `proteins_asc` | `Protéines ↓` | `proteins_desc` |
  | `Glucides ↑` | `carbs_asc` | `Glucides ↓` | `carbs_desc` |
  | `Lipides ↑` | `fats_asc` | `Lipides ↓` | `fats_desc` |
  | `Fibres ↑` | `fiber_asc` | `Fibres ↓` | `fiber_desc` |
  | `Sel ↑` | `salt_asc` | `Sel ↓` | `salt_desc` |
  | `Prix ↑` | `price_asc` | `Prix ↓` | `price_desc` |
  | `Récents` | `created_desc` | `Anciens` | `created_asc` |

  Valeur courante lue depuis `ingredientVM.sortBy`, écriture via `setSortBy(code)`.

- Libellé `Grouper :` + liste déroulante (160 px) : `Aucun`→`none`, `Source`→`source`,
  `Rayon`→`rayon`, `Saisonnalité`→`season`, `Tranche kcal`→`kcal_range`.
  Le regroupement pilote le rôle `groupKey` du modèle Python, qui produit les **libellés d'en-tête de
  section** suivants :
  - `source` : `CIQUAL` / `OFF` / `Manuel` / `Lidl` (valeur brute si inconnue) ;
  - `rayon` : `category_l1` ou `Sans rayon` ;
  - `season` : `🌱 De saison` / `Hors saison` / `—` (pas de mois renseigné) ;
  - `kcal_range` : `0–100 kcal/100g`, `100–300 kcal/100g`, `300–500 kcal/100g`, `500+ kcal/100g`,
    `Sans valeur kcal` ;
  - `none` : chaîne vide → **aucune section affichée** (le delegate de section a une hauteur 0).

- Bouton à droite : `🔧 Filtres` (variante *secondary*) ou `🔧 Filtres · N` (variante *primary*) où N
  = `ingredientVM.activeFilterCount`. Clic → `window.ingredientFilterDialog.openCentered(window)`.
  Le filtrage est fait **côté VM/SQL** ; la liste ne contient que les lignes retenues.

### 2.4 Panneau gauche

**Boutons** (ligne du haut) :
- `Nouveau` (primary) → formulaire vide, `selectedId = -2`, focus sur le champ Nom.
- `Retirer` (secondary), **activé seulement si une ligne existante est sélectionnée** →
  `ingredientVM.deleteIngredient(id)`. Sémantique côté Python : un ingrédient `manual` est
  **supprimé définitivement**, un ingrédient CIQUAL/OFF est seulement **retiré de la bibliothèque
  personnelle** (`in_personal_library = false`). Aucune boîte de confirmation ; un
  **toast d'annulation** apparaît (§2.7).

**Bandeau « Trouve-moi des recettes »** — visible dès que **2 cases ou plus** sont cochées dans la
liste. Fond `primary` 8 %, bordure `primary` 30 %, radius 6. Contenu : `🔍` + texte
`N ingrédient(s) sélectionné(s)` + lien cliquable `Désélectionner` + bouton primary
`Trouver les recettes` → `recipeListVM.findByIngredientsCategorized(ids, 3)` puis ouverture de
`RecipeMatchDialog` (3 listes : prêtes / presque prêtes / à acheter ; `max_missing = 3`).

**Liste** (carte `colorSurface`, radius 6, bordure 1 px) :
- En-tête de section : 28 px, fond `primary` 6 %, texte `primary` Sm semi-gras, interlettrage 0,4.
- Ligne : **hauteur 52 px**, sélection = barre verticale 3 px `primary` à gauche + fond `primary` 12 %.
  - **case à cocher** (sélection multi pour la recherche de recettes) ;
  - **ligne 1** : nom (Md, medium, ellipsé) + **badge source** + **badge saison** conditionnel
    - badge source : `CIQUAL` (texte #15803d sur fond #15803d à 14 %), `OFF` (#1d4ed8), `perso`
      (#c2410c) ; hauteur 18, radius 4 ;
    - badge saison : `🌱 saison` en `colorSuccess` sur fond 14 %, visible si `inSeasonNow === true` ;
  - **ligne 2** (XS) : `P <x,x>g` en **#0B6BBB**, `G <x,x>g` en **#509938**, `L <x,x>g` en **#FDA406**
    — chaque valeur est masquée si le macro est `null` — puis `● 1 pc = <X> g` (secondaire) si
    `pieceWeightG > 0` ;
  - **poignée de glisser** `⠿` à droite (28 × 28, fond `primary` 12 % au survol) ; tooltip après
    600 ms : `Glisser vers l'onglet Frigo / Cellier pour ajouter au stock` ; seuil de drag 4 px.
    Pendant le drag, une pastille fantôme 220 × 32 (fond `primary` 92 %, texte blanc `🛒  <nom>`)
    suit la souris ; elle porte `ingredientId`, `ingredientName`, `pieceWeightG`, `sourceTag` que la
    cible lit dans `drop.source`.
- Clic sur la ligne → sélection + chargement dans le formulaire.
- **État vide** : affiché **uniquement si la liste est vide ET que le champ de recherche est vide** :
  titre `Bibliothèque vide` (Lg medium) + texte centré 280 px
  `Crée un ingrédient avec « Nouveau » ou importe-en depuis CIQUAL / OpenFoodFacts.`
  ⚠️ Une recherche sans résultat n'affiche donc **aucun message** — panneau blanc.

### 2.5 Panneau droit — formulaire d'ingrédient

Titre (XL semi-gras) selon l'état : `Modifier l'ingrédient` (id > 0), `Nouvel ingrédient` (id = -2),
`Sélectionne un ingrédient pour le modifier` (rien de sélectionné, en gris).
La grille entière est **désactivée** tant que rien n'est sélectionné.

Grille 2 colonnes (libellé aligné à droite, champ à gauche), dans cet ordre :

| # | Libellé exact | Type de saisie | Unité | Bornes / défaut | Lecture seule |
|---|---|---|---|---|---|
| 1 | `Nom :` | texte | — | vide ; largeur 200–480 | non |
| 2 | `Source :` | texte / lien | — | `manuel` par défaut | **oui** |
| 3 | `Réf. source :` | texte, placeholder `Code CIQUAL ou code-barres EAN (optionnel)` | — | vide ; max 320 px | non |
| 4 | `Marque :` | texte, placeholder `Ex : Pâturages, Carrefour Bio… (optionnel)` | — | vide | non |
| 5 | `Énergie` (picto energy) | numérique décimal | `kcal/100g` | 0 → **2000**, pas 0,1, **2 décimales** | non |
| 6 | `Lipides` (picto) | numérique | `g/100g` | 0 → 10000, pas 0,1, 2 déc. | non |
| 7 | `dont saturés` (sous-ligne, gris italique) | numérique | `g/100g` | idem | non |
| 8 | `Glucides` | numérique | `g/100g` | idem | non |
| 9 | `dont sucres` (sous-ligne) | numérique | `g/100g` | idem | non |
| 10 | `Fibres` | numérique | `g/100g` | idem | non |
| 11 | `Protéines` | numérique | `g/100g` | idem | non |
| 12 | `Sel` | numérique | `g/100g` | idem | non |
| — | *(séparateur vertical 8 px)* | | | | |
| 13 | `Prix (€) :` | cellule grisée + 🔒 | € | affiche `—` si vide | **oui** |
| 14 | `Quantité de réf. :` | cellule grisée + 🔒 | g | `X,X g` ou `—` | **oui** |
| 15 | `Poids unitaire :` | numérique | `g / pièce` | 0 → 10000 | non |
| 16 | `Poids cuit :` | numérique | `g / 100 g cru` | 0 → 1000 | non |
| 17 | `Rayon :` | bouton ouvrant un sélecteur | — | vide | via dialogue |
| 18 | `De saison :` | 12 bascules mensuelles | — | aucune | non |

Détails :

- **Champ nutritionnel** (`FixedUnitField`) : spin numérique + cellule d'unité accolée à droite
  (fond `colorSurfaceHover`, bordure 1 px). **`0` s'affiche comme une cellule vide** — c'est ainsi
  qu'on distingue « non renseigné » de « 0 g ». Séparateur décimal **virgule** (locale fr).
  Validation : `DoubleValidator` borné, locale `fr_FR`. Boutons `+` / `−` empilés à droite (24 px).
- **Source (lecture seule)** : rendu HTML.
  - `ciqual` + réf → lien `ciqual ↗` vers `https://ciqual.anses.fr/#/aliments/<sourceRef>` ;
  - `openfoodfacts` + réf → lien `openfoodfacts ↗` vers
    `https://world.openfoodfacts.org/product/<sourceRef>` ;
  - sinon texte brut (`manuel`). Ouverture dans le navigateur système, curseur main sur le lien.
- **Prix / Quantité de réf.** : non éditables. Bouton adjacent `📊  Historique` (secondary, ≥140 px,
  actif dès qu'un ingrédient est sélectionné) → `PriceHistoryDialog.openFor(id, nom || "(sans nom)",
  quantité)`. Tooltip : `Saisir / consulter l'historique des prix` (ou
  `Sélectionne un ingrédient d'abord` si désactivé). Texte d'aide sous les deux cellules :
  `Calculé automatiquement depuis le dernier prix de l'historique.` (XS italique).
  Le VM émet `current_price_recomputed(ingredientId)` après chaque ajout/suppression d'observation ;
  la page recharge alors les deux cellules **si** l'ingrédient recalculé est celui affiché.
  ⚠️ Le prix est affiché **tel que sérialisé** (`"1.2000"`), sans localisation ni symbole `€` —
  incohérent avec le reste de l'app qui formate en `X,XX €`.
- **Poids cuit** — texte d'aide : `Ex : 300 pour du riz (100 g cru → 300 g cuit). Optionnel — sert à
  estimer le poids d'une portion servie. Les valeurs nutritionnelles restent par 100 g cru.`
- **Rayon** : bouton pleine largeur libellé `📁  <rayon>` (variante secondary) ou
  `📁  Choisir un rayon…` (variante ghost) → `categoryPickerDialog.openPicker(rayonCourant, "", win)`.
  Le résultat arrive par le signal `categorySelected(l1, l2)` (connexion one-shot). Texte d'aide :
  `Impact : regroupement dans liste de courses + frigo / cellier. Édite la liste via Fichier →
  Paramètres → Rayons d'ingrédients.`
- **De saison** : 12 carrés 28 × 28 côte à côte, libellés `J F M A M J J A S O N D` (index + 1 = mois).
  Actif = fond `colorSuccess` + texte blanc ; inactif = transparent + bordure. Texte d'aide :
  `Clique sur les mois où l'ingrédient est de saison. Vide = pas de badge “🌱 saison”.`
  Sérialisation : CSV trié croissant (`"3,4,5"`), analysé en tolérant les espaces et en rejetant tout
  ce qui n'est pas 1..12.
- **Bouton d'enregistrement** : `Enregistrer` (primary). Après un succès, il devient
  `✓  Enregistré` avec la variante *success* (fond vert) pendant **1500 ms**, puis revient.

**Charge utile envoyée à `ingredientVM.saveFromDict()`** :
`id` (null si création), `name` (trim), `sourceRef` (trim ou null), `brand` (trim ou null), `kcal`,
`proteins`, `carbs`, `sugars`, `fats`, `saturatedFats`, `fiber`, `salt`, `pieceWeightG`,
`cookedWeightPer100gRaw` (null si 0), `categoryL1` (trim ou null), **`categoryL2` forcé à `null`**
(nettoyage progressif des seeds CIQUAL), `seasonMonths` (CSV).
**Prix et quantité de référence ne sont jamais envoyés** — ils sont préservés/recalculés côté Python.

Astuce de préservation UX à reproduire : la position de scroll de la liste est capturée avant le save
et restaurée après (le refresh Python fait un `beginResetModel`, ce qui remettrait la liste à zéro),
et la ligne sauvegardée est re-sélectionnée par son id.

### 2.6 Raccourcis clavier de la page

Actifs **uniquement quand l'onglet est visible** :

| Touche | Condition | Action |
|---|---|---|
| `Ctrl+N` | — | nouveau formulaire vide |
| `Ctrl+S` | un ingrédient est chargé | enregistre (passe par le clic du bouton, donc feedback `✓ Enregistré`) |
| `Suppr` | ligne existante sélectionnée | retire l'ingrédient |
| `Ctrl+F` | — | focus sur le champ de recherche |

⚠️ `Suppr` est un raccourci de **fenêtre** : il se déclenche même si le focus est dans un champ texte
du formulaire.

### 2.7 Retours utilisateur (toasts / dialogues)

- **Toast d'erreur** : rectangle rouge (`colorError`, opacité 0,95), centré en bas, marge 24 px,
  auto-masquage après **4 s**. Alimenté par `ingredientVM.error_emitted(message)`.
- **Toast d'annulation** (`UndoToast`) : fond ardoise foncé (#1f2937 en clair, `colorSurface` en
  sombre), texte blanc, bouton `Annuler` intégré, auto-masquage après **5 s**.
  Libellé émis par Python : `« <nom> » retiré`. Clic → `ingredientVM.undoLastDelete()`.
- **Dialogue de collision de nom** (émis par `name_collision_detected(existingId, name)`) :
  titre `Ingrédient existant` ;
  corps 1 : `Un ingrédient nommé « <X> » existe déjà dans ta bibliothèque.` ;
  corps 2 : `Tu peux soit éditer l'ingrédient existant (recommandé pour ne pas créer de doublon),
  soit annuler et changer le nom.` ;
  boutons : `Annuler` (secondary) / `Éditer l'existant` (primary → sélectionne la ligne existante et
  charge le formulaire).

### 2.8 Dialogues ouverts depuis cette page

| Déclencheur | Dialogue |
|---|---|
| Bouton `Importer (CIQUAL / OFF)` | `ImportIngredientDialog` (fenêtre détachable) |
| Bouton `Trouver les recettes` (≥ 2 cases cochées) | `RecipeMatchDialog` |
| Bouton `📊  Historique` | `PriceHistoryDialog` |
| Bouton `🔧 Filtres` | `IngredientFilterDialog` (global) |
| Bouton `📁 Choisir un rayon…` | `CategoryPickerDialog` (global) |
| Signal de collision | dialogue interne `Ingrédient existant` |

---

## 3. Onglet 2 — Recettes (`RecipesPage.qml`)

### 3.1 Structure

`SplitView` horizontal plein écran (marges 16) :
- gauche **30 %** (min 240 px) : actions + filtre par tags + liste des recettes ;
- droite : éditeur complet dans un `Flickable` (largeur = panneau − 32 px).

L'éditeur entier est **désactivé** tant qu'aucune recette n'est chargée (`selectedId === -1`).

### 3.2 Panneau gauche

**Boutons** : `Nouvelle` (primary) · `Importer URL` (secondary → `ImportRecipeUrlDialog` centré) ·
`Supprimer` (secondary, actif si une recette enregistrée est sélectionnée).

**Filtre par tags** (visible seulement s'il existe au moins un tag) :
- ligne `Filtrer :` (XS medium) + lien `Effacer` à droite (visible si au moins un tag est actif) →
  `recipeListVM.clearTagFilter()` ;
- `Flow` de chips arrondies (hauteur 22, radius plein, espacement 3) : active = fond plein
  `tag.colorHex` + texte blanc ; inactive = fond `colorHex` à 10 % + bordure 35 % + texte `colorHex`.
  Clic → `recipeListVM.toggleTagFilter(tagId)` (filtre cumulatif).

**Liste** (carte surface) — ligne de **68 px** :
- vignette 56 × 56 (radius 4, bordure 1) affichant `photoUrl` en `PreserveAspectCrop` ; si absente ou
  en erreur de chargement → emoji `🍽` 24 px sur fond `colorSurfaceHover` ;
- nom (Md medium, ellipsé) ;
- sous-ligne XS secondaire : `N portion(s)  ·  M ingrédient(s)`.
- **État vide** (centré) : `Aucune recette` puis nouvelle ligne
  `Clique sur « Nouvelle » pour commencer.`

### 3.3 Panneau droit — éditeur

Titre : `Modifier la recette` / `Nouvelle recette` / `Sélectionne une recette pour l'éditer`.

#### a) Bloc photo (`RecipePhotoBlock`)

Zone 300 × 200 (radius 6, bordure 1, contenu rogné) + colonne de boutons à droite.

- Affichage : image en `PreserveAspectCrop`. Sinon, un placeholder centré :
  - emoji `🍽` 48 px — devient `📥` pendant un survol de drag ;
  - libellé, par priorité : `Déposer ici` (drag en cours) > `Photo introuvable` (fichier disparu du
    disque) > `Enregistre la recette d'abord` (recette non sauvegardée) > `Aucune photo` ;
  - mention supplémentaire `(ou glisse une image ici)` (XS italique) quand la recette est enregistrée
    et sans photo.
- Bordure et halo `primary` 10 % pendant le survol d'un drag.
- Boutons : `+ Ajouter une photo` (devient `Modifier la photo` si une photo existe ; secondary ;
  **désactivé tant que la recette n'est pas enregistrée**) → dialogue de fichier natif intitulé
  `Choisir une photo de recette`, filtre `Images (*.png *.jpg *.jpeg *.webp *.gif *.bmp)` ;
  `Retirer la photo` (variante danger, visible seulement si une photo existe) →
  `recipeEditorVM.removePhoto()`.
- Texte sous les boutons si la recette n'est pas enregistrée :
  `Sauvegarde d'abord la recette pour pouvoir y attacher une photo.`
- **Glisser-déposer** accepté (`text/uri-list`, `text/plain`), **désactivé** si `selectedId <= 0` :
  - URL `file://` → `recipeEditorVM.setPhotoFromUrl(url)` ;
  - URL `http(s)://` (drag depuis un navigateur) → `recipeEditorVM.setPhotoFromHttpUrl(url)` ;
  - autres schémas (`data:`, `ftp:`) ignorés silencieusement.

#### b) Bloc tags (`RecipeTagsChips`)

Libellé `Tags :` puis un `Flow` de **tous** les tags existants sous forme de chips (hauteur 26,
radius plein). Attachée = fond plein `colorHex` + texte blanc ; détachée = fond 15 % + bordure 40 %.
Clic → `recipeEditorVM.toggleTag(tagId)`.

#### c) Méta

| Libellé | Type | Bornes / défaut | Persistance |
|---|---|---|---|
| `Nom :` | texte (200–480 px) | vide | poussé au VM **à chaque frappe** |
| `Portions :` | spin entier, largeur 100 | **1 → 50**, pas 1, défaut **1**, 0 décimale | idem |
| `Instructions :` | zone de texte multi-lignes, hauteur 120, scroll, retour à la ligne auto, placeholder `Étapes de préparation…` | vide | idem |

Les trois appellent `recipeEditorVM.updateMeta(nom, instructions, portions)` — ce qui alimente le flag
« modifications non sauvegardées ».

#### d) Ajout d'un ingrédient

Carte `colorSurfaceHover` : libellé `Ajouter un ingrédient :` + champ de recherche `IngredientSearch`
(portée `personal`, placeholder `Tape un nom…`) + `QuantityField` (200 px, valeur initiale
**100 g**, 1 décimale).

`IngredientSearch` : debounce **200 ms**, `ingredientVM.searchOnce(q, scope, 12)`, popup ancré sous le
champ (hauteur max 280 px). Chaque suggestion (38 px) affiche le nom, le badge source
(`CIQUAL`/`OFF`/`perso` avec les mêmes couleurs qu'au §2.4) et `● 1 pc = X g` si pertinent.
Navigation `↑` / `↓` / `Entrée` / `Échap` ; le survol souris déplace aussi la sélection.
Sélection → `recipeEditorVM.addLineById(id, quantité || 100, "")`, puis le champ se vide.

#### e) Bandeau de mise à l'échelle (visible si `isScaled`)

Fond `colorWarning` 10 %, bordure 45 %. Texte (HTML) :
`⚠ Quantités affichées pour <b>N portions</b> (recette pour M, facteur ×X,XX). Modifier une quantité
ici stocke la valeur ramenée à M portions.` + bouton ghost `Réinitialiser` →
`recipeEditorVM.resetDisplayPortions()`.

#### f) Lignes d'ingrédients

Carte surface. Titre `Ingrédients (N)`.
Les lignes arrivent **pré-triées par (rayon, ordinal)** depuis Python. Un en-tête de section est
inséré quand `categoryL1` change (et sur la première ligne) : `▸ <RAYON>` — XS semi-gras, **rendu tout
en majuscules**, première lettre capitalisée avant l'uppercase ; `Autres` si la catégorie est vide.

Chaque ligne :
- **nom** (zone fixe 220 px, min 180 / max 260) — cliquable : souligné + `colorPrimary` au survol,
  tooltip (600 ms) `Ouvrir l'ingrédient en édition (onglet Ingrédients)`, clic →
  `window.navigateToIngredient(ingredientId)` (bascule sur l'onglet 1) ;
- **quantité** (`QuantityField`, 240–280 px) : spin + liste d'unités. Unités statiques (miroir de
  `app/domain/units.py`) : `g` (×1), `kg` (×1000), `mg` (×0,001), `ml` (×1), `cl` (×10), `dl` (×100),
  `L` (×1000), `c. à café` (×5), `c. à soupe` (×15), `tasse` (×250), `pincée` (×1). Si l'ingrédient a
  un poids unitaire, une entrée `pièce (X g)` est ajoutée **en tête** (facteur = poids unitaire).
  Le stockage reste **toujours en grammes** ; changer d'unité ne change pas la valeur stockée, juste
  l'affichage. L'unité affichée est restaurée depuis `modelData.unit` (`preferredUnit`) pour ne pas
  repasser en « pièce » à chaque rechargement.
  Édition → `updateLineQty(ordinal, grammes)` ; changement d'unité → `updateLineUnit(ordinal, code)`.
- **notes** : champ texte (max 320 px), placeholder
  `Notes (ex: « égoutter », « écraser »…)`, **enregistré à la perte de focus ou sur Entrée**
  (`updateLineNotes(ordinal, texte)`) — pas à chaque frappe ;
- **bouton `✕`** (36 × 30, variante danger) → `removeLineByOrdinal(ordinal)`.
- **État vide** : `Aucune ligne — ajoute des ingrédients via le picker ci-dessus.`

#### g) Tableau nutritionnel + donut

Ligne à deux colonnes : `NutritionPanel` (élastique) + `MacrosChart` (320 px, aligné en haut).

**NutritionPanel** — 8 lignes dans l'ordre réglementaire UE 1169/2011, chacune avec un picto PNG
22 px placé **après** le libellé :

| Ligne | Clé | Unité | Décimales | Style |
|---|---|---|---|---|
| `Énergie` | kcal | `kcal` | 0 | normal |
| `Lipides` | fats | `g` | 1 | normal |
| `dont saturés` | saturatedFats | `g` | 1 | gris italique |
| `Glucides` | carbs | `g` | 1 | normal |
| `dont sucres` | sugars | `g` | 1 | gris italique |
| `Fibres` | fiber | `g` | 1 | normal |
| `Protéines` | proteins | `g` | 1 | normal |
| `Sel` | salt | `g` | **2** | normal |

Valeur absente → `—`. Trois colonnes d'en-tête : `Pour 100 g`, `Par portion`, `Recette entière`.
Sous-titres de colonne (italique, 85 % d'opacité) : rien pour la 1re ; pour les deux autres,
`≈ N g cuit` si **au moins un** ingrédient a un ratio de cuisson renseigné, sinon `N g cru`
(arrondi entier) ; rien si le poids vaut 0.

**MacrosChart** — carte titrée `Composition macros`, donut 220 px de haut :
- répartition **énergétique** (facteurs Atwater : lipides ×9, glucides ×4, fibres ×2, protéines ×4) ;
- 4 quartiers : Lipides `#FDA406`, Glucides `#509938`, Fibres `#7CC04C`, Protéines `#0B6BBB` ;
- départ à 12 h, rayon intérieur = 62 % du rayon extérieur, quartier survolé extrudé de +4 px ;
- centre au repos : `N kcal` (gras 22 px) + `/ 100 g` ; au survol : nom du nutriment (couleur du
  quartier), `X,X g` (gras 18 px), `N kcal · P %` ;
- aucune donnée → anneau gris + texte italique `aucune donnée`.

#### h) Carte coût + ajustement des portions

- Ligne 1 : `Coût total :` + `X,XX €` (Lg semi-gras) + `soit X,XX € / portion` + à droite, si besoin,
  `⚠ N ingrédient(s) sans prix` en `colorWarning`.
- Séparateur 1 px.
- Ligne 2 : `Ajuster les portions :` + spin **1 → 99** (pas 1) lié à `displayPortions` + mot
  `portions` + (si mis à l'échelle) `× X,XX (recette pour M)` en warning + bouton ghost
  `Réinitialiser`.
- La bordure de la carte passe en `colorWarning` 60 % quand la recette est mise à l'échelle.

#### i) Journal de cuisson (visible seulement si la recette est enregistrée)

`📖 Journal de cuisson` + statut `Cuisinée N× ce mois` (en `colorPrimary`) ou
`Pas encore cuisinée ce mois` (gris) + bouton secondary `✓ Cuisinée aujourd'hui` + bouton ghost
`Voir l'historique`.
`✓ Cuisinée aujourd'hui` enregistre `{cookedAtIso: aujourd'hui (YYYY-MM-DD), rating: 0, notes: ""}`
puis affiche un toast vert `✓ Cuisinée aujourd'hui — bon appétit !` (3 s).
`Voir l'historique` → `CookingHistoryDialog.openFor(recipeId, nom || "(sans nom)", window)`.

#### j) Enregistrement

Bouton primary `Enregistrer la recette` → `recipeEditorVM.saveCurrent()` puis
`recipeListVM.refreshList()`. Si la sauvegarde échoue (ex. nom vide), rien d'autre ne se produit.

### 3.4 Garde-fou « modifications non sauvegardées »

Avant de changer de recette ou de cliquer sur `Nouvelle`, si `recipeEditorVM.hasUnsavedChanges`, une
modale s'intercale (`AppConfirmDialog` mode `save`, largeur 480) :
- titre : `Modifications non sauvées`
- message : `La recette en cours d'édition a des modifications non sauvegardées. Veux-tu les
  enregistrer avant de continuer ?`
- boutons, de gauche à droite : `Annuler` (secondary) — puis, poussés à droite — `Abandonner`
  (danger) et `Enregistrer` (primary).
- `Enregistrer` → sauvegarde puis bascule ; si la sauvegarde échoue, la bascule est annulée.
- `Abandonner` → recharge l'état persistant (ou vide) puis bascule.
- `Annuler` / `Échap` → annule la bascule **et restaure la sélection visuelle** dans la liste.

### 3.5 Toasts

| Toast | Couleur | Durée | Texte |
|---|---|---|---|
| Photo enregistrée | success | 3 s | `✓ Photo enregistrée` |
| Erreur photo | error | 5 s | message de `recipeEditorVM.error_emitted` (texte multi-lignes) |
| Cuisson | success | 3 s | `✓ Cuisinée aujourd'hui — bon appétit !` |
| Undo suppression | ardoise | 5 s | `Recette « <nom> » supprimée` + bouton `Annuler` |

### 3.6 Raccourcis de la page

`Ctrl+N` (nouvelle), `Ctrl+S` (enregistrer, si une recette est chargée), `Suppr` (supprimer la recette
sélectionnée). **Pas de `Ctrl+F`** sur cet onglet.

### 3.7 Dialogues ouverts depuis cette page

`ImportRecipeUrlDialog` (bouton `Importer URL` ; au succès →
`recipeListVM.refreshList()` + `recipeEditorVM.loadById(nouvelId)`), `CookingHistoryDialog`,
le sélecteur de fichier natif du bloc photo, et la modale de modifications non sauvegardées.

---

## 4. Onglet 3 — Calendrier (`CalendarPage.qml`)

### 4.1 Structure

`RowLayout` (marges 16) : **[ScrollView principal élastique] [panneau latéral 0 ou 240 px]**.
Le ScrollView fait défiler **toute** la page (navigation + grille + récap + coût + historique) ; il
n'y a pas de scroll interne à la grille et le défilement horizontal est désactivé.

### 4.2 Barre de navigation

| Bouton | Variante | Action |
|---|---|---|
| `‹ Semaine précédente` | secondary | `calendarVM.shiftWeek(-1)` |
| `Aujourd'hui` | ghost | `calendarVM.setIsoWeek(<semaine ISO courante calculée en JS>)` |
| `Semaine suivante ›` | secondary | `calendarVM.shiftWeek(1)` |
| *(séparateur vertical 1 × 24 px)* | | |
| `📋 Copier la semaine précédente` | ghost | voir §4.6 |
| `📁 Templates ▾` | ghost | ouvre la popup de templates ancrée sous le bouton |
| `💾 Sauver semaine` | ghost | **actif seulement si la semaine courante contient ≥ 1 entrée** ; ouvre le dialogue de nom |
| `🗂️ Drag-drop` (devient `🗂️ ‹` quand ouvert) | ghost | ouvre/ferme le panneau latéral |

À droite : `Semaine <isoWeek>` (ex. `Semaine 2026-W18`) en Lg semi-gras.

### 4.3 Grille 7 jours × 5 créneaux

Carte surface. Colonne de gauche fixe à **130 px** (alignée sur le tableau de récap en dessous).

- **En-tête** : cellule vide 130 px, puis 7 colonnes élastiques de 60 px de haut, chacune empilant la
  date (`<mois court> <jour>`, ex. `avr 28`, XS secondaire centré) au-dessus du nom du jour
  (`Lundi`…`Dimanche`, Md semi-gras centré).
- **5 lignes**, libellés à droite, verticalement centrés, retour à la ligne autorisé :
  `Matin` · `10 h (en-cas)` · `Midi` · `16 h (goûter)` · `Soir`
  → clés techniques `morning`, `snack_morning`, `noon`, `snack_afternoon`, `evening`.
  Les 5 créneaux sont **toujours affichés** (plus de toggle).
- **Cellule** (`MealSlot`) :
  - hauteur : `max(140, 16 + n×28 + (n−1)×4 + (n>0 ? 8 : 0) + 22)` où *n* = nombre d'entrées ;
    toutes les cellules d'une même ligne prennent la hauteur de la plus haute ;
  - **toute la surface est cliquable** → ouvre le dialogue d'ajout pour ce (jour, créneau) ;
  - entrée = pilule 28 px, fond `primary` 10 %, texte pré-calculé côté Python :
    `🍽 <nom recette> (N portions)` (ou `(1 portion)`) / `🥕 <nom ingrédient> (X g)` ;
    bouton `✕` à droite (22 px, rouge au survol) → `calendarVM.removeEntry(entryId)` ;
  - libellé `+ Ajouter` toujours visible, collé en bas, qui passe en `colorPrimary` semi-gras au
    survol de la cellule ;
  - **cible de drop** : recevoir une chip d'ingrédient ajoute `pieceWeightG` grammes si un poids
    unitaire est défini, sinon **100 g** ; feedback : fond `primary` 18 % + bordure 2 px.

### 4.4 Récap nutritionnel par jour

`NutritionPanel` aligné au pixel sur la grille (colonne de libellé 130 px, colonnes élastiques,
espacement 4 px, valeurs centrées, pictos 18 px).
Titre : `Apports nutritionnels par jour  ·  Semaine : <N> kcal` (kcal arrondi).
7 colonnes = `Lundi`…`Dimanche`, 8 lignes = les mêmes nutriments/décimales qu'au §3.3g.
**Visible seulement si le total hebdomadaire en kcal est > 0.**

### 4.5 Coût de la semaine + historique

- Carte coût : `Coût de la semaine :` + `X,XX €` (Lg semi-gras) + à droite
  `⚠ N ligne(s) sans prix` si applicable.
- Mini-graphique (hauteur 110, visible seulement s'il y a un historique) sur les **12 dernières
  semaines** (`calendarVM.costHistoryRecent(12)`) :
  - titre `Évolution sur N semaine(s)` ; à droite `Moyenne : X,XX €` (affichée seulement à partir de
    2 points) ;
  - barres : hauteur = `max(2, round(valeur / max × 60))` px, largeur ≤ 28 px, espacement 4 ;
    semaine courante en `colorPrimary` plein, les autres à 45 % d'opacité ;
  - survol d'une barre → affiche `X,XX €` au-dessus ; clic → `calendarVM.setIsoWeek(...)` ;
  - étiquettes sous les barres : `W18` (les 6 premiers caractères de `2026-W18` sont retirés), 9 px,
    la semaine courante en primary semi-gras.

### 4.6 Copier la semaine précédente

- Si la semaine courante est **vide** → copie immédiate.
- Sinon → modale (largeur 460, boutons standard OK / Annuler) titrée
  `Copier la semaine précédente`, texte HTML :
  `Cette semaine contient déjà des entrées. Les entrées de la semaine précédente vont être
  <b>ajoutées</b> (pas remplacées). Continuer ?`
  ⚠️ Les libellés des deux boutons sont ceux, par défaut, de Qt (`OK` / `Cancel`) — non maîtrisés
  dans le QML.
- Résultat, via un toast (4 s) : succès (vert) `✓ N entrée(s) copiée(s) depuis la semaine
  précédente.` / échec (orange) `La semaine précédente est vide — rien à copier.`

### 4.7 Templates de semaine

**Popup `📁 Templates ▾`** (largeur 320, ancré 4 px sous le bouton, se ferme sur Échap ou clic
extérieur) :
- si vide : `Aucun template sauvé. Configure une semaine puis clique « 💾 Sauver ».`
- sinon : `Cliquez un template pour l'appliquer à la semaine courante :`
- chaque template = ligne 40 px : nom (Md) + `N entrée(s)` (XS gris) + `✕` (rouge au survol) qui
  supprime le template et rafraîchit la liste.
- Clic sur la ligne : si la semaine courante contient déjà des entrées, on demande confirmation via
  `AppConfirmDialog` mode `save`, titre `Appliquer un template`, message
  `Cette semaine contient déjà des entrées. Les entrées du template vont être ajoutées (pas
  remplacées). Continuer ?`, boutons `Annuler` / `Annuler l'application` / `Appliquer`.
  ⚠️ Dialogue à 3 boutons pour un choix binaire : « Annuler l'application » ne fait rien, exactement
  comme « Annuler ».
- Toast : `✓ N entrée(s) appliquée(s) depuis le template` ou `Template vide — rien à appliquer`.

**Dialogue `💾 Sauver semaine`** (modal, 460, OK / Annuler) :
titre `Sauver la semaine comme template`, texte
`Donne un nom à ce template (ex : « Menu hiver », « Menu vacances »). Si un template du même nom
existe, il sera remplacé.`, champ placeholder `Nom du template` (Entrée valide).
Un nom vide annule silencieusement. Toast de succès :
`✓ Template « <nom> » sauvé (N entrée(s))`.

### 4.8 Panneau latéral « Ingrédients rapides » (240 px, animation 250 ms)

Titre `Drag → Calendrier`, aide
`Glisse une chip vers une cellule pour ajouter 100 g (ou 1 pièce si poids unitaire défini).`,
champ `Filtrer…` (sans debounce), puis un `Flow` de chips draggables.
Contenu : `ingredientVM.searchOnce(<filtre>, "personal", 100)` ; si le filtre est vide et que la
recherche renvoie une liste vide, repli sur les 100 premières lignes du modèle de la bibliothèque.

Chip (`DraggableIngredientChip`) : pilule 28 px, pastille de couleur source 6 px
(vert `#15803d` CIQUAL / bleu `#1d4ed8` OFF / orange `#c2410c` manuel), nom (Sm medium, tronqué à
160 px), mention `● 1pc` si poids unitaire. Pendant le drag, un **fantôme** séparé (pilule primary
92 %, texte blanc `🛒  <nom>`) suit la souris ; la chip d'origine ne bouge jamais (seuil de drag 6 px).

### 4.9 Ajout d'une entrée + toasts + raccourcis

- `AddCalendarEntryDialog.openFor(jour, créneau, window)` (fenêtre détachable). Retour :
  `recipePicked(jour, créneau, recipeId, portions)` → `calendarVM.addRecipe(...)` ou
  `ingredientPicked(jour, créneau, ingredientId, quantité)` → `calendarVM.addIngredient(...)`.
- `UndoToast` à la suppression d'une entrée : `<description de l'entrée> retiré` + `Annuler` (5 s).
- Raccourcis (onglet visible seulement) : `Ctrl+←` semaine précédente, `Ctrl+→` semaine suivante,
  `Ctrl+T` semaine courante.
- La semaine ISO courante est recalculée **côté QML en JavaScript** (algorithme du jeudi ISO) au
  format `YYYY-Www` avec numéro sur 2 chiffres.

---

## 5. Onglet 4 — Liste de courses (`ShoppingPage.qml`)

Semaine ISO **indépendante** de celle du calendrier (on peut préparer la semaine suivante sans
changer la vue du calendrier).

### 5.1 Structure

`ColumnLayout` (marges 16) : barre de navigation → liste (élastique) → bandeau de total.

### 5.2 Barre de navigation

`‹ Semaine précédente` (secondary) · `Synchroniser avec calendrier` (ghost →
`shoppingVM.setIsoWeek(calendarVM.isoWeek)`) · `Semaine suivante ›` (secondary) · espace ·
`Liste de courses · Semaine <isoWeek>` (Lg semi-gras).

Note du code : les boutons d'import de ticket ont été **déplacés vers l'onglet Frigo / Cellier**.

### 5.3 Liste

Carte surface. **Sections par rayon** (`categoryL1`) : bandeau 32 px, fond `primary` 6 %, texte
`primary` Sm semi-gras **en majuscules**, interlettrage 0,5 ; `NON CATÉGORISÉ` si le rayon est vide.

Ligne de **44 px**, de gauche à droite :
1. **case à cocher « déjà au frigo »** — pré-cochée automatiquement quand le stock du frigo couvre le
   besoin (`is_covered_by_pantry`) ; clic → `shoppingVM.setInFridge(ingredientId, coché)`.
   ⚠️ Cet état est **de session uniquement**, non persisté.
2. **nom** (Md medium) — passe en gris **barré** quand la case est cochée ; la ligne entière prend un
   fond `colorSuccess` 6 %.
3. **quantité** (200 px, alignée à droite, XS secondaire), formatée ainsi :
   - `≥ 1000 g` → `X,XX kg` (2 décimales si < 10 kg, sinon 1 décimale) ;
   - `≥ 10 g` → `N g` (arrondi entier) ;
   - sinon → `X,X g` ;
   - si un poids unitaire est connu, on ajoute `  ≈ N pièce(s)` (nombre de pièces arrondi au
     dixième ; entier affiché sans décimale ; pluriel dès > 1).
4. **coût** (80 px, aligné à droite, Md semi-gras) : `X,XX €` si le prix est connu, sinon
   `(prix manquant)` en XS `colorWarning`.

**État vide** : `Aucun ingrédient à acheter` (Lg medium) + `Planifie des recettes ou des ingrédients
dans le Calendrier pour cette semaine, puis reviens ici.` (360 px, centré).

### 5.4 Bandeau de total

`N ingrédient(s)` (Sm medium) · `⚠ N sans prix` (si applicable) · espace · `Total :` ·
`X,XX €` (XL semi-gras) · bouton primary `📋 Copier la liste` (désactivé si la liste est vide).

Le bouton copie dans le presse-papier système le rendu texte produit par
`shopping_service.format_as_text(...)` puis affiche un toast vert 3 s :
`✓ Liste copiée dans le presse-papier`.

**Aucun raccourci clavier** sur cet onglet.

---

## 6. Onglet 5 — Frigo / Cellier (`PantryPage.qml`)

### 6.1 Structure

`RowLayout` (marges 16) : **[colonne principale] [panneau latéral 0 ou 240 px]**.
Colonne principale : en-tête → barre de contrôles → liste (élastique, cible de drop).

### 6.2 En-tête

À gauche, empilés :
- titre `Frigo / Cellier` (XL semi-gras) ;
- sous-titre : `Aucun stock enregistré — clique sur Ajouter pour démarrer.` si le stock est vide ;
  sinon `N article(s)` suivi, si applicable, de `  ·  ⚠️ N à consommer rapidement`. Le sous-titre
  passe en **rouge** (`colorError`) dès qu'il y a au moins un article urgent.

À droite, 4 boutons :

| Bouton | Variante | Action |
|---|---|---|
| `📥 Importer un ticket (PDF)` | secondary | `window.receiptImportDialog.openCentered(window)` |
| Bouton Lidl à libellé **dynamique** | secondary | voir ci-dessous |
| `+ Ajouter au stock` | primary | ouvre `AddPantryStockDialog` centré |
| `🗂️ Bibliothèque` / `🗂️ ‹` | ghost | ouvre/ferme le panneau latéral ; tooltip (600 ms, seulement fermé) `Glisse un ingrédient depuis ce panneau vers le frigo` |

Libellé du bouton Lidl, dans l'ordre : `🛒 Lidl Plus…` (VM absent) → `🛒 Lidl Plus (lib manquante)` →
`🛒 Configurer Lidl Plus…` (non connecté) → `🛒 Sync Lidl… ⏳` (synchronisation en cours) →
`🛒 Synchroniser Lidl`. Clic : si la lib manque **ou** si on n'est pas connecté → ouvre
`LidlPlusSetupDialog` ; sinon → `lidlPlusVM.syncNow()`.

### 6.3 Barre de contrôles

| Contrôle | Options (libellé → code) |
|---|---|
| Champ texte 240 px, placeholder `🔍 Filtrer par nom…` | `pantryVM.setFilter(text)` **à chaque frappe, sans debounce** |
| `Grouper :` (combo 140 px) | `Urgence`→`urgency`, `Rayon`→`category`, `Aucun`→`none` |
| `Trier :` (combo 160 px) | `Urgence (DLC)`→`urgency`, `Nom (A-Z)`→`name`, `Quantité ↓`→`quantity`, `Date péremption`→`expiry`, `Rayon`→`category` |

### 6.4 Liste

La carte entière est une **zone de dépôt**. Pendant un survol de drag : bordure 2 px `colorPrimary`,
voile `primary` 10 %, et texte centré `⬇  Lâche ici pour ajouter au frigo` (Lg semi-gras).

**En-têtes de section** (36 px, fond `colorBackground`, Md semi-gras) :
- groupement `Urgence` → `🔥 À consommer vite (≤ 5 jours)` en rouge, `⏳ À surveiller (≤ 14 jours)`
  en orange, `🥫 En stock` en couleur de texte normale ;
- groupement `Rayon` → le nom du rayon brut ;
- groupement `Aucun` → pas d'en-tête.

**Ligne de 56 px** :
- pastille d'urgence 8 px : rouge (`soon`), orange (`watch`), verte (`stock`) ;
- nom (Md medium, ellipsé) ;
- sous-ligne XS (3 blocs séparés de 12 px) :
  - **quantité** — mêmes règles qu'au §5.3 mais le nombre de pièces est affiché avec **1 décimale si
    < 10 pièces, 0 sinon**, et le séparateur est ` · ≈ ` (au lieu de `  ≈ `) ;
  - **péremption** (couleur = celle du niveau d'urgence, gras si non `stock`) :
    | Cas | Texte |
    |---|---|
    | pas de date | `Pas de date` |
    | jours < 0 | `🛑 Périmé depuis Nj` |
    | 0 | `⚠️ Périme aujourd'hui` |
    | 1 | `⚠️ Périme demain` |
    | 2 → 5 | `⚠️ Dans N jours` |
    | > 5 | `Dans N jours` |
  - **notes** préfixées `📝 ` (max 240 px, ellipsées), masquées si vides ;
- **bouton `✕`** (32 px, rouge au survol), tooltip 400 ms `Retirer du stock` → confirmation.
- séparateur 1 px (30 % d'opacité) sous chaque ligne ; survol = fond `colorSurfaceHover`.

**Confirmation de retrait** (`AppConfirmDialog` mode `destroy`, largeur 480) :
titre `Retirer du stock`, message `Retirer « <nom> » du stock ?`, boutons `Annuler` (secondary) /
`Retirer` (danger). À la validation : `pantryVM.deleteStock(stockId)` puis
`shoppingVM.refreshList()` (le pré-cochage de la liste de courses dépend du stock).

**État vide** : texte centré sur 3 lignes —
`🥫` / `Votre frigo est vide.` / `Clique « + Ajouter au stock » pour commencer.`

### 6.5 Popup d'ajout rapide (au dépôt d'une chip)

Popup **modal 380 px**, centré sur la page, bordure `colorPrimary`.

- Titre : `Ajouter au frigo : <nom de l'ingrédient>`
- Aide italique : `Astuce : appuie sur Entrée pour valider sans toucher aux champs.`
- Champ `Quantité` : `QuantityField` (mêmes unités qu'au §3.3f), pré-rempli au **poids unitaire s'il
  existe, sinon 100 g**, 1 décimale.
- Champ `Date de péremption (optionnelle)` : texte, placeholder `JJ/MM/AAAA`. À la perte de focus,
  la saisie est analysée par l'expression `^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$` et convertie
  en ISO `AAAA-MM-JJ` (avec zéros de tête). Une saisie non conforme est **ignorée silencieusement**
  (la date ISO reste celle d'avant). Bouton `📅` (32 × 32, ghost) → `DatePickerPopup` ; le choix
  remplit à la fois la date ISO et l'affichage `JJ/MM/AAAA`.
- Boutons : `Annuler` (ghost) et `✓ Ajouter` (primary). **Le focus est mis sur `✓ Ajouter`** à
  l'ouverture, si bien qu'`Entrée` valide immédiatement ; `Échap` ferme.
- Validation → `pantryVM.addStock({ingredientId, quantityG, expiryIso, notes: ""})` puis toast vert
  2,5 s : `✓ <nom> ajouté au frigo (N g)` (grammes arrondis à l'entier).

### 6.6 Panneau latéral

Identique à celui du calendrier (§4.8) sauf le texte :
titre `Drag → Frigo`, aide `Glisse une chip vers la liste pour ouvrir un mini-popup (qty + DLC).
Astuce : appuie sur Entrée pour valider directement avec les valeurs par défaut.`

### 6.7 Ajout via le dialogue

`AddPantryStockDialog` renvoie une charge utile → `pantryVM.addStock(payload)` ; en cas de succès,
`shoppingVM.refreshList()` est appelé. **Aucun raccourci clavier** sur cet onglet.

---

## 7. Tableau récapitulatif des raccourcis effectivement câblés

| Touche | Portée | Effet |
|---|---|---|
| `Ctrl+1` … `Ctrl+5` | fenêtre (menu Navigation) | change d'onglet |
| `Ctrl+K` | fenêtre | recherche unifiée |
| `Ctrl+/` | fenêtre (menu Aide) | dialogue des raccourcis |
| `Ctrl+Shift+D` | fenêtre (menu Affichage) | bascule clair / sombre |
| `StandardKey.Quit` | fenêtre (menu Fichier) | quitter |
| `Ctrl+N` | Ingrédients, Recettes | créer |
| `Ctrl+S` | Ingrédients, Recettes | enregistrer |
| `Suppr` | Ingrédients, Recettes | supprimer / retirer la sélection |
| `Ctrl+F` | Ingrédients **uniquement** | focus sur la recherche |
| `Ctrl+←` / `Ctrl+→` / `Ctrl+T` | Calendrier | semaine −1 / +1 / courante |
| `Entrée` | popup d'ajout rapide (Frigo) | valider avec les valeurs par défaut |
| `↑ / ↓ / Entrée / Échap` | popups de recherche (Ctrl+K, IngredientSearch) | navigation clavier |

Les raccourcis de page sont conditionnés par `enabled: page.visible` — ils ne se déclenchent que sur
l'onglet actif.

---

## 8. États de chargement

Constat important pour le portage : **il n'existe quasiment aucun état de chargement dans ces 5
pages**. Tout est synchrone (SQLite local) et les listes apparaissent instantanément. Le seul
indicateur temporel visible depuis les pages est :
- le libellé `🛒 Sync Lidl… ⏳` du bouton Lidl (onglet Frigo) pendant `lidlPlusVM.isSyncing` ;
- la pastille réseau OpenFoodFacts de la barre de statut.
Un composant `AppSpinner` existe dans `components/` mais **n'est utilisé par aucune de ces 5 pages**
(seulement par des dialogues d'import). En web, toute lecture devenant un aller-retour réseau, il
faudra **ajouter** des états de chargement/squelettes partout où la desktop n'en avait pas.

---

## 9. Jetons de design (`Theme.qml`) — à reproduire en CSS

| Catégorie | Valeurs |
|---|---|
| Primaire | `#2563eb` clair / `#3b82f6` sombre (hover `#1d4ed8` / `#60a5fa`, pressed `#1e40af` / `#2563eb`, disabled `#cbd5e1` / `#475569`) |
| Secondaire | `#7c3aed` / `#a78bfa` |
| Fond / surface | fond `#f8fafc` / `#0f172a` · surface `#ffffff` / `#1e293b` · surfaceHover `#f1f5f9` / `#334155` · surfacePressed `#e2e8f0` / `#475569` |
| Texte | `#0f172a` / `#f1f5f9` · secondaire `#475569` / `#94a3b8` · désactivé `#cbd5e1` / `#94a3b8` · placeholder `#94a3b8` / `#64748b` |
| Bordures | `#e2e8f0` / `#334155` · hover `#cbd5e1` / `#475569` · focus `#3b82f6` / `#60a5fa` |
| Sémantiques | accent `#0891b2` / `#22d3ee` · error `#dc2626` / `#f87171` · success `#16a34a` / `#4ade80` · warning `#ea580c` / `#fbbf24` · overlay `rgba(0,0,0,0.45)` |
| Police | Segoe UI (Windows) / SF Pro Text (macOS) / Inter (autres) |
| Tailles | XS 10 · Sm 11 · **Md 13 (base)** · Lg 15 · XL 18 · Titre 22 |
| Graisses | 400 / 500 / 600 / 700 |
| Espacements | 4 · 8 · 12 · 16 · 24 · 32 |
| Rayons | 4 · 6 · 10 · 14 · 9999 |
| Durées | 150 · 250 · 400 ms (easing OutCubic / OutQuad / InQuad) |
| Hauteurs de contrôle | Sm 28 · **Md 36 (champs, boutons, combos)** · Lg 44 |

Couleurs **hors thème**, codées en dur dans les pages (à conserver telles quelles) :
badges source `#15803d` / `#1d4ed8` / `#c2410c` ; macros dans la liste d'ingrédients `#0B6BBB`
(protéines) / `#509938` (glucides) / `#FDA406` (lipides) ; donut : + `#7CC04C` (fibres),
`#F1B40E` (énergie), `#DA4A35` (saturés), `#07A0AA` (sucres), `#7145A7` (sel) ;
fond du toast d'annulation `#1f2937`.

Les **pictos de nutriments** sont des PNG locaux : `components/icons/nutrient/{energy, fats,
saturatedFats, carbs, sugars, fiber, proteins, salt}.png` (rendus en 22 px sur Recettes / 24 px sur
Ingrédients / 18 px sur Calendrier, chargés en ×2 pour le HiDPI).

Formatage numérique : tout passe par `Number(...).toLocaleString(Qt.locale(), 'f', n)` — locale
système **française** → séparateur décimal **virgule**. Équivalent web : `Intl.NumberFormat('fr-FR',
{minimumFractionDigits: n, maximumFractionDigits: n})`.

---

## 10. Spécificités desktop qui ne se portent pas telles quelles

| Élément desktop | Où | Proposition web |
|---|---|---|
| Barre de menus native (4 menus, mnémoniques Alt) | Main | Aucun équivalent : déplacer vers un menu « ⋯ » en en-tête + une page **Réglages** (restauration, Lidl Plus, rayons, thème, logs) |
| `SplitView` 2 panneaux redimensionnables | Ingrédients, Recettes | Desktop : grille CSS 2 colonnes redimensionnable (`resize`/drag). Mobile : navigation **liste → détail** (voir §11) |
| Fenêtres détachables (`Window`) pour les dialogues | Import, Prix, Historique, Lidl, Ticket… | Modales/routes plein écran ; sur mobile, **bottom sheets** |
| `FileDialog` natif (photo de recette) | Recettes | `<input type="file" accept="image/*">` ; sur mobile, ajouter `capture="environment"` |
| Glisser-déposer souris + onglets magnétiques (300 ms) | Ingrédients→Frigo, panneaux latéraux | Desktop : HTML5 DnD ou pointer events. Mobile : **remplacer par une action explicite** (« Ajouter au frigo », « Ajouter au calendrier ») dans un menu contextuel de ligne — le DnD tactile est trop fragile |
| Glisser une image depuis le navigateur/l'explorateur vers la zone photo | Recettes | Zone de dépôt HTML5 (`dragover`/`drop`, `DataTransfer.files` + `text/uri-list`) ; sur mobile : bouton + champ URL |
| Presse-papier système (`QClipboard`) | Liste de courses | `navigator.clipboard.writeText()` ; sur mobile ajouter un **partage natif** (`navigator.share`) |
| `Qt.openUrlExternally` (fiche CIQUAL/OFF, dossier de logs) | Ingrédients, Aide | `<a target="_blank" rel="noopener">` ; le dossier de logs n'a **pas** d'équivalent (à remplacer par une page de diagnostic) |
| Surveillance de dossier (badge « N tickets en attente ») | Barre de statut | Upload manuel + file d'attente serveur ; badge alimenté par polling/SSE sur une file « tickets à traiter » |
| Détection réseau (pastille OpenFoodFacts) | Barre de statut | `navigator.onLine` + un ping de santé côté Worker ; la vérification manuelle au clic reste pertinente |
| Tooltips au survol (drag, prix, ✕, barres du graphe) | partout | Aucun survol sur mobile : convertir en libellés visibles, en appui long, ou supprimer |
| Raccourcis `Ctrl+N/S/T/F/W/1-5` | toutes pages | Conflits avec le navigateur (`Ctrl+N` nouvelle fenêtre, `Ctrl+T` nouvel onglet, `Ctrl+W` fermer). Remapper : `Ctrl+K` et `/` sont sûrs ; préférer `e`, `n`, `s` sans modificateur quand aucun champ n'a le focus, ou `Ctrl+Entrée` pour enregistrer |
| Persistance des options de tri/filtre via `QSettings` | Ingrédients | `localStorage` (ou une table de préférences côté D1 si on veut du multi-appareil) |
| `Canvas` Qt pour le donut | Recettes | `<canvas>` ou SVG ; la logique Atwater est portable telle quelle |
| Pages instanciées en permanence (état conservé entre onglets) | Main | Garder les états d'écran en mémoire (store client), ne pas démonter les vues au changement d'onglet ; sinon on perd le scroll et les formulaires en cours |
| Ombres simulées par empilement de rectangles | Theme | `box-shadow` natif |

---

## 11. Adaptations mobile, écran par écran

### 11.1 Contrainte structurante

**Deux écrans sur cinq reposent sur un `SplitView` à deux panneaux** (Ingrédients : 42 %/58 % ;
Recettes : 30 %/70 %) et **deux autres ont un panneau latéral coulissant de 240 px** (Calendrier,
Frigo). Aucun de ces schémas ne tient sur une largeur de 360–430 px : il faut passer d'une
**maître-détail simultanée** à une **navigation en pile** (liste → détail → retour).

### 11.2 Ingrédients

- Écran 1 = **liste**. Barre de recherche collante en haut ; tri / groupement / filtres regroupés
  dans **une seule barre d'actions** (`Trier ▾`, `Grouper ▾`, `🔧 Filtres · N`) ouvrant des feuilles
  de sélection.
- La ligne à 52 px passe à ~64 px pour respecter les 44 px de cible tactile ; les 3 macros
  P/G/L peuvent être réduites à 2 lignes ou masquées sous 380 px.
- La **case à cocher multi-sélection** devient un **mode « sélection »** (bouton « Sélectionner »)
  pour ne pas gêner le tap normal ; le bandeau « Trouver les recettes » devient une **barre d'action
  flottante en bas**.
- La **poignée de drag `⠿`** disparaît → remplacée par un menu de ligne (appui long ou `⋮`) avec
  « Ajouter au frigo » / « Ajouter au calendrier ».
- Écran 2 = **formulaire** plein écran, en pile. Le tableau nutritionnel à 8 champs doit passer en
  une colonne (libellé au-dessus du champ) ; envisager un **accordéon** « Valeurs nutritionnelles »
  replié par défaut, car 8 champs + prix + poids + rayon + 12 mois = écran très long.
- Les 12 bascules de saison (28 px) → grille 6 × 2 avec des cibles de 40 px.
- Boutons `Enregistrer` / `Retirer` en **barre d'action fixe en bas**.

### 11.3 Recettes

- Écran 1 = liste (la ligne de 68 px avec vignette 56 px fonctionne bien telle quelle en tactile).
  Le filtre par tags reste un `Flow` de chips défilable horizontalement.
- Écran 2 = éditeur plein écran, **découpé en sections repliables ou en onglets internes** :
  `Infos` (photo, nom, portions, tags) · `Ingrédients` · `Nutrition` · `Coût & portions` ·
  `Instructions` · `Journal`.
- La ligne d'ingrédient (nom 220 px + quantité 240 px + notes 320 px + ✕) **ne rentre pas** : la
  passer en carte à 2 lignes — ligne 1 : nom + `✕` ; ligne 2 : quantité + unité ; notes en 3e ligne
  ou derrière un bouton « + Note ».
- Le duo tableau nutritionnel + donut passe en **empilement vertical** ; le tableau à 3 colonnes de
  valeurs tient encore en 360 px si on réduit la colonne de libellés et qu'on retire les pictos, sinon
  prévoir un défilement horizontal du tableau seul.
- Le survol du donut n'existe pas : rendre les quartiers **tappables** (le centre affiche alors le
  détail, avec un retour au total après un nouveau tap).
- La modale « modifications non sauvées » à 3 boutons → feuille d'action iOS/Android
  (`Enregistrer` / `Abandonner` / `Annuler`).

### 11.4 Calendrier

C'est **l'écran le plus problématique** : une grille 7 × 5 de cellules d'au moins 140 px de haut
représente ≈ 900 px de large minimum.

Proposition : **vue « un jour à la fois »** sur mobile.
- En-tête : sélecteur de semaine (`‹ S18 ›`) + une bande horizontale des 7 jours (chips
  `L 28` `M 29` …) faisant office de sélecteur de jour, avec un point indiquant les jours remplis.
- Corps : les 5 créneaux du jour sélectionné, empilés verticalement, chacun avec ses entrées et un
  bouton `+ Ajouter` pleine largeur.
- Le récap nutritionnel affiche alors **le jour courant** (colonne unique) + un pied « semaine ».
- Le mini-graphique 12 semaines reste tel quel (il est déjà compact et horizontal).
- Le panneau latéral de drag-drop **est supprimé** ; l'ajout se fait par le bouton `+ Ajouter` puis
  la recherche.
- Sur tablette (≥ 768 px), une vue **7 colonnes × 5 lignes compactée** (cellules 90 px) reste jouable
  en paysage ; en portrait, garder la vue jour.

### 11.5 Liste de courses

C'est **l'écran le plus mobile-ready** — et probablement l'usage n°1 en magasin :
- liste simple avec sections par rayon, une case à cocher, un nom, une quantité, un prix ;
- augmenter la hauteur de ligne à ~56 px et grossir la case à cocher (≥ 24 px, zone de tap 44 px) ;
- rendre les en-têtes de rayon **collants** pendant le défilement ;
- garder le total en **pied fixe** ; `📋 Copier la liste` devient `Partager` (`navigator.share`)
  avec repli sur la copie presse-papier ;
- persister les cases cochées côté serveur (aujourd'hui volatiles) sinon un rafraîchissement en
  magasin efface tout le travail.

### 11.6 Frigo / Cellier

- L'en-tête à 4 boutons ne tient pas : garder `+ Ajouter` en **FAB** et déplacer
  `Importer un ticket` / `Lidl` dans un menu `⋯` (ou dans la page Réglages / une page « Imports »).
- Barre de contrôles : `🔍` + `Grouper ▾` + `Trier ▾` en une ligne compacte, feuilles de sélection.
- La ligne à 56 px passe bien ; les notes peuvent être coupées à une ligne.
- Le `✕` de suppression → **balayage vers la gauche** (swipe-to-delete) avec la même confirmation.
- Panneau latéral et zone de drop supprimés ; le popup d'ajout rapide devient une **bottom sheet**
  (quantité + DLC + « Ajouter »), en réutilisant exactement les mêmes valeurs par défaut
  (poids unitaire ou 100 g).
- La saisie `JJ/MM/AAAA` → `<input type="date">` natif (le sélecteur maison n'a plus lieu d'être).

### 11.7 Navigation mobile proposée

**Barre d'onglets fixe en bas, 5 entrées** (reprise directe des 5 onglets, avec des libellés
raccourcis et des icônes) :

| Position | Icône | Libellé court | Écran |
|---|---|---|---|
| 1 | 🥕 | `Ingrédients` | liste + formulaire empilé |
| 2 | 🍽 | `Recettes` | liste + éditeur empilé |
| 3 | 📅 | `Semaine` | vue jour + sélecteur de semaine |
| 4 | 🛒 | `Courses` | liste de courses |
| 5 | 🥫 | `Frigo` | stock |

Et au-dessus :
- **En-tête compact** (56 px) : titre de l'écran + bouton `🔍` (ouvre la recherche unifiée
  plein écran, l'équivalent tactile de `Ctrl+K`, qui devient un point d'entrée de premier plan
  puisque le clavier disparaît) + bouton `⋯` (menu : Mode sombre, Rayons d'ingrédients, Imports de
  tickets, Lidl Plus, Restaurer une sauvegarde, Aide).
- **Pile de navigation par onglet** : chaque onglet conserve son propre historique (liste → détail),
  bouton retour dans l'en-tête, et **l'état est conservé au changement d'onglet** (comme le
  `StackLayout` desktop aujourd'hui).
- **Badges** : la barre de statut disparaît ; les tickets en attente deviennent un **badge numérique
  sur l'onglet Frigo** et l'état hors-ligne une **bannière** en haut de l'écran, pas une pastille.
- **Toasts** : les remonter au-dessus de la barre d'onglets (marge basse ≥ 72 px) sinon ils sont
  masqués ; conserver le bouton `Annuler` de 5 s (`UndoToast`), essentiel car aucune suppression sur
  Ingrédients/Recettes/Calendrier n'a de confirmation préalable.
- **Point de rupture** : ≥ 1024 px → revenir à la disposition deux panneaux d'origine (maître-détail
  simultanée) et à la grille calendrier 7 × 5 ; 768–1023 px → une colonne large mais grille
  calendrier compactée ; < 768 px → pile mobile décrite ci-dessus.

---

## 12. Ambiguïtés et incohérences relevées (à trancher avant le portage)

1. **Ctrl+K → ingrédient** : la bascule d'onglet a lieu mais `payload.id` n'est jamais utilisé, donc
   rien n'est sélectionné. Recettes et Calendrier, eux, agissent. Bug probable.
2. **`navigateToIngredient`** remplit le formulaire mais ne synchronise ni la sélection de la liste ni
   le filtre ; si l'ingrédient n'est pas dans la liste filtrée, on édite une fiche « invisible ».
3. **Affichage du prix** (`Prix (€) :`) : chaîne brute du Decimal (`"1.2000"`), sans virgule française
   ni symbole `€` — contredit tout le reste de l'app.
4. **Liste d'ingrédients sans résultat** : aucun état vide n'est affiché quand la recherche ne
   renvoie rien (le bloc n'apparaît que si le champ de recherche est vide).
5. **Asymétrie des confirmations** : suppression d'ingrédient et de recette = aucune confirmation
   (juste un toast d'annulation 5 s) ; suppression d'un stock du frigo = boîte de confirmation.
   À harmoniser côté web.
6. **`Suppr` en raccourci de fenêtre** : se déclenche même quand le focus est dans un champ texte des
   pages Ingrédients / Recettes.
7. **`_silenceMetaPush`** (Recettes) est mis puis remis à `false` de façon synchrone autour de
   `loadById()` ; si les `onTextChanged` des champs se déclenchent après (rebinding), le garde-fou ne
   protège rien et la recette est marquée « modifiée » dès son chargement. Comportement à vérifier
   en exécution, à ne pas reproduire tel quel.
8. **`💾 Sauver semaine`** : `enabled` est lié à l'appel de fonction `currentWeekEntryCount()`, sans
   signal de notification — l'état activé/désactivé peut rester périmé après un ajout d'entrée.
9. **Confirmation « Appliquer un template »** : 3 boutons pour 2 choix, `Annuler l'application` étant
   fonctionnellement identique à `Annuler`.
10. **Modale « Copier la semaine précédente »** : boutons standard Qt, donc libellés non maîtrisés
    (`OK` / `Cancel` selon la locale Qt) — à fixer explicitement en web.
11. **Cases « déjà au frigo »** de la liste de courses : état de session non persisté ; disparaît au
    changement de semaine ou au redémarrage.
12. **`_findRecipes(minMatch)`** : le paramètre est passé (`0.5`) mais ignoré ; c'est `max_missing = 3`
    qui pilote réellement le résultat.
13. **Champ Énergie** : `FixedUnitField` a 2 décimales par défaut et la page ne le surcharge pas — les
    kcal se saisissent donc en `423,00 kcal/100g`, ce qui est probablement involontaire.
14. **Filtre du frigo** sans debounce (une requête par frappe), contrairement aux autres champs de
    recherche (200 ms) — à uniformiser en web où chaque frappe coûterait un aller-retour réseau.
15. **Sélection multiple d'ingrédients** (cases à cocher) : n'est pas remise à zéro quand le filtre,
    le tri ou le groupement changent ; on peut donc lancer une recherche de recettes sur des
    ingrédients qui ne sont plus visibles.
16. **`categoryL2` toujours forcé à `null`** à chaque enregistrement d'ingrédient : nettoyage
    progressif volontaire des seeds CIQUAL — à décider si on porte la colonne ou pas.
