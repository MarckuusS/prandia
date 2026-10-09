# 07 — Dialogues, composants réutilisables et jetons de design

Spécification de portage établie par **lecture directe du code QML** (aucune information tirée de
`CLAUDE.md` / `architecture.md`, réputés périmés). Sources analysées :

- `app/ui/qml/Theme.qml`
- `app/ui/qml/dialogs/` — 16 fichiers
- `app/ui/qml/components/` — 25 fichiers
- `app/ui/qml/Main.qml` et `app/ui/qml/pages/*.qml` (uniquement pour identifier les **déclencheurs**
  et le **câblage des signaux** de chaque dialogue)

Convention de lecture : les libellés français sont donnés **tels quels**, entre guillemets, y compris
les emoji, les espaces et la ponctuation. Les identifiants de code (propriétés, slots, signaux)
restent en anglais.

---

## Table des matières

1. [Inventaire et déclencheurs](#1-inventaire-et-déclencheurs)
2. [Jetons de design (`Theme.qml`) → variables CSS](#2-jetons-de-design-themeqml--variables-css)
3. [Dialogues — spécification détaillée](#3-dialogues--spécification-détaillée)
4. [Composants réutilisables porteurs de logique](#4-composants-réutilisables-porteurs-de-logique)
5. [Composants de chrome (styling pur)](#5-composants-de-chrome-styling-pur)
6. [Points de portage délicats (desktop → web)](#6-points-de-portage-délicats-desktop--web)
7. [Ambiguïtés et incohérences relevées dans le code](#7-ambiguïtés-et-incohérences-relevées-dans-le-code)

---

## 1. Inventaire et déclencheurs

### 1.1 Dialogues instanciés globalement dans `Main.qml`

`Main.qml` est un `ApplicationWindow` (1280×800, min 980×600, titre "Prandia"). Il expose
quatre alias pour que les pages enfants puissent atteindre des dialogues qui vivent au niveau global
(les `id` QML sont scopés par fichier) :

```qml
property alias receiptImportDialog:    receiptImportDialogInstance
property alias lidlPlusSetupDialog:    lidlPlusSetupDialogInstance
property alias categoryPickerDialog:   categoryPickerDialogInstance
property alias ingredientFilterDialog: ingredientFilterDialogInstance
```

| Dialogue | Déclencheur exact | Notes |
|---|---|---|
| `RestoreBackupDialog` | Menu **Fichier → « &Restaurer une sauvegarde… »** | `restoreDialog.openCentered(window)` |
| `LidlPlusSetupDialog` | Menu **Fichier → « Lidl Plus auto-fetch … »** (libellé dynamique, cf. §3.5) | `openCentered(window)` ; aussi bouton « ⚙ » de PantryPage |
| `SettingsCategoriesDialog` | Menu **Fichier → « &Paramètres → Rayons d'ingrédients… »** | `openCentered(window)` |
| `ShortcutsDialog` | Menu **Aide → « &Raccourcis clavier »**, raccourci **Ctrl+/** | `openCentered(window)` |
| `UnifiedSearchDialog` | Raccourci **Ctrl+K** (`context: Qt.WindowShortcut`) | `unifiedSearch.openCentered()` |
| `ReceiptImportDialog` | 3 chemins : (a) bouton « 📥 Importer un ticket (PDF) » de PantryPage → `openCentered(win)` ; (b) badge status bar « 📥 N tickets en attente » → `receiptImportVM.loadNextPending()` puis `openForPending(window)` ; (c) badge status bar « 🛒 Lidl · N tickets » → `lidlPlusVM.fetchTicketDetailAsDict(id)` + `receiptImportVM.loadFromLidlJson(detail)` puis `openForPending(window)` | |
| `CategoryPickerDialog` | Bouton « 📁 Choisir un rayon… » / « 📁 <rayon> » du formulaire ingrédient (IngredientsPage) | Connexion **dynamique** du signal `categorySelected`, déconnectée dans le handler |
| `IngredientFilterDialog` | Bouton « 🔧 Filtres » / « 🔧 Filtres · N » de la barre de contrôles d'IngredientsPage | `openCentered(win)` |

Menu **Fichier** complet : « &Restaurer une sauvegarde… », séparateur, entrée Lidl Plus, séparateur,
« &Paramètres → Rayons d'ingrédients… », séparateur, « &Quitter » (`StandardKey.Quit`).
Menu **Affichage** : « Mode &clair » / « Mode &sombre » (Ctrl+Shift+D).
Menu **Navigation** : « &1. Ingrédients » … « &5. Frigo / Cellier » (Ctrl+1 … Ctrl+5).
Menu **Aide** : « &Raccourcis clavier » (Ctrl+/), séparateur, « Ouvrir le dossier de &logs ».

Onglets (TabBar) : « Ingrédients » (160 px), « Recettes » (160), « Calendrier » (160),
« Liste de courses » (180), « Frigo / Cellier » (180). Changement d'onglet = animation d'opacité
0.55 → 1.0 sur `durationNormal` (250 ms), easing `OutCubic`.

### 1.2 Dialogues instanciés dans les pages

| Dialogue | Page hôte | Déclencheur | Signal remonté et action |
|---|---|---|---|
| `ImportIngredientDialog` | IngredientsPage | bouton « Importer un ingrédient » → `importDialog.openCentered(Window.window)` | `onLibraryChanged: ingredientVM.refreshList()` |
| `RecipeMatchDialog` | IngredientsPage | fonction `_findRecipes()` → `recipeListVM.findByIngredientsCategorized(ids, 3)` puis `setMatchesCategorized(result, ids.length, Window.window)` | aucun (le dialogue navigue lui-même via `transientParent.navigateToIngredient`) |
| `PriceHistoryDialog` | IngredientsPage | bouton « 📊  Historique » du formulaire ingrédient → `openFor(selectedId, nameField.text \|\| "(sans nom)", priceQtyDisplay.qtyValue)` | pas de signal : le VM émet `current_price_recomputed(id)` que la page écoute |
| `CookingHistoryDialog` | RecipesPage | bouton dédié → `openFor(recipeId, name, parentWindow)` | `onEntryAdded: page._refreshCookingStats()` |
| `ImportRecipeUrlDialog` | RecipesPage | bouton d'import URL → `openCentered(Window.window)` | `onImportCompleted(recipeId)` → `recipeListVM.refreshList()` + `recipeEditorVM.loadById(recipeId)` |
| `AddCalendarEntryDialog` | CalendarPage | clic sur une `MealSlot` (`addRequested`) → `_openAddDialog(day, slot)` → `openFor(day, slot, Window.window)` | `onRecipePicked` → `calendarVM.addRecipe(...)` ; `onIngredientPicked` → `calendarVM.addIngredient(...)` |
| `AddPantryStockDialog` | PantryPage | bouton d'ajout → `openCentered(Window.window)` | `onSubmitted(payload)` → `pantryVM.addStock(payload)` puis `shoppingVM.refreshList()` si sauvegarde OK |
| `IngredientSearchPopup` | sous-dialogue de `ImportRecipeUrlDialog` | menu « Actions ▾ » d'une ligne → `openFor(root, idx, rawText, parsedName, source)` | agit directement sur `recipeUrlImportVM` |

### 1.3 ViewModels référencés depuis les dialogues (context properties globales)

`ingredientVM`, `recipeListVM`, `recipeEditorVM`, `calendarVM`, `pantryVM`, `shoppingVM`,
`categoryVM`, `receiptImportVM`, `recipeUrlImportVM`, `lidlPlusVM`, `backupVM`, `networkVM`,
plus la variable de contexte `logDirPath` (string).

---

## 2. Jetons de design (`Theme.qml`) → variables CSS

`Theme.qml` est un **singleton QML** (`pragma Singleton`, enregistré côté Python via
`qmlRegisterSingletonType(url, "App", 1, 0, "Theme")`). Une seule propriété mutable :
`property bool darkMode: false`. **Toutes** les autres sont `readonly` et dérivées de `darkMode`
par un ternaire.

### 2.1 Palette — valeurs hexadécimales exactes

| Jeton QML | Variable CSS proposée | Clair (`darkMode: false`) | Sombre (`darkMode: true`) |
|---|---|---|---|
| `colorPrimary` | `--color-primary` | `#2563eb` | `#3b82f6` |
| `colorPrimaryHover` | `--color-primary-hover` | `#1d4ed8` | `#60a5fa` |
| `colorPrimaryPressed` | `--color-primary-pressed` | `#1e40af` | `#2563eb` |
| `colorPrimaryDisabled` | `--color-primary-disabled` | `#cbd5e1` | `#475569` |
| `colorOnPrimary` | `--color-on-primary` | `#ffffff` | `#ffffff` |
| `colorSecondary` | `--color-secondary` | `#7c3aed` | `#a78bfa` |
| `colorSecondaryHover` | `--color-secondary-hover` | `#6d28d9` | `#c4b5fd` |
| `colorSecondaryPressed` | `--color-secondary-pressed` | `#5b21b6` | `#8b5cf6` |
| `colorBackground` | `--color-background` | `#f8fafc` | `#0f172a` |
| `colorSurface` | `--color-surface` | `#ffffff` | `#1e293b` |
| `colorSurfaceHover` | `--color-surface-hover` | `#f1f5f9` | `#334155` |
| `colorSurfacePressed` | `--color-surface-pressed` | `#e2e8f0` | `#475569` |
| `colorText` | `--color-text` | `#0f172a` | `#f1f5f9` |
| `colorTextSecondary` | `--color-text-secondary` | `#475569` | `#94a3b8` |
| `colorTextDisabled` | `--color-text-disabled` | `#cbd5e1` | `#94a3b8` |
| `colorTextPlaceholder` | `--color-text-placeholder` | `#94a3b8` | `#64748b` |
| `colorBorder` | `--color-border` | `#e2e8f0` | `#334155` |
| `colorBorderHover` | `--color-border-hover` | `#cbd5e1` | `#475569` |
| `colorBorderFocus` | `--color-border-focus` | `#3b82f6` | `#60a5fa` |
| `colorAccent` | `--color-accent` | `#0891b2` | `#22d3ee` |
| `colorError` | `--color-error` | `#dc2626` | `#f87171` |
| `colorErrorHover` | `--color-error-hover` | `#b91c1c` | `#fca5a5` |
| `colorSuccess` | `--color-success` | `#16a34a` | `#4ade80` |
| `colorWarning` | `--color-warning` | `#ea580c` | `#fbbf24` |
| `colorOverlay` | `--color-overlay` | `rgba(0, 0, 0, 0.45)` | `rgba(0, 0, 0, 0.45)` |
| `colorTransparent` | — | `transparent` | `transparent` |

> Remarque : `colorTextDisabled` en mode sombre (`#94a3b8`) est **identique** à
> `colorTextSecondary` sombre. C'est délibéré (commentaire dans le code : « assez clair pour rester
> lisible sur fond sombre »).

### 2.2 Ombres

Pas de `box-shadow` natif en QML 6 sans `MultiEffect` : le code empile des `Rectangle` translucides
concentriques. À porter directement en `box-shadow` CSS.

| Jeton | Clair | Sombre |
|---|---|---|
| `shadowColor` | `#0f172a` | `#000000` |
| `shadowOpacitySubtle` | `0.06` | `0.35` |
| `shadowOpacityNormal` | `0.12` | `0.50` |
| `shadowOpacityElevated` | `0.18` | `0.65` |

Recettes d'empilement observées (à traduire en `box-shadow` multi-couches) :

- **AppPopup** (ombre « normale ») : couche à `margins:-6`, `radius+6`, alpha = `normal × 0.5` ;
  couche à `margins:-2`, `radius+2`, alpha = `normal × 0.85`.
- **AppMenu** : identique à AppPopup.
- **AppComboBox popup** (ombre « subtile ») : `margins:-8`, `radius+8`, alpha = `subtle × 0.5` ;
  `margins:-4`, `radius+4`, alpha = `subtle × 1.0`.
- **AppDialog** (ombre « élevée », 3 couches) : `margins:-16 / radius+16 / elevated × 0.35`,
  `margins:-8 / radius+8 / elevated × 0.55`, `margins:-3 / radius+3 / elevated × 0.75`.

### 2.3 Typographie

```
fontFamily = "Segoe UI"                             sur Windows
           = "SF Pro Text"                          sur macOS
           = "Inter, Helvetica, Arial, sans-serif"  ailleurs
```

| Jeton | Valeur (px) | Variable CSS |
|---|---|---|
| `fontSizeXs` | 10 | `--font-size-xs` |
| `fontSizeSm` | 11 | `--font-size-sm` |
| `fontSizeMd` | 13 (base / corps de texte) | `--font-size-md` |
| `fontSizeLg` | 15 | `--font-size-lg` |
| `fontSizeXl` | 18 | `--font-size-xl` |
| `fontSizeTitle` | 22 | `--font-size-title` |

| Jeton | Constante Qt | Équivalent CSS |
|---|---|---|
| `fontWeightRegular` | `Font.Normal` | `400` |
| `fontWeightMedium` | `Font.Medium` | `500` |
| `fontWeightSemiBold` | `Font.DemiBold` | `600` |
| `fontWeightBold` | `Font.Bold` | `700` |

`font.letterSpacing: 0.4` (en-têtes de tableau du ticket) et `0.5` / `0.8` (titres de section
majuscules) sont utilisés localement → `letter-spacing: 0.4px / 0.5px / 0.8px`.

### 2.4 Espacements, rayons, durées, hauteurs

| Espacement | px | | Rayon | px | | Durée | ms |
|---|---|---|---|---|---|---|---|
| `spaceXs` | 4 | | `radiusSm` | 4 | | `durationFast` | 150 |
| `spaceSm` | 8 | | `radiusMd` | 6 | | `durationNormal` | 250 |
| `spaceMd` | 12 | | `radiusLg` | 10 | | `durationSlow` | 400 |
| `spaceLg` | 16 | | `radiusXl` | 14 | | | |
| `spaceXl` | 24 | | `radiusFull` | 9999 | | | |
| `spaceXxl` | 32 | | | | | | |

Courbes d'accélération (Qt → équivalent CSS approché) :

| Jeton | Qt | CSS |
|---|---|---|
| `easingStandard` | `Easing.OutCubic` | `cubic-bezier(0.215, 0.61, 0.355, 1)` |
| `easingEnter` | `Easing.OutQuad` | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` |
| `easingExit` | `Easing.InQuad` | `cubic-bezier(0.55, 0.085, 0.68, 0.53)` |

Hauteurs de contrôles standard : `controlHeightSm` = **28 px**, `controlHeightMd` = **36 px**
(boutons, champs texte, combobox, spinbox), `controlHeightLg` = **44 px**.

### 2.5 Helper `formatMnemonic(text)`

Convertit les marqueurs de raccourci Qt en HTML : `&X` → `<u>X</u>`, `&&` → `&`. Implémentation :
`String(text).replace(/&(.)/g, (m, c) => c === '&' ? '&' : '<u>' + c + '</u>')`. Utilisé par
`AppMenu` et le délégué `MenuBarItem` de `Main.qml`, avec `textFormat: Text.RichText`.
**En web : inutile** — remplacer par `<u>` explicite ou l'attribut `accesskey`.

### 2.6 Couleurs codées en dur HORS `Theme.qml` (à intégrer au design system web)

Ces valeurs ne suivent PAS le mode sombre — elles sont fixes dans les deux thèmes.

**Badges de source d'ingrédient** (`IngredientSearch`, `IngredientSearchPopup`,
`DraggableIngredientChip`) :

| Source | Libellé badge | Couleur texte | Fond |
|---|---|---|---|
| `ciqual` | « CIQUAL » | `#15803d` | même couleur à 12 % d'alpha (14 % dans `IngredientSearchPopup`) |
| `openfoodfacts` | « OFF » | `#1d4ed8` | idem |
| `manual` (défaut) | « perso » | `#c2410c` | idem |

Dans `DraggableIngredientChip`, ces mêmes couleurs servent de pastille pleine de 6×6 px (rayon 3).
Dans `ReceiptImportDialog`, l'étiquette « OFF » de la liste de résultats en ligne est `#3b82f6`.

**Palette nutriment de `MacrosChart`** (commentaire du code : « palette nutriment officielle
(méta produit) ») :

| Nutriment | Hex | Utilisé dans le donut |
|---|---|---|
| Énergie | `#F1B40E` | non (déclaré seulement) |
| Lipides | `#FDA406` | oui |
| dont saturés | `#DA4A35` | non |
| Glucides | `#509938` | oui |
| dont sucres | `#07A0AA` | non |
| Fibres | `#7CC04C` | oui — **volontairement décliné** de la valeur officielle `#4F8C40`, trop proche de Glucides |
| Protéines | `#0B6BBB` | oui |
| Sel | `#7145A7` | non |

**`UndoToast`** : fond `#1f2937` en mode clair (« dark slate »), `Theme.colorSurface` en mode
sombre ; bordure `rgba(255,255,255,0.10)` ; texte blanc ; opacité 0.96.

**Polices monospace codées en dur** : `"Consolas, Courier New, monospace"`
(`LidlPlusSetupDialog`, bloc de commande copiable) et `"Consolas, Monaco, monospace"`
(`ShortcutsDialog`, keycaps).

### 2.7 Icônes bitmap

`NutrientLabel` et `NutritionPanel` chargent `components/icons/nutrient/<type>.png` avec
`sourceSize = iconSize × 2` (rendu HiDPI). Les 8 `type` possibles :
`energy`, `fats`, `saturatedFats`, `carbs`, `sugars`, `fiber`, `proteins`, `salt`.
→ **En web** : servir en SVG ou en PNG @2x, chemin `/icons/nutrient/<type>.svg`.

---

## 3. Dialogues — spécification détaillée

**Convention structurelle desktop.** La quasi-totalité des dialogues sont de vraies
`QtQuick.Window` système (détachables, déplaçables hors de la fenêtre principale, redimensionnables,
**non-modales** sauf mention contraire) avec :

```qml
flags: Qt.Dialog | Qt.WindowCloseButtonHint | Qt.WindowTitleHint | Qt.WindowMinMaxButtonsHint
modality: Qt.NonModal
color: Theme.colorBackground
```

et une fonction de positionnement `openCentered(parentWindow)` / `openFor(..., parentWindow)` :

```qml
x = parentWindow.x + (parentWindow.width  - width)  / 2
y = parentWindow.y + (parentWindow.height - height) / 2
show(); raise()
```

**Équivalent web** : modale `<dialog>` centrée, ou fenêtre flottante déplaçable si l'on veut
préserver le multi-fenêtrage (peu utile en mobile-first). Les dimensions ci-dessous deviennent des
`max-width` / `max-height` avec repli plein écran sous 768 px.

---

### 3.1 `ImportIngredientDialog` — « Importer un ingrédient »

**Fichier** : `dialogs/ImportIngredientDialog.qml` (905 lignes).
**Déclencheur** : bouton « Importer un ingrédient » de la page Ingrédients.
**Fenêtre** : 920×640, min 720×480. Titre système et titre interne : « Importer un ingrédient ».
**Signal sortant** : `libraryChanged()` → la page rafraîchit la bibliothèque.

#### But

Parcourir les catalogues bruts (CIQUAL local ~3 000 entrées, OpenFoodFacts en ligne) et **promouvoir**
des lignes dans la bibliothèque personnelle (`in_personal_library = true`).

#### Structure

- Titre « Importer un ingrédient » (`fontSizeXl`, semi-bold).
- `TabBar` avec deux `AppTabButton` : **« CIQUAL (local) »** (largeur 180) et
  **« OpenFoodFacts (en ligne) »** (largeur 220). Ligne de séparation 1 px `colorBorder` en bas.
- `StackLayout` piloté par `tabBar.currentIndex` :
  - index 0 : composant interne `CatalogTabRich` (`source: "ciqual"`,
    placeholder « Rechercher dans CIQUAL (~3 000 entrées)… »)
  - index 1 : composant interne `CatalogTabSimple` (`source: "openfoodfacts"`,
    placeholder « Rechercher dans OpenFoodFacts (en ligne)… »)
- Ligne de confirmation, visible si `_lastImportName !== ""` :
  « ✓ Ajouté à ta bibliothèque : <nom> » en `colorSuccess`, `fontSizeSm`, medium.
- Pied : bouton **« Fermer »** (`secondary`), aligné à droite.

L'état (requête, filtres, tri, page) est conservé **par instance d'onglet** pendant toute la durée de
vie du dialogue ; changer d'onglet ne le réinitialise pas. Il n'est **pas** persisté entre deux
ouvertures (commentaire explicite : « pour persister cross-session il faudrait Settings /
LocalStorage »).

#### Onglet CIQUAL — `CatalogTabRich` (RowLayout : panneau filtres 250 px | résultats)

**Panneau de filtres** (`Rectangle`, largeur préférée 250 px, min 220, surface + bordure, rayon `md`) :

| Libellé | Type | Détails |
|---|---|---|
| « Filtres » | titre | `fontSizeMd` semi-bold |
| « Catégorie » | `AppComboBox` | modèle = `["(toutes catégories)"] + ingredientVM.categoriesL1(source)`. Index 0 = pas de filtre. `onActivated` → `_categoryL1`, `_page = 1`, relance la recherche |
| « Énergie (kcal/100g) » | `MacroRangeField` (2× `FixedUnitField`, unité « kcal/100g », max 2000) | min et max ; séparateur « — » |
| « Protéines (g/100g) » | `MacroRangeField` (unité « g/100g », max 1000 par défaut) | idem |
| « Glucides (g/100g) » | `MacroRangeField` | idem |
| « Lipides (g/100g) » | `MacroRangeField` | idem |
| « Trier par » | `AppComboBox` (`textRole: "label"`, `valueRole: "code"`) | « Pertinence » → `rank` ; « Nom » → `name` ; « Énergie » → `kcal` ; « Protéines » → `proteins` ; « Glucides » → `carbs` ; « Lipides » → `fats` |
| « Décroissant » | `AppCheckBox` | → `_sortDesc` |
| « Réinitialiser » | `AppButton` ghost, pleine largeur | remet tous les champs + relance |

Chaque modification de filtre **remet `_page` à 1** et relance immédiatement la recherche (pas de
bouton « Appliquer »).

**Panneau résultats** :

- `AppTextField` pleine largeur, placeholder de l'onglet. **Anti-rebond de 250 ms**
  (`Timer.restart()` sur `onTextChanged`). `onAccepted` (Entrée) déclenche la recherche
  immédiatement, sans attendre le timer.
- Liste (`ListView`, `AppScrollBar` verticale), délégué `AppListItem` de **56 px** :
  - `AppCheckBox` de sélection (largeur 28), **masquée** si la ligne est déjà en bibliothèque ;
    remplacée par un `Item` de 28 px pour conserver l'alignement.
  - « 🌟 » si `inLibrary`.
  - Colonne : nom (medium, `fontSizeMd`, élidé) + sous-ligne `fontSizeXs` `colorTextSecondary`
    construite ainsi (chaque segment omis si la valeur vaut −1, sentinelle de « inconnu ») :
    `"<kcal arrondi> kcal"` + `"  ·  P <proteins.toFixed(1)> g"` + `"  ·  G <carbs> g"` +
    `"  ·  L <fats> g"` + `"  ·  <categoryL1>"`.
  - `AppButton` : « + Ajouter » (`secondary`) ou « Déjà ajouté » (`ghost`, désactivé).
  - **Double-clic** sur la ligne = même effet que « + Ajouter ».
- État vide centré : « Tape une requête ou applique un filtre. » si aucune requête ni catégorie,
  sinon « Aucun résultat avec ces critères. ».
- **Bandeau multi-sélection** (visible dès 1 coche, hauteur 44 px animée sur `durationFast`, fond
  `primary` à 10 %, bordure `primary`) :
  - « ✓ N sélectionné(s) » (accord automatique) ;
  - « Sélectionner la page » (ghost) — ajoute toutes les lignes visibles **non déjà importées** ;
  - « Tout désélectionner » (ghost) ;
  - « + Importer (N) » (primary).
  La sélection **persiste à travers les changements de page et de requête** (stockée dans un objet
  JS `_selectedIds` indexé par id).
- **Pied de pagination** : « ‹ Précédent » (ghost, désactivé si `_page <= 1`) — texte centré
  « Page P / N  ·  T résultat(s) » ou « Aucun résultat » — « Suivant › » (ghost, désactivé si
  `_page >= _pageCount`).

**Appel VM de recherche** — `ingredientVM.searchCatalogPaged(opts)` où `opts` est exactement :

```js
{ source, query, categoryL1, minKcal, maxKcal, minProteins, maxProteins,
  minCarbs, maxCarbs, minFats, maxFats, sortBy, sortDesc, page, pageSize: 25 }
```

Retour attendu : `{ matches: [...], totalCount: int, pageCount: int }`. Chaque `match` expose
`id, name, kcal, proteins, carbs, fats, categoryL1, inLibrary`.

> **Assainissement obligatoire** (commentaire du code) : un champ Python `None` devient `null` en JS,
> mais un champ **absent** devient `undefined`, qui passe le test `!== null`. Le code force donc :
> `typeof m.kcal === "number" ? m.kcal : -1` (sentinelle **−1** = valeur inconnue), et
> `m.inLibrary === true`. À reproduire côté web si l'API peut omettre des champs.

`Component.onCompleted` est **gardé** : si `ingredientVM` n'est pas encore résolu, ni les catégories
ni la première recherche ne sont chargées (commentaire : « il sera trigger au premier focus de
l'onglet » — voir §7, ambiguïté #1).

#### Onglet OpenFoodFacts — `CatalogTabSimple`

- `AppTextField` (largeur max 480), **pas d'anti-rebond** : `onAccepted` (Entrée) lance la recherche.
- Bouton **« Chercher en ligne »** (primary), activé si
  `queryField.text.trim().length >= 2 && (networkVM absent || networkVM.online)`.
- Message « ⚠ OFF indisponible — réessaye plus tard » (`colorWarning`) si `networkVM.online` est faux.
- Liste : délégué de **50 px**, checkbox + « 🌟 » + nom seul (pas de macros) + bouton
  « + Ajouter » / « Déjà ajouté ». Double-clic = ajouter.
- États vides : « Tape au moins 2 caractères et clique « Chercher ». » si la requête est vide,
  sinon « Aucun résultat. ». Pendant la recherche : « Recherche en cours… ».
- Même bandeau multi-sélection que l'onglet CIQUAL.

**Appel VM** : `ingredientVM.fetchOnlineAndList(q, 30)` — appel **bloquant** enveloppé dans
`Qt.callLater()` pour laisser le label « Recherche en cours… » se peindre avant le gel de l'UI.
Retour : liste de `{ id, name, inLibrary }`.

#### Actions de promotion

```js
_promote(id):
    saved = ingredientVM.importExisting(id)
    si saved && saved.name :
        _lastImportName = saved.name
        marque la ligne "inLibrary" dans LES DEUX onglets
        émet libraryChanged()

_promoteMany(ids, tab):
    si ids vide → return
    count = ingredientVM.importMany(ids)      // transaction unique côté Python
    si count > 0 :
        marque chaque id dans les deux onglets
        _lastImportName = count + " ingrédients"
        émet libraryChanged()
    tab._clearSelection()                     // TOUJOURS, même si count == 0
```

#### Sous-composant `MacroRangeField`

`ColumnLayout` : label (`fontSizeXs`, `colorTextSecondary`) puis `RowLayout`
`[FixedUnitField min] "—" [FixedUnitField max]`. Propriétés : `rangeLabel`, `unit` (défaut
`"g/100g"`), `maxV` (défaut 1000), `minValue`, `maxValue`, et `reset()` qui appelle `clear()` sur les
deux champs. Les valeurs remontent via `onValueEdited` (pas `onValueChanged`) → seule une saisie
utilisateur déclenche une recherche.

---

### 3.2 `ReceiptImportDialog` — « Importer un ticket de caisse »

**Fichier** : `dialogs/ReceiptImportDialog.qml` (1246 lignes — le plus gros).
**Fenêtre** : 1300×760, min 1100×560.
**VM** : `receiptImportVM` (+ `ingredientVM` pour les libellés et le lookup EAN).

#### Deux points d'entrée

```js
openCentered(parentWindow):        // flux "je choisis un fichier"
    centre la fenêtre
    receiptImportVM.reset()
    linesSnapshot = []
    show(); raise()
    Qt.callLater(() => filePicker.open())   // ouvre AUTOMATIQUEMENT le sélecteur de fichier

openForPending(parentWindow):      // flux "un ticket est déjà chargé dans le VM"
    centre la fenêtre
    si receiptImportVM.hasReceipt : linesSnapshot = receiptImportVM.linesAsList()
    show(); raise()                // PAS de reset, PAS de file picker
```

`FileDialog` natif : titre « Choisir un ticket à importer (PDF) », filtres
`["Tickets PDF (*.pdf)", "Tous (*)"]`, mode `OpenFile`. `onAccepted` →
`receiptImportVM.loadFromPath(selectedFile.toString())`, puis snapshot des lignes si succès.

#### Connexions VM

| Signal | Effet |
|---|---|
| `receipt_loaded()` | `linesSnapshot = receiptImportVM.linesAsList()` |
| `line_changed(idx)` | re-snapshot **complet** de toutes les lignes (le code ne fait pas de mise à jour granulaire) |
| `error_emitted(msg)` | toast rouge (5 s) |
| `import_completed(success, msg)` | si succès : toast vert (3 s) puis `Qt.callLater(() => root.close())` ; sinon toast rouge |

#### Propriétés lues sur le VM

`hasReceipt` (bool), `store` (string), `receiptDateHuman` (string), `lineCount` (int),
`totalEur` (string/number), `ticketId` (string), `isDuplicate` (bool), `forceImport` (bool),
`pendingFileCount` (int, utilisé par la status bar de Main).

#### En-tête

- Titre : `"Ticket " + store + " · " + receiptDateHuman` si un ticket est chargé, sinon
  « Importer un ticket de caisse ».
- Sous-titre (si ticket chargé) : `N + " ligne(s)"` + `"  ·  Total : X €"` (si `totalEur`) +
  `"  ·  ID " + ticketId.slice(0, 12) + "…"` (si `ticketId`).
- Bouton **« 📥 Choisir un fichier… »** (primary) si aucun ticket ; sinon
  **« Changer de ticket »** (ghost).

#### Bandeau anti-doublon (visible si `isDuplicate`)

Fond `colorWarning` à 15 %, bordure `colorWarning`, hauteur `max(36, contenu + spaceLg)`.
Texte : « ⚠️ Ce ticket a déjà été importé. Active 'Forcer' pour ré-importer (crée des doublons
d'historique de prix). » + `AppCheckBox` **« Forcer »** lié à `forceImport`
(`onClicked: receiptImportVM.setForceImport(checked)`).

#### Barre d'outils

- `AppCheckBox` **« Masquer les non-alimentaires (TVA B) »**, **cochée par défaut**
  (`hideNonFood: true`). Filtre côté vue uniquement (`visible: !hideNonFood || isLikelyFood`).
- Compteur aligné à droite, recalculé sur le snapshot en appliquant le même filtre :
  `"<matched> / <total> ligne(s) mappée(s)"` — une ligne est « mappée » si `chosenId > 0`.
  *(L'accord du pluriel de « mappée » suit `matched`, celui de « ligne » suit `total` — cf. §7.)*

#### Tableau des lignes

Largeurs de colonnes partagées entre l'en-tête et le délégué (constantes de la racine) :

| Constante | px | En-tête (majuscules) | Alignement |
|---|---|---|---|
| `colArticleW` | 220 | « ARTICLE (TICKET) » | gauche |
| `colQtyW` | 250 | « QTÉ + UNITÉ » | centré |
| `colPriceW` | 100 | « PRIX (€) » | droite |
| `colExpiryW` | 140 | « DLC (optionnelle) » | centré |
| `colBarcodeW` | 150 | « CODE-BARRES (EAN) » | gauche |
| *(reste)* | calculé | « INGRÉDIENT (CLIQUE POUR CHOISIR / CRÉER) » | gauche |
| `colFrigoW` | 54 | « ACTION » | centré |
| `colSpacing` | 8 | — | — |

Largeur de la colonne Ingrédient =
`width − 2×spaceMd − colArticleW − colQtyW − colPriceW − colExpiryW − colBarcodeW − colFrigoW − colSpacing×6`.

En-tête : hauteur 32 px, fond `colorBackground`, rayon `sm`, texte `fontSizeXs` medium,
`letterSpacing 0.4`.
Lignes : hauteur **76 px** (0 si masquée), zébrage `index % 2 === 0 ? transparent : surface à 50 %`,
séparateur 1 px `colorBorder` à 30 % d'opacité en bas.

**Cellule 1 — Article** : `rawName` (`fontSizeSm`, medium, élidé) + sous-ligne
`"TVA " + vatCode` + `"  ·  non-alim."` si `!isLikelyFood` ; couleur `colorWarning` si
non-alimentaire, sinon `colorTextSecondary`.

**Cellule 2 — Quantité** : `QuantityField` (`decimals: 0`), `grams = modelData.quantityG || 0`,
`pieceWeightG = rowItem.currentPieceWeightG`. `currentPieceWeightG` est **calculé par ligne** :
si `chosenId > 0`, appelle `ingredientVM.getAsDict(chosenId)` et lit `pieceWeightG` (0 sinon).
`onGramsEdited(g)` → `receiptImportVM.setLineQuantityG(modelData.index, g)`.

> Commentaire du code : si la quantité est > 0 elle alimente `PantryStock.quantity_g` **et**
> `PriceHistory.quantity_g` au commit, avec **priorité dans la cascade**.

**Cellule 3 — Prix total (éditable)** : `AppTextField` aligné à droite,
`inputMethodHints: Qt.ImhFormattedNumbersOnly`, placeholder « 0,00 ».
Affichage : `Number(parseFloat(totalPrice)).toLocaleString(Qt.locale(), 'f', 2)` (donc **virgule**
décimale en français), vide si `totalPrice` falsy.
`onEditingFinished` : compare au texte formaté précédent et n'appelle
`receiptImportVM.setLineTotalPrice(index, text)` **que si différent**.

> Commentaire du code : l'édition pose un flag `user_price_override` sur la ligne pour qu'un
> changement ultérieur de quantité ne réécrase pas le prix.

**Cellule 4 — DLC** : `AppTextField` (placeholder « JJ/MM/AAAA », valeur `expiryHuman`) +
bouton « 📅 » (ghost, 32×32, infobulle « Ouvrir le calendrier »).

Validation à la sortie du champ :
- texte vide → `setLineExpiry(index, "")` ;
- sinon regex `^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$` → tolère `JJ/MM/AAAA`, `JJ-MM-AAAA`,
  `JJ.MM.AAAA`, jour et mois sur 1 ou 2 chiffres. Reconstruit `AAAA-MM-JJ` avec `padStart(2,"0")`.
- **Si la regex échoue : rien n'est envoyé au VM et aucun message d'erreur n'est affiché** (§7).

Le bouton 📅 partage un **unique** `DatePickerPopup` de niveau racine
(`expiryPicker.targetLineIndex = modelData.index` puis `openAt(this, expiryIso || "")`) ; le handler
`onDateSelected(iso)` appelle `receiptImportVM.setLineExpiry(targetLineIndex, iso)`.

**Cellule 5 — Code-barres** : `AppTextField` (32 px de haut, `Qt.ImhDigitsOnly`, placeholder
« EAN… », valeur `userBarcode`). `onEditingFinished` → `setLineBarcode(index, text)` si changé.
Bouton « 🔍 » (ghost, 36×32, infobulle « Lookup OFF + assigner »), **activé si ≥ 8 caractères** :
force d'abord `setLineBarcode(index, eanField.text)` puis appelle
`receiptImportVM.lookupBarcodeAndAssign(index)`.

**Cellule 6 — Ingrédient (toute la cellule est cliquable)** : `Rectangle` 40 px de haut, rayon `sm`.
Fond : `surfaceHover` au survol, sinon `primary` à 12 % si `chosenId > 0`, sinon `surface`.
Bordure : `primary` si choisi, sinon `borderHover` au survol, sinon `border`.

Texte :
- si `chosenId > 0` : `"✓  " + ingredientVM.getAsDict(chosenId).name`, ou
  `"(id <chosenId>)"` en repli ;
- sinon si `matchSource === "none"` : « Cliquer pour choisir / créer… » (italique) ;
- sinon : `"Cliquer  ·  N suggestion(s)"`.

Puce de score (visible **seulement si `chosenId === 0`**), rayon 9 :

| `matchSource` | Libellé | Couleur |
|---|---|---|
| `"alias"` | « appris » | `colorSuccess` (fond à 18 %) |
| `"source_ref"` | « ID » | `colorSuccess` (fond à 18 %) |
| `"fuzzy"` avec `matchScore >= 0.9` | `Math.round(score×100) + "%"` | `colorSuccess` (fond à 18 %) |
| `"fuzzy"` avec `matchScore < 0.9` | `Math.round(score×100) + "%"` | `colorWarning` (fond à 18 %) |
| autre | « à créer » | `colorError` (fond à 14 %) |

Chevron : « ✎ » si choisi, « ▾ » sinon. Le clic ouvre `linePicker.openFor(index, rawName, suggestionIds)`.

**Cellule 7 — Action** : `AppButton` « 🗑 » (variante `danger`, 36×32, infobulle « Retirer cette
ligne de l'import », délai 400 ms) → `receiptImportVM.removeLine(index)`.

> Commentaire du code : « tout va automatiquement au frigo, donc le toggle "Frigo" n'a plus
> d'utilité ». La colonne conserve son nom de constante `colFrigoW`.

État vide : « Aucune ligne d'article détectée. » (`colorTextDisabled`, 80 px de haut).

#### Pied

« Annuler » (secondary) → `receiptImportVM.reset()` puis fermeture.
« 💾 Tout enregistrer » (primary) → `receiptImportVM.commitImport()`.

#### Sous-dialogue « Choisir l'ingrédient » (`linePicker`)

`Window` **modale par rapport à la fenêtre** (`modality: Qt.WindowModal`), `transientParent: root`
(« essentiel sous Windows : sans lui le Window peut s'afficher derrière la fenêtre principale »).
Dimensions : 640 × (640 en mode création, 560 en mode choix), min 540×480.
Titre : « Choisir l'ingrédient ». En-tête : `"Pour : « " + rawName + " »"`.

**Mode 1 — CHOISIR** (`createMode === false`) :

1. Section « Suggestions : » (visible si `suggestions.length > 0`) — un `AppButton` secondary
   pleine largeur par suggestion, libellé `"→  " + ingredientVM.getAsDict(id).name` (repli
   `"(id N)"`). Clic → `receiptImportVM.setLineChosenIngredient(lineIndex, id)` + fermeture.
2. Bascule de portée : label « Chercher dans : » + deux boutons de 28 px de haut —
   « ✓ Ma bibliothèque » / « Ma bibliothèque » et
   « ✓ Tout (CIQUAL + OFF en cache) » / « Tout (CIQUAL + OFF) ». Le bouton actif est `primary`,
   l'autre `ghost`. Ils pilotent `picker.scope` (`"personal"` / `"all"`).
3. `IngredientSearch` (voir §4.3), placeholder dépendant de la portée :
   « Chercher dans ta bibliothèque… » ou « Chercher dans CIQUAL + OFF (cache local)… ».
   Au choix : **`ingredientVM.importExisting(id)` est appelé systématiquement**
   (« l'acte de choisir = signifie qu'on le veut dans la lib ») puis
   `setLineChosenIngredient(lineIndex, id)` et fermeture.
4. Séparateur, puis bloc « Pas trouvé ? Cherche en ligne sur OpenFoodFacts : » :
   - `AppTextField` **pré-rempli avec `rawName`**, placeholder
     « Mot-clé (auto-rempli depuis le ticket) » ;
   - bouton « 🌐 Chercher OFF » / « ⏳ Recherche… » (secondary), activé si ≥ 2 caractères et pas
     déjà en cours. Appelle `ingredientVM.fetchOnlineAndList(query, 10)` dans un `Qt.callLater`.
     Ne conserve que `id` et `name` (repli `"(sans nom)"`) « pour éviter les warnings QML ».
   - Message : « Aucun résultat OFF pour « <query> » » ou « N résultat(s) — clique pour utiliser ».
   - Liste de 30 px par ligne, hauteur max `min(120, count × 32)`, étiquette « OFF » en `#3b82f6`.
     Clic → `importExisting(id)` + `setLineChosenIngredient` + fermeture.
5. Séparateur puis bouton ghost pleine largeur
   **« + Créer un nouvel ingrédient depuis cette ligne »** → `enterCreateMode()`.

**Mode 2 — CRÉER** (`createMode === true`). `enterCreateMode()` appelle
`receiptImportVM.suggestCreatePayload(lineIndex)` (« qui connaît la TVA, le store, et donc la
catégorie probable ») et pré-remplit :

```
fieldName        = seed.name        || rawName
fieldEan         = seed.sourceRef   || ""
fieldCategoryL1  = seed.categoryL1  || ""
fieldCategoryL2  = seed.categoryL2  || ""
fieldPieceWeight = 0
fieldPriceQty    = 0
lookupHint       = ""
```

| Libellé exact | Type | Contraintes |
|---|---|---|
| « Créer cet ingrédient dans ta bibliothèque : » | titre | — |
| « Nom » | `AppTextField` | placeholder « Ex : Yaourt nature, Concombre… ». **Requis** : le bouton de validation exige `trim().length > 1` |
| « Code-barres / EAN  (optionnel) » | `AppTextField` + bouton | placeholder « 13 chiffres si scanné depuis le produit », `Qt.ImhDigitsOnly` |
| « 🔍 OFF » | `AppButton` secondary | activé si `fieldEan.length >= 8`. Appelle `ingredientVM.lookupBarcodeAsDict(ean)`. Si trouvé : écrase `fieldName`, et `fieldCategoryL1` / `fieldCategoryL2` **si non vides dans la réponse** ; message « ✓ Trouvé sur OpenFoodFacts : <nom> » (vert). Sinon « Aucun produit OFF pour cet EAN. » (orange) |
| « Catégorie L1 » | `AppTextField` | placeholder « (auto si TVA A) » |
| « Catégorie L2 » | `AppTextField` | placeholder « Optionnel » |
| « Poids 1 pièce (g)  · optionnel » | `AppSpinBox` | `0 … 5000`, pas 5, 0 décimale, `emptyOnZero` |
| « Quantité du prix (g)  · optionnel » | `AppSpinBox` | `0 … 50000`, pas 50, 0 décimale, `emptyOnZero` |

Note d'aide en bas : « Astuce : si tu connais le poids exact (ex : 250 g pour un yaourt) et le prix
correspond à ce poids, renseigne « Quantité du prix » → le suivi €/100 g sera précis. Sinon, tu
pourras affiner plus tard. »

**Pied commun** : « ← Retour » (ghost, visible en mode création) · espace · « Annuler » (ghost) ·
« ✓ Créer et utiliser » (primary, visible en mode création, activé si nom > 1 caractère).
Validation :

```js
id = receiptImportVM.createIngredientFromLine({
    index, name, sourceRef, categoryL1, categoryL2, pieceWeightG, priceQuantityG })
si id > 0 : ingredientVM.refreshList() ; linePicker.close()
```

#### Toasts

Deux `Rectangle` ancrés en bas au centre, marge `spaceXl`, opacité 0.95, rayon `md` :
erreur (`colorError`, texte `fontSizeSm`, largeur max `root.width − 80`, auto-masquage **5 s**) et
succès (`colorSuccess`, texte `fontSizeMd` medium, auto-masquage **3 s**).

---

### 3.3 `ImportRecipeUrlDialog` — « Importer une recette par URL »

**Fichier** : `dialogs/ImportRecipeUrlDialog.qml` (605 lignes).
**Fenêtre** : 1000×720, min 760×520. **VM** : `recipeUrlImportVM`.
**Signal sortant** : `importCompleted(int recipeId)`.

Assistant en **3 étapes** pilotées par `recipeUrlImportVM.stepIndex` (0 = URL, 1 = relecture,
2 = confirmation) dans un `StackLayout`.

`openCentered(parentWindow)` : centre, appelle `recipeUrlImportVM.reset()`, vide `urlField`,
vide la bannière d'erreur, coupe le spinner, `show(); raise()`.

#### Connexions VM

| Signal | Effet |
|---|---|
| `extraction_started()` | spinner ON, bannière d'erreur vidée |
| `extraction_completed(success)` | spinner OFF |
| `extraction_failed(message)` | spinner OFF, `errorBanner.text = message` |
| `import_completed(recipeId)` | émet `importCompleted(recipeId)` puis démarre `confirmCloseTimer` (**1800 ms**) qui fait `reset()` + `close()` |
| `error_emitted(message)` | `commitError.text = message` |
| `lines_changed(idx)` | `linesRepeater.model = recipeUrlImportVM.linesAsList()` |

#### Étape 0 — Saisie de l'URL

Carte centrée (largeur `min(parent.width − 48, 580)`, rayon `lg`, surface + bordure) :

- pictogramme « 🌐 » (56 px) ;
- titre « Importer une recette depuis le web » (`fontSizeXl`, semi-bold) ;
- description « Colle l'URL d'une page recette. L'app extrait nom, ingrédients, instructions et
  portions automatiquement. » ;
- `AppTextField` pleine largeur, placeholder
  « https://www.marmiton.org/recettes/recette_… », désactivé pendant l'extraction,
  **Entrée = `_doFetch()`** ;
- bouton **« Charger la recette »** (primary, largeur 220), masqué pendant l'extraction, activé si
  l'URL non vide après `trim()` ;
- pendant l'extraction : `AppSpinner` (taille 56, épaisseur 5) + « Chargement de la recette… » ;
- bannière d'erreur centrée en `colorError`.

Sous la carte, aide : « Sites supportés en natif : Marmiton, 750g, Hervé Cuisine, Cuisine AZ,
Cuisine Actuelle, HelloFresh, etc.\nLes autres sites passent par un fallback Schema.org (peut
échouer si la page n'expose pas de données structurées). »

`_doFetch()` : `url = urlField.text.trim()` ; si vide → rien ; sinon
`recipeUrlImportVM.extractFromUrl(url)`.

#### Étape 1 — Relecture

**En-tête éditable** : « Nom : » + `AppTextField` (fillWidth, min 280) ; « Portions : » +
`AppSpinBox` (0 décimale, **1 à 50**) ; texte « ≈ N min » (italique) si `prepTimeMin > 0`.
Ligne source : « Source : <sourceUrl> » (italique, `fontSizeXs`, élision au milieu), visible si
non vide. Toute modification appelle
`_pushMeta()` → `recipeUrlImportVM.updateMeta(metaName.text, "", metaPortions.realValue)`
(le 2e argument est toujours la chaîne vide — voir §7).

**Tableau des lignes** dans un `ScrollView`. En-tête de colonnes : « Texte original » (220 px),
« Ingrédient associé » (fillWidth), « Quantité » (220 px), colonne d'actions (130 px, sans titre).

Pour chaque ligne (`modelData` issu de `linesAsList()`, champs :
`idx, rawText, parsedName, candidates[], chosenIngredientId, chosenIngredientName, quantityG,
unitCode, pieceWeightG, isIgnored`) :

- Fond : `colorTextDisabled` à 10 % si ignorée, sinon zébrage
  `index % 2 === 0 ? transparent : colorBorder à 8 %`. Opacité **0.55** si ignorée.
- **Col 1** : `rawText` en italique `fontSizeXs` `colorTextSecondary` (élidé) au-dessus d'un
  `AppTextField` contenant `parsedName`. `onEditingFinished` →
  `setLineParsedName(idx, text)` uniquement si le texte a changé.
- **Col 2** : `AppComboBox` (hauteur 32) dont le modèle est construit à la volée depuis
  `candidates` : `{ label: c.name + "  ·  " + tag, id: c.id }` où
  `tag = "perso" | "CIQUAL" | "OFF" | c.source` selon
  `manual | ciqual | openfoodfacts | (autre)`. `currentIndex` = position du candidat dont l'`id`
  vaut `chosenIngredientId`, sinon **−1**. `displayText` forcé à `chosenIngredientName` si choisi,
  sinon **« (non associé) »**. `onActivated` → `setLineChosenIngredient(idx, model[currentIndex].id)`.
  Désactivé si la ligne est ignorée.
- **Col 3** : `QuantityField` (220 px) avec `grams = quantityG`, `preferredUnit = unitCode`,
  `pieceWeightG = pieceWeightG`. Utilise **`onGramsEdited`** (et non `gramsChanged`) →
  `setLineQuantityG(idx, g)`, et `onUnitChanged` → `setLineUnitCode(idx, code)`.
  > Commentaire du code : c'est pour « éviter une boucle quand le VM ré-émet `lines_changed` après
  > un `setLineQuantityG` ».
- **Col 4** : `AppButton` (120 px) — « Réactiver » (secondary) si ignorée →
  `unignoreLine(idx)` ; sinon « Actions ▾ » (ghost) → ouvre `lineMenu` sous le bouton.

**Pied** : « ‹ Précédent » (ghost) → `recipeUrlImportVM.goToStep0()` · espace ·
« Importer la recette » (primary) → vide `commitError` puis `const r = recipeUrlImportVM.commit()` ;
si `!r.success`, affiche `r.message` dans `commitError` (aligné à droite, rouge).

#### Menu contextuel de ligne (`lineMenu`, un `AppMenu`)

4 `Action` (et non `MenuItem`, « pour que le `delegate` de l'AppMenu s'applique ») :

| Libellé | Effet |
|---|---|
| « Rechercher dans CIQUAL/OFF… » | `searchPopup.openFor(root, idx, rawText, parsedName, "ciqual")` |
| « Rechercher dans la Bibliothèque personnelle… » | `searchPopup.openFor(root, idx, rawText, parsedName, "personal")` |
| « Créer manuellement… » | `createManualDialog.openFor(idx, parsedName)` |
| « Ignorer cette ligne » | `recipeUrlImportVM.ignoreLine(idx)` |

#### Sous-dialogue « Créer un ingrédient » (`createManualDialog`, `Dialog` interne modal, 460 px)

| Libellé | Type | Détail |
|---|---|---|
| « Nom : » | `AppTextField` | pré-rempli avec `parsedName` |
| « Rayon (facultatif) : » | `AppTextField` | placeholder « Ex. Épicerie » |
| « Énergie kcal/100 g (facultatif) : » | `AppSpinBox` (140 px) | 0 décimale, `0 … 2000` |

Pied : `DialogButtonBox` standard **Ok | Cancel** (donc libellés **natifs Qt**, non traduits par
l'app). `onAccepted` :

```js
id = recipeUrlImportVM.createManualForLine(lineIdx, {
        name: manualName.text.trim(),
        categoryL1: manualCategory.text.trim(),
        kcalPer100g: manualKcal.realValue > 0 ? manualKcal.realValue : null })
si id > 0 : close()   // sinon le dialogue reste ouvert, sans message
```

#### Étape 2 — Confirmation

« ✓ » en `colorSuccess` (64 px), titre `"Recette « <nom> » importée"` (`fontSizeXl` semi-bold),
texte « L'éditeur va s'ouvrir sur la nouvelle recette pour finitions (photo, tags, instructions
affinées). » (largeur max 500), bouton « Fermer » (primary) → `reset()` + `close()`.
Fermeture automatique après 1800 ms via `confirmCloseTimer`.

---

### 3.4 `PriceHistoryDialog` — « Historique des prix »

**Fichier** : `dialogs/PriceHistoryDialog.qml` (654 lignes).
**Fenêtre** : 880×640, min 720×520. Titre dynamique : `"Historique des prix · " + ingredientName`.
**Ouverture** : `openFor(ingId, ingName, defaultQty)`.

```js
openFor(ingId, ingName, defaultQty):
    ingredientId = ingId ; ingredientName = ingName || "" ; defaultQuantityG = defaultQty || 0
    title = "Historique des prix · " + ingredientName
    _refreshHistory() ; _refreshStores()
    dateField.text   = new Date().toISOString().slice(0, 10)   // AAAA-MM-JJ, UTC
    storeField.editText = "" ; qtyField.value = defaultQuantityG > 0 ? defaultQuantityG : 0
    priceField.text = "" ; notesField.text = ""
    show(); raise(); priceField.forceActiveFocus()
```

> **Attention** : `qtyField.value` est écrit alors que `AppSpinBox` expose `realValue` — voir §7.

Deux `ListModel` : `historyModel` (**ordre chronologique croissant**, utilisé tel quel par le
graphique) et `storesModel` (autocomplétion des enseignes).

`_refreshHistory()` : vide le modèle, sort si `ingredientId <= 0`, sinon
`ingredientVM.priceHistoryFor(ingredientId) || []` et `append` de chaque item, puis
`chartCanvas.requestPaint()`.
`_refreshStores()` : `ingredientVM.knownStores() || []` → `{ name: <string> }`.

Champs d'un item d'historique : `id`, `recordedAtIso`, `store`, `quantityG`, `priceEur`,
`pricePer100g`, `notes`.

#### En-tête

Titre + sous-titre : si le modèle est non vide,
`"N observation(s) · de <premier recordedAtIso[0:10]> à <dernier recordedAtIso[0:10]>"`,
sinon « Aucune observation enregistrée. ».

#### Formulaire d'ajout (`GridLayout`, 6 colonnes)

En-têtes de colonnes : « Date », « Enseigne », « Quantité (g) », « Prix (€) », « Notes », + une
colonne de 100 px sans titre pour le bouton.

| Champ | Composant | Détails |
|---|---|---|
| Date | `AppTextField` (170 px avec le bouton) | placeholder **« YYYY-MM-DD »**. Bouton carré 32×32 « 📅 » (Rectangle custom, pas `AppButton`, « pour avoir un carré exact 32×32 sans le padding minimum d'AppButton »), infobulle « Ouvrir le calendrier » (délai 400 ms), ouvre `DatePickerPopup` |
| Enseigne | `ComboBox` **éditable** (140 px) | modèle `storesModel`, `textRole: "name"`, `TextField` interne avec placeholder « Lidl, Auchan… ». Style custom (rayon `sm`, bordure `borderFocus` au focus) |
| Quantité (g) | `AppSpinBox` (110 px) | 1 décimale, `0 … 100000`, pas 10, `emptyOnZero: true` |
| Prix (€) | `AppTextField` (100 px) | placeholder « ex : 2,50 » — **texte libre**, parsé côté Python |
| Notes | `AppTextField` (fillWidth) | placeholder « Optionnel » |
| — | `AppButton` « + Ajouter » (primary, 100 px) | **activé si** `priceField.text.trim().length > 0 && qtyField.realValue > 0 && dateField.text.trim().length > 0` |

`_submitNew()` :

```js
payload = { ingredientId, priceEur: priceField.text, quantityG: qtyField.realValue,
            store: storeField.editText, recordedAtIso: dateField.text.trim(),
            notes: notesField.text }
saved = ingredientVM.addPriceHistory(payload)
si saved && saved.id :
    priceField.text = "" ; notesField.text = ""
    qtyField.realValue = defaultQuantityG > 0 ? defaultQuantityG : 0
    // La DATE et l'ENSEIGNE sont volontairement conservées (saisie en rafale)
    _refreshHistory() ; _refreshStores() ; priceField.forceActiveFocus()
```

#### Graphique d'évolution (Canvas custom, 180 px de haut)

Titre « Évolution (€ / 100 g) ». Algorithme de tracé (à reproduire fidèlement) :

```
padding p = 24 ; police "11px <fontFamily>" ; textBaseline = middle

si aucune donnée :
    texte centré "Aucune donnée — ajoute des observations pour voir l'évolution."
    en colorTextDisabled → fin

ts[i] = new Date(item.recordedAtIso).getTime()      (ordre du modèle = croissant)
vs[i] = parseFloat(item.pricePer100g)
tMin = ts[0] ; tMax = ts[n-1]
vMin = min(vs) ; vMax = max(vs)
si vMax === vMin : vMax = vMin + 1 ; vMin = max(0, vMin - 1)
range = vMax - vMin
vMin = max(0, vMin - range*0.1) ; vMax = vMax + range*0.1     // marge de 10 %

axes : polyligne (p, p/2) → (p, h-p) → (w-p/2, h-p), 1 px colorBorder
étiquettes Y (colorTextSecondary, alignées à droite) :
    vMax.toFixed(2) + " €"  en (p-4, p/2+4)
    vMin.toFixed(2) + " €"  en (p-4, h-p-4)
étiquettes X : new Date(tMin).toISOString().slice(0,10) à gauche en (p, h-p/2+4)
               new Date(tMax).toISOString().slice(0,10) à droite en (w-p/2, h-p/2+4)

xOf(t) = (tMin === tMax) ? p + (w - p - p/2 - p)/2
                         : p + (t - tMin)/(tMax - tMin) * (w - p - p/2)
yOf(v) = (h - p) - (v - vMin)/(vMax - vMin) * (h - p - p/2)

ligne de moyenne : avg = somme(vs)/n, trait pointillé [4,4] colorTextDisabled
                   sur toute la largeur, étiquette "moy X.XX €" en (p+4, yOf(avg)-6)
polyligne des points : 2 px colorPrimary
points : rayon 3 (colorPrimary) ; rayon 5 et colorAccent pour le point survolé
```

**Survol** : recherche du point le plus proche **en X uniquement** ; seuil d'accroche **24 px**
au-delà duquel `hoverIndex = -1`. Infobulle flottante en
`(mouseX + 12, max(0, mouseY − 50))`, fond `colorText`, texte `colorBackground`, opacité 0.92,
contenu sur 3 lignes :

```
<recordedAtIso[0:10]>
<pricePer100g formaté 'f',2 en locale> € / 100 g
<store>            (ligne omise si store vide)
```

#### Tableau des observations

En-tête (28 px, fond `colorBackground`) : « Date » (100), « Enseigne » (130), « Qté (g) » (90,
aligné droite), « Prix (€) » (90, droite), « € / 100 g » (100, droite), « Notes » (fillWidth),
colonne d'action (70, sans titre).

**La liste est affichée en ordre chronologique inverse** : `model: historyModel.count` (un entier !)
et chaque délégué lit `historyModel.get(historyModel.count − 1 − index)`.

Lignes de 30 px, survol `colorSurfaceHover`. Formatage :
- date : `recordedAtIso.slice(0, 10)` ;
- enseigne : valeur ou « — » en `colorTextDisabled` si absente ;
- quantité : `Number(quantityG).toLocaleString(locale, 'f', 0)` ;
- prix : `'f', 2` ; €/100 g : `'f', 2` en `colorPrimary` medium ;
- action « ✕ » (40 px, `colorError` au survol, infobulle « Supprimer cette observation », délai
  400 ms) → `ingredientVM.deletePriceHistory(entry.id)` puis `_refreshHistory()` si succès.
  **Aucune confirmation n'est demandée.**

> Commentaire du code : « le prix de référence de l'ingrédient se recalcule automatiquement à partir
> de l'observation suivante la plus récente (plus besoin de bouton "promouvoir" : la dernière
> observation par date EST le prix actuel) ». Le VM émet `current_price_recomputed(ingredientId)`.

Pied : « Fermer » (secondary).

---

### 3.5 `LidlPlusSetupDialog` — « Lidl Plus — Auto-fetch des tickets (expérimental) »

**Fichier** : `dialogs/LidlPlusSetupDialog.qml` (399 lignes).
**Fenêtre** : 720×780, min 600×580. Flags **sans** `WindowMinMaxButtonsHint`.
**VM** : `lidlPlusVM`.

Libellé de l'entrée de menu, calculé dynamiquement dans `Main.qml` :

```
lidlPlusVM absent            → "Lidl Plus auto-fetch (expérimental)…"
!isAvailable                 → "Lidl Plus auto-fetch (lib manquante)…"
!isConnected                 → "Lidl Plus auto-fetch (non configuré)…"
enabled                      → "Lidl Plus auto-fetch · ✓ activé"
sinon                        → "Lidl Plus auto-fetch · désactivé"
```

`openCentered(parentWindow)` : centre, puis
`emailField.text = lidlPlusVM.connectedEmail`, `tokenField.text = ""`
(« on ne pré-remplit JAMAIS le password »), `statusLine.text = ""`, `show(); raise()`.

**Connexions** : `error_emitted(msg)` → `statusLine = "✗ " + msg` en `colorError` ;
`sync_completed(nb, msg)` → `statusLine = (nb >= 0 ? "✓ " : "") + msg`, couleur `colorSuccess` si
`nb >= 0 && lidlPlusVM.lastError === ""`, sinon `colorWarning`.

#### Sections

**1. Bandeau « expérimental »** (fond `colorWarning` à 12 %, bordure `colorWarning`, RichText) :
« ⚠ Cette feature est **expérimentale**. La lib `lidl-plus` est testée principalement DE/AT/UK ; le
support Lidl FR n'est pas garanti. En cas d'échec, tu peux toujours saisir tes tickets manuellement
via l'import fichier (Phases 1-4). »

**2. « État »** — trois voyants (cercle de 10 px) :

| Condition | Couleur | Texte |
|---|---|---|
| `isAvailable` | `colorSuccess` / `colorError` | « Lib \`lidl-plus\` installée » / « Lib \`lidl-plus\` non installée — \`pip install -e ".[lidl]"\` » |
| `isKeyringAvailable` | `colorSuccess` / `colorWarning` | « Module \`keyring\` disponible (stockage sécurisé OK) » / « Module \`keyring\` non installé — credentials non persistables » |
| `isConnected` | `colorSuccess` / `colorTextSecondary` | « Connecté en tant que : <email> » / « Non connecté » |

**3. « Authentification »** — encart d'aide (fond `primary` à 6 %, bordure `primary` à 30 %) :

- « **Comment obtenir le refresh_token** (à faire une fois) : »
- « 1. Ouvre une invite de commande dans le dossier du projet. 2. Lance la commande ci-dessous
  (remplace le numéro et le mot de passe) : »
- `TextEdit` **en lecture seule, sélectionnable**, police monospace, `colorPrimary` :
  `.venv\Scripts\python.exe -m lidlplus -c FR -l fr -u "+33XXXXXXXXX" -p "motDePasse" --2fa email auth`
- « 3. Reçois un code 2FA par email, saisis-le. Le terminal affiche un long token.
  4. Copie-le ici dans le champ « Refresh token » + ton email, puis Enregistre.
  Le token est stocké dans le **Windows Credential Manager** via la lib `keyring` — jamais en clair
  sur disque. »

Champs :

| Libellé | Type | Contraintes |
|---|---|---|
| « Email Lidl Plus » | `AppTextField` | placeholder « ex : ton.email@example.fr » |
| « Refresh token (depuis lidl-plus CLI) » | `AppTextField`, `echoMode: TextInput.Password` | placeholder « Long token obtenu via la commande lidlplus auth ci-dessus » |

Boutons :
- **« 💾 Enregistrer les credentials »** (primary), activé si
  `isKeyringAvailable && emailField.text.length > 3 && tokenField.text.length > 10`.
  → `lidlPlusVM.storeCredentials(email, token)` ; si OK : statut « ✓ Credentials enregistrés. »
  (vert) et **le champ token est vidé**.
- **« 🗑 Oublier les credentials »** (danger), visible seulement si `isConnected` →
  `purgeCredentials()`, statut « Credentials purgés. » (`colorTextSecondary`).
  **Aucune confirmation n'est demandée.**

**4. « Auto-fetch »** :

- `AppCheckBox` « Activer la synchronisation automatique », lié à `lidlPlusVM.enabled`,
  activé seulement si `isAvailable && isConnected` → `setEnabled(checked)`.
- « Intervalle » + `AppSpinBox` (**5 à 1440**, pas 5, 0 décimale) + « minutes ».
  Initialisé **une seule fois** via `Component.onCompleted: realValue = lidlPlusVM.pollIntervalMinutes`
  — pas de liaison bidirectionnelle, « sinon `setPollIntervalMinutes` notifie `pollIntervalMinutes`
  qui re-déclenche le binding et tombe dans une boucle ». `onRealValueChanged` appelle
  `setPollIntervalMinutes(realValue)` uniquement si la valeur diffère.
- Bouton « 🔄 Synchroniser maintenant » / « ⏳ Sync en cours… » (secondary), activé si
  `isAvailable && isConnected && !isSyncing` → `syncNow()`.
- Texte « Dernière sync : <lastFetchedHuman> ».

**5. Ligne de statut** (`statusLine`) puis pied avec « Fermer » (secondary).

Propriétés VM utilisées : `isAvailable`, `isKeyringAvailable`, `isConnected`, `connectedEmail`,
`enabled`, `pollIntervalMinutes`, `isSyncing`, `lastFetchedHuman`, `lastError`,
`pendingTicketCount`, plus les slots `storeCredentials`, `purgeCredentials`, `setEnabled`,
`setPollIntervalMinutes`, `syncNow`, `pendingTicketIds()`, `fetchTicketDetailAsDict(id)`,
`removePendingTicketId(id)`, et le signal `new_tickets_pending(ticketIds)`.

---

### 3.6 `RecipeMatchDialog` — « Recettes possibles »

**Fichier** : `dialogs/RecipeMatchDialog.qml` (412 lignes).
**Fenêtre** : 720×640, min 540×420.
**Déclencheur** : depuis IngredientsPage, après sélection multiple d'ingrédients.

#### API d'ouverture

```js
setMatchesCategorized(result, ingredientCount, parentWindow)   // API principale
open(items, ingredientCount, parentWindow)                     // rétrocompatibilité
```

`result` est un dict `{ ready: [...], missing: [...], shopping: [...] }` provenant de
`recipeListVM.findByIngredientsCategorized(selectedIds, 3)` (3 = nombre max d'ingrédients
manquants pour la catégorie « presque prêtes »).

Champs d'un item `ready` / `missing` : `recipeId, name, score, matchCount, totalCount,
missingCount, missingNames[], photoUrl`. **`missingNames` (tableau) est aplati en chaîne**
avant insertion dans le `ListModel` : `missingNamesStr = (r.missingNames || []).join(", ")`
(« QML ListModel n'aime pas les arrays imbriqués »).
Champs d'un item `shopping` : `ingredientId, name, unlockCount`.

Le mode de rétrocompatibilité `open(items, ...)` répartit lui-même :
`missing = totalCount − matchCount` ; si 0 → section « prêtes », sinon « manquantes », avec
`missingNamesStr = ""`.

#### Contenu

Titre « Recettes possibles » puis « Sélection : N ingrédient(s). ».

**Composant `RecipeCard`** (hauteur 80 px, basé sur `AppListItem`) :
- vignette 60×60, rayon `sm`, fond `colorSurfaceHover`, bordure ; `Image` en `PreserveAspectCrop`
  si `photoUrl`, sinon « 🍽 » (28 px) en `colorTextDisabled` ;
- nom (medium, `fontSizeMd`, élidé) ;
- sous-texte :
  - si prête : `"✓ Tous les ingrédients dispo (" + totalCount + ")"` en `colorSuccess` ;
  - sinon : `"Il te manque N ingrédient(s)"` + `" : " + missingNamesStr` si non vide,
    en `colorTextSecondary` ;
- badge (56×28, rayon `full`) : « ✓ Prêt » en `colorSuccess` sur fond à 18 %, ou
  `Math.round(score × 100) + "%"` en `colorPrimary` sur fond à 12 %.

**Section 1 — « ✨  Tu peux faire maintenant  ·  N recette(s) »** (`colorSuccess`), visible si
`readyModel.count > 0`. Conteneur de hauteur `min(320, count × 82)`, bordure `colorSuccess` à 30 %,
`ListView` non interactive.

**Section 2 — « 📝  Il te manque peu  ·  N recette(s) »** (`colorPrimary`). Hauteur
`min(360, count × 82)`, bordure `colorPrimary` à 30 %.

**Section 3 — « 🛒  À acheter pour débloquer »** (`colorWarning`) + explication : « Ces ingrédients
reviennent souvent dans les recettes presque-prêtes. Acheter l'un d'eux suffit à rendre plusieurs
recettes immédiatement faisables. » Hauteur `count × 40 + 4`, bordure `colorWarning` à 30 %.
Chaque ligne (36 px) : « 🛒 » + nom + `"→ débloque N recette(s)"` en `colorWarning` semi-bold.
Infobulle « Cliquer pour ouvrir cet ingrédient en édition » (délai 600 ms).

Au clic :

```js
const win = Window.window
si win && win.transientParent && win.transientParent.navigateToIngredient :
    win.transientParent.navigateToIngredient(model.ingredientId)
    root.close()
```

> **Piège** : `transientParent` n'est **jamais assigné** sur ce `Window` (contrairement au
> `linePicker` de `ReceiptImportDialog`). Voir §7, ambiguïté #4.

**État vide** (les 3 modèles vides) : « 🍳 » (64 px) + « Aucune recette ne correspond avec ces
ingrédients. ».

Pied : « Fermer » (primary).

La propriété `matchThreshold` (défaut 50) est déclarée mais **explicitement inutilisée**
(« legacy — non utilisé en mode catégorisé »).

---

### 3.7 `UnifiedSearchDialog` — recherche unifiée Ctrl+K

**Fichier** : `dialogs/UnifiedSearchDialog.qml` (300 lignes).
**Type** : `Popup` QML **modal** (pas une `Window`), 640×520, fond `colorSurface` rayon `lg`,
overlay `colorOverlay`. `closePolicy: CloseOnEscape | CloseOnPressOutsideParent`.
Animation d'entrée : opacité 0 → 1 et scale 0.96 → 1.0 sur `durationFast`.
**Signal sortant** : `itemActivated(string kind, var payload)`.

`openCentered()` : positionne à `x = (win.width − width)/2`, `y = (win.height − height)/4`
(« un peu vers le haut »), vide le champ, réinitialise les résultats, `open()` puis
`queryField.forceActiveFocus()`.

#### Champ et navigation

`AppTextField` pleine largeur, `fontSizeLg`, placeholder **« Rechercher dans tout — ingrédients,
recettes, calendrier… »**. **Anti-rebond 200 ms**.
Clavier : ↑ / ↓ déplacent `_selectedIndex` dans la liste **plate** (bornée `[0, length−1]`),
Entrée / Enter → `_activateSelected()`, Échap → fermeture.

> **Défaut connu** : la navigation clavier ne **saute pas** les en-têtes de section — la sélection
> peut se poser dessus et Entrée est alors sans effet (`_activateSelected` retourne si
> `kind === "section_header"`). Voir §7.

#### Construction des résultats (`_runSearch`)

```js
q = queryField.text.trim() ; si vide → résultats vides
flat = []

ings = ingredientVM.searchOnce(q, "personal", 12) || []
si ings.length > 0 :
    flat.push({ kind: "section_header", label: "🥕 Ingrédients" })
    pour chaque : { kind: "ingredient", icon: "🥕", label: name,
                    sublabel: ("CIQUAL"|"OpenFoodFacts"|"perso" selon source)
                              + (inSeasonNow === true ? "  ·  🌱 de saison" : ""),
                    payload: { id } }

recs = recipeListVM.searchOnce(q, 12) || []
si recs.length > 0 :
    flat.push({ kind: "section_header", label: "🍽 Recettes" })
    pour chaque : { kind: "recipe", icon: "🍽", label: name,
                    sublabel: defaultPortions + " portion(s)" + "  ·  " + lineCount + " ingrédient(s)",
                    payload: { id } }

cals = calendarVM.searchOnce(q, 12) || []
si cals.length > 0 :
    flat.push({ kind: "section_header", label: "📅 Calendrier · semaine courante" })
    dayLabels  = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"]
    slotLabels = { morning:"matin", noon:"midi", evening:"soir",
                   snack_morning:"10 h", snack_afternoon:"16 h" }
    pour chaque : { kind: "meal_entry", icon: "📅", label: description,
                    sublabel: dayLabels[dayOfWeek] + " " + (slotLabels[slot] || slot),
                    payload: { isoWeek, dayOfWeek, slot } }

_selectedIndex = index du premier élément non-header (0 si aucun)
```

#### Rendu

En-tête de section : hauteur 28, fond `colorBackground`, texte `fontSizeXs` semi-bold
`colorTextSecondary` **en majuscules** (`Font.AllUppercase`), marge gauche `spaceMd`.
Élément : hauteur 44, rayon `sm`, fond `primary` à 12 % si sélectionné, sinon `surfaceHover` au
survol. Contenu : icône + (label `fontSizeMd` / sublabel `fontSizeXs` si non vide) + « ↩ » en
`colorPrimary` sur l'élément sélectionné.

État vide : « Tape pour chercher dans tout — Ctrl+K depuis n'importe quel onglet. » ou
« Aucun résultat. ».
Pied : « ↑ / ↓ pour naviguer · Entrée pour ouvrir · Esc pour fermer » (`fontSizeXs`,
`colorTextDisabled`, centré).

#### Câblage dans `Main.qml`

```js
onItemActivated(kind, payload):
    "ingredient" → tabBar.currentIndex = 0                                  // ne sélectionne PAS la ligne
    "recipe"     → tabBar.currentIndex = 1 ; recipeEditorVM.loadById(payload.id)
    "meal_entry" → tabBar.currentIndex = 2 ; calendarVM.setIsoWeek(payload.isoWeek)
```

> Le commentaire d'en-tête du fichier promet « la page Ingrédients sélectionne la ligne », mais le
> handler ne fait que changer d'onglet. Voir §7.

---

### 3.8 `AddCalendarEntryDialog` — « Ajouter au calendrier »

**Fichier** : `dialogs/AddCalendarEntryDialog.qml` (215 lignes).
**Fenêtre** : 540×380, min 420×320. Flags **sans** `WindowMinMaxButtonsHint`.
**Signaux sortants** : `recipePicked(int dayOfWeek, string slot, int recipeId, real portions)` et
`ingredientPicked(int dayOfWeek, string slot, int ingredientId, real quantityG)`.

`openFor(dayOfWeek, slot, parentWindow)` :

```js
targetDay = dayOfWeek ; targetSlot = slot ; centre la fenêtre
recipeOptions.clear()
si recipeListVM existe :
    pour chaque ligne de recipeListVM.items (QAbstractListModel) :
        append { text: data(idx, Roles.name), value: data(idx, Roles.recipeId) }
    si count > 0 : recipeCombo.currentIndex = 0
_pickedIngId = -1 ; _pickedIngName = "" ; pickedLabel.text = "(aucun)"
ingPicker.clear() ; portionsSpin.realValue = 1.0 ; ingQty.grams = 80
show(); raise()
```

Titre interne : `"Ajouter au " + _slotLabel(slot) + " — " + _dayLabel(day)` avec
`_dayLabel` = `["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"][d] || ""` et
`_slotLabel(s)` = `morning → "matin"`, `noon → "midi"`, sinon **`"soir"`**.

> **Bug de couverture** : `_slotLabel` ne connaît pas `snack_morning` / `snack_afternoon`, qui
> s'afficheront donc « soir ». Voir §7.

#### Onglets

`TabBar` avec deux `AppTabButton` de 160 px : **« 🍽 Recette »** et **« 🥕 Ingrédient »**.

**Onglet Recette** :
- `AppComboBox` (fillWidth, max 320), `textRole: "text"`, `valueRole: "value"`, modèle
  `recipeOptions`.
- « Portions : » + `AppSpinBox` (100 px) : **2 décimales**, `0.25 … 50`, pas 0.5, défaut 1.0.

**Onglet Ingrédient** :
- `IngredientSearch` (fillWidth, max 480), `scope: "personal"`. Au choix :
  mémorise l'id/nom, met à jour le libellé, puis
  `ingQty.pieceWeightG = ingredientVM.getAsDict(id).pieceWeightG || 0`.
- « Sélectionné : » + libellé (défaut **« (aucun) »**, `colorTextSecondary`, élidé).
- « Quantité : » + `QuantityField` (fillWidth, max 320), **1 décimale**, valeur initiale **80 g**.

#### Validation

« Annuler » (secondary) → `close()`.
« Ajouter » (primary) → `_accept()` :

```js
si onglet 0 (Recette) :
    si recipeCombo.currentValue !== undefined && !== null :
        émet recipePicked(targetDay, targetSlot, currentValue, portionsSpin.realValue)
sinon :
    si _pickedIngId > 0 :
        émet ingredientPicked(targetDay, targetSlot, _pickedIngId, ingQty.grams)
close()     // TOUJOURS, même si rien n'a été émis
```

Câblage CalendarPage : `onRecipePicked → calendarVM.addRecipe(day, slot, recipeId, portions)` ;
`onIngredientPicked → calendarVM.addIngredient(day, slot, ingId, qty)`.

---

### 3.9 `AddPantryStockDialog` — « Ajouter au stock »

**Fichier** : `dialogs/AddPantryStockDialog.qml` (202 lignes).
**Fenêtre** : 580×360, min 480×320. Titre système « Ajouter au stock », titre interne
**« Ajouter un article au frigo »**.
**Signal sortant** : `submitted(var payload)`.

`openCentered(parentWindow)` réinitialise **tout** : `ingPicker.clear()`, `_ingredientId = -1`,
`_ingredientName = ""`, `_ingredientPieceWeight = 0`, `qtyField.grams = 0`, `dateField.text = ""`,
`notesField.text = ""`.

`GridLayout` à 2 colonnes (libellé aligné à droite | champ) :

| Libellé | Composant | Détails |
|---|---|---|
| « Ingrédient : » | `IngredientSearch` (max 380) | placeholder « Tape pour chercher dans ta bibliothèque… ». Au choix : mémorise id/nom, puis `pw = ingredientVM.getAsDict(id).pieceWeightG || 0` → `qtyField.pieceWeightG = pw` |
| « Quantité : » | `QuantityField` (max 320) | 1 décimale |
| « Périme le : » | `AppTextField` (max 200) + bouton 32×32 « 📅 » | placeholder **« YYYY-MM-DD (optionnel) »**, alimenté par `DatePickerPopup` |
| « Notes : » | `AppTextField` (max 380) | placeholder « Ex : promo Lidl, ouvert hier… (optionnel) » |

Pied : « Annuler » (secondary) · « Enregistrer » (primary), **activé si
`_ingredientId > 0 && qtyField.grams > 0`**. Au clic :

```js
émet submitted({ ingredientId: _ingredientId,
                 quantityG:    qtyField.grams,
                 expiryIso:    dateField.text.trim(),
                 notes:        notesField.text.trim() })
close()
```

Côté PantryPage : `pantryVM.addStock(payload)` ; si `saved.id`, appelle aussi
`shoppingVM.refreshList()` (« l'auto-coche dépend du stock »).

**Aucune validation du format de date n'est faite** : la chaîne brute est transmise au VM.

---

### 3.10 `CookingHistoryDialog` — « Journal de cuisson »

**Fichier** : `dialogs/CookingHistoryDialog.qml` (320 lignes).
**Fenêtre** : 720×560, min 580×420. Titre dynamique `"Journal de cuisson · " + recipeName`.
**Signal sortant** : `entryAdded()` (émis à l'ajout **et à la suppression** — la page l'utilise pour
rafraîchir ses statistiques).

`openFor(id, name, parentWindow)` : mémorise `recipeId` / `recipeName`, met à jour le titre,
`_refreshHistory()`, puis remise à zéro du formulaire :
`dateField.text = new Date().toISOString().slice(0, 10)`, `notesField.text = ""`,
`ratingSpin.realValue = 0`. Centre, `show(); raise(); notesField.forceActiveFocus()`.

`_refreshHistory()` : sort si `recipeId <= 0` ou `recipeEditorVM` absent, sinon
`recipeEditorVM.cookingLogAsList() || []` (champs : `id`, `cookedAtHuman`, `rating`, `notes`).

> **Dépendance implicite** : `cookingLogAsList()` ne prend **aucun argument** — il s'appuie sur la
> recette actuellement chargée dans `recipeEditorVM`, pas sur `root.recipeId`. Voir §7.

En-tête : titre + « Aucune cuisson enregistrée. » ou « Cuisinée N fois au total. ».

**Formulaire d'ajout** (`GridLayout` 5 colonnes) — en-têtes « Date », « Note (1-5, 0 = pas de
note) », « Notes » (colspan 2), colonne bouton de 110 px :

| Champ | Composant | Détails |
|---|---|---|
| Date | `AppTextField` + bouton 32×32 « 📅 » | placeholder « YYYY-MM-DD », `DatePickerPopup` |
| Note | `AppSpinBox` (80 px) | 0 décimale, `0 … 5`, pas 1, `emptyOnZero: false` (donc « 0 » s'affiche) |
| Notes | `AppTextField` (colspan 2) | placeholder « Optionnel — ex : « plus de sel la prochaine fois » » |
| — | `AppButton` « + Ajouter » (primary, 110 px) | activé si `dateField.text.trim().length > 0` |

`_submitNew()` :

```js
saved = recipeEditorVM.addCookingLog({ cookedAtIso: dateField.text.trim(),
                                       rating: ratingSpin.realValue,
                                       notes: notesField.text })
si saved && saved.id :
    notesField.text = "" ; ratingSpin.realValue = 0   // la DATE est conservée
    _refreshHistory() ; émet entryAdded() ; notesField.forceActiveFocus()
```

**Tableau** — en-tête 28 px : « Date » (110), « Note » (80), « Notes » (fillWidth), colonne
action (40). Lignes de 32 px :
- date : `cookedAtHuman` (déjà formaté côté VM) ;
- note : `"★".repeat(rating) + "☆".repeat(5 − rating)` en `colorWarning` si `rating > 0`,
  sinon « — » en `colorTextDisabled` ;
- notes : texte ou vide (`colorTextDisabled` si vide) ;
- « ✕ » → `recipeEditorVM.deleteCookingLog(model.id)` ; si OK, `_refreshHistory()` + `entryAdded()`.
  **Pas de confirmation.**

État vide : « Aucune cuisson enregistrée. Ajoute la première ! ».
Pied : « Fermer » (secondary).

---

### 3.11 `IngredientFilterDialog` — « Filtres avancés — bibliothèque d'ingrédients »

**Fichier** : `dialogs/IngredientFilterDialog.qml` (353 lignes).
**Fenêtre** : 720×720, min 540×480. Contenu entièrement dans un `ScrollView`.

**Principe** : **aucun bouton « Appliquer »** — chaque modification est poussée immédiatement au
`ingredientVM`, et la liste derrière se met à jour en direct.

`openCentered(parentWindow)` recharge `rayonOptions = categoryVM.flatL1()` puis centre et affiche.

Helpers JS locaux :
```js
_toggleInSet(list, value)  // retire si présent (filter), ajoute sinon (concat) — renvoie un NOUVEAU tableau
_isInSet(list, value)      // list && list.indexOf(value) >= 0
```

#### En-tête

Titre « Filtres avancés » + boutons **« ↺ Réinitialiser »** (secondary →
`ingredientVM.resetFilters()`) et **« Fermer »** (primary).
Ligne de statut italique : `"N filtre(s) actif(s)"` en `colorPrimary` si
`ingredientVM.activeFilterCount > 0`, sinon « Aucun filtre actif — tous les ingrédients affichés. »
en `colorTextSecondary`.

#### Section « SOURCE »

Trois `AppCheckBox` : « CIQUAL » (`ciqual`), « OpenFoodFacts » (`openfoodfacts`),
« Manuel » (`manual`). État lu dans `ingredientVM.filterSources` ; au clic →
`ingredientVM.setFilterSources(_toggleInSet(filterSources, code))`.
Aide : « Aucune coche = toutes les sources affichées. »

#### Section « RAYONS » (visible si `rayonOptions.length > 0`)

`Flow` de puces (rayon `full`, hauteur 28, padding horizontal `spaceMd`). Sélectionnée : fond
`primary` à 18 %, bordure `primary`, texte `colorPrimary` semi-bold. Sinon : fond `colorSurface`,
bordure `colorBorder`, texte `colorText` regular.
Clic → `ingredientVM.setFilterRayons(_toggleInSet(filterRayons, modelData.name))` — le filtre porte
donc sur le **nom** du rayon, pas son id.
Aide : « Aucune sélection = tous les rayons. Édite la liste via Fichier → Paramètres → Rayons
d'ingrédients. »

#### Section « FILTRES RAPIDES » (grille à 2 colonnes)

| Libellé exact | Propriété / slot |
|---|---|
| « 🌱 De saison ce mois-ci » | `filterInSeason` / `setFilterInSeason(checked)` |
| « 🏷️ Avec une marque renseignée » | `filterWithBrand` / `setFilterWithBrand(checked)` |
| « ● Avec un poids unitaire défini » | `filterWithPieceWeight` / `setFilterWithPieceWeight(checked)` |
| « 💰 Avec un prix renseigné » | `filterWithPrice` / `setFilterWithPrice(checked)` |

#### Section « PLAGES MACROS (min — max, par 100 g) »

Aide : « Laisser un champ à 0 = pas de borne sur ce côté. Une valeur min ou max active = on
n'affiche QUE les ingrédients dont la valeur est connue ET dans la plage. »

Composant interne `MacroRow` : label (110 px) + `AppSpinBox` min (110 px) + « — » +
`AppSpinBox` max (110 px). Les deux spinbox : 1 décimale, `0 … maxValue`, pas 1, `emptyOnZero: true`.
Initialisation par `Component.onCompleted: realValue = ingredientVM.macroRange(macro).min|.max`
(pas de liaison, pour éviter les boucles).
Écriture : `ingredientVM.setMacroRange(macro, min, max)` avec relecture de l'autre borne via
`macroRange(macro)`, et seuil de non-régression `> 1e-6`.

| Libellé | `macro` | `maxValue` |
|---|---|---|
| « Énergie » | `kcal` | 2000 |
| « Lipides » | `fats` | 100 |
| « Glucides » | `carbs` | 100 |
| « Fibres » | `fiber` | 50 |
| « Protéines » | `proteins` | 100 |
| « Sel » | `salt` | 30 |

---

### 3.12 `SettingsCategoriesDialog` — « Paramètres — Rayons d'ingrédients »

**Fichier** : `dialogs/SettingsCategoriesDialog.qml` (363 lignes).
**Fenêtre** : 640×600, min 480×380. **VM** : `categoryVM`.

**Modèle mental** (commentaire du code, essentiel au portage) : la hiérarchie L1 → L2 a été
**abandonnée en UI**. La table `category_definition` conserve son schéma hiérarchique (`parent_id`)
en base pour ne pas casser les seeds CIQUAL, mais **seuls les L1 (`parent_id IS NULL`) sont
exposés**. Les L2 hérités restent en base, silencieusement.

`openCentered(parentWindow)` : sort si `categoryVM` absent, sinon `rayons = categoryVM.flatL1()`,
centre, affiche.
Connexions : `tree_changed()` → recharge `flatL1()` ; `error_emitted(msg)` → bandeau d'erreur.

Contenu :
- Titre « Rayons d'ingrédients ».
- Description : « Liste plate de rayons type supermarché (Fruits & légumes, Viandes, Produits
  laitiers, etc.). Sert à grouper tes ingrédients dans la liste de courses et le frigo. Au
  renommage, les ingrédients existants sont mis à jour automatiquement. À la suppression, ils
  perdent leur rayon. »
- **Bandeau d'erreur** : fond `colorError` à 12 %, bordure `colorError`, texte `"⚠ " + message`,
  auto-masquage après **5 s**.
- **Ajout** : `AppTextField` (placeholder « Nouveau rayon (ex: Fruits & légumes, Viandes…) »,
  Entrée = valider) + `AppButton` « + Ajouter » (primary, activé si texte non vide après `trim`).
  → `categoryVM.addL1(text.trim())` ; si le retour est `> 0`, le champ est vidé.
- **Liste** : lignes de 44 px, survol `colorSurfaceHover`, séparateur 1 px à 30 %.
  Contenu : « 📁 » + nom (medium) + bouton « Renommer » (secondary, 32 px) + bouton
  « Supprimer » (danger, 32 px).
- État vide : « Aucun rayon configuré.\nAjoutes-en avec le champ ci-dessus. »
- Pied : « Fermer » (primary).

**Popup de renommage** (modal, 360 px, bordure `colorPrimary`) : titre « Renommer le rayon »,
`AppTextField` (placeholder « Nouveau nom », pré-sélectionné via `selectAll()`, Entrée = valider),
boutons « Annuler » (ghost) et « Renommer » (primary, activé si texte non vide).
→ `categoryVM.rename(categoryId, newName)` ; ferme si succès.

**Popup de suppression** (modal, 400 px, bordure `colorError`) : titre
`"Supprimer le rayon « <nom> » ?"`, texte « Les ingrédients qui y pointaient perdront leur rayon. »,
boutons « Annuler » (ghost) et « Supprimer » (danger) → `categoryVM.delete(id)` puis fermeture
inconditionnelle.

> `categoryVM.delete(...)` utilise le mot-clé JS réservé `delete` comme nom de méthode — cela
> fonctionne en QML mais nécessitera `categoryVM["delete"](id)` ou un renommage en TypeScript.

---

### 3.13 `CategoryPickerDialog` — « Choisir un rayon »

**Fichier** : `dialogs/CategoryPickerDialog.qml` (178 lignes).
**Fenêtre** : 460×520, min 360×320. **`modality: Qt.ApplicationModal`** — le seul dialogue
réellement modal application-wide. Flags sans min/max.
**Signal sortant** : `categorySelected(string l1Name, string l2Name)` — le 2e argument est
**toujours la chaîne vide**, conservé pour compatibilité avec l'ancienne API hiérarchique.

`openPicker(currentL1, currentL2, parentWindow)` : sort si `categoryVM` absent ;
`currentName = currentL1 || ""` ; `rayonList = categoryVM.flatL1()` ; centre ;
`show(); raise(); requestActivate()`. Le 2e paramètre `currentL2` est **ignoré**.

Connexion `categoryVM.tree_changed()` → recharge la liste (« si l'éditeur Paramètres est ouvert en
parallèle »).

Contenu : titre « Choisir un rayon » ; sous-titre
`"Rayon actuel : " + currentName` ou « Aucun rayon assigné. Sélectionne-en un dans la liste. » ;
liste (`AppListItem`, 44 px) : « 📁 » + nom (medium) + « ✓ » en `colorPrimary` sur la ligne courante.
Clic → `categorySelected(modelData.name, "")` + fermeture.
État vide : « Aucun rayon configuré.\nOuvre Fichier → Paramètres → Rayons d'ingrédients pour en
créer. »
Pied : « Aucun rayon » (secondary, à gauche) → `categorySelected("", "")` + fermeture ; espace ;
« Annuler » (ghost).

**Modèle de câblage côté appelant** (IngredientsPage) — à reproduire en web par une promesse ou un
callback à usage unique :

```js
function _onPicked(l1, _l2) {
    categoryFields.l1 = l1
    win.categoryPickerDialog.categorySelected.disconnect(_onPicked)   // déconnexion IMMÉDIATE
}
win.categoryPickerDialog.categorySelected.connect(_onPicked)
win.categoryPickerDialog.openPicker(categoryFields.l1, "", win)
```

---

### 3.14 `IngredientSearchPopup` — « Rechercher un ingrédient » (sous-dialogue d'import URL)

**Fichier** : `dialogs/IngredientSearchPopup.qml` (310 lignes).
**Fenêtre** : 760×600, min 600×420. Non-modale, détachable.
Utilisé **uniquement** par `ImportRecipeUrlDialog` (menu « Actions ▾ » d'une ligne).

`openFor(parentWindow, lineIdx, lineRawText, parsedName, source)` :
mémorise la cible, `queryField.text = parsedName || ""`, vide résultats et erreur, puis mappe
`source` → onglet : `"personal" → 0`, `"off" → 2`, tout le reste (dont `"ciqual"`) → **1**.
Centre, affiche, **et lance une recherche automatique si la requête n'est pas vide**.

Onglets (`AppTabButton`) : « Bibliothèque personnelle » (220), « CIQUAL (local) » (180),
« OpenFoodFacts (en ligne) » (220). Changer d'onglet relance la recherche si la requête est non vide.

`_doSearch()` :

```js
q = queryField.text.trim() ; si vide → results = [] et return
errorText = "" ; searching = true
try {
    onglet 0 → results = ingredientVM.searchOnce(q, "personal", 50)
    onglet 1 → results = ingredientVM.searchBySource(q, "ciqual", 50)
    onglet 2 → results = ingredientVM.fetchOnlineAndList(q, 30)     // bloquant ~1-3 s
} catch (e) { errorText = String(e) ; results = [] }
searching = false
si results vide et pas d'erreur : errorText = "Aucun résultat pour « " + q + " »."
```

> **Limite desktop** : l'appel OFF est **synchrone/bloquant**. Le `AppSpinner` déclaré ne peut pas
> s'animer pendant le blocage du thread UI (contrairement à `ImportIngredientDialog` qui emballe
> l'appel dans `Qt.callLater`). Voir §7.

Champ de recherche : `AppTextField` (placeholder « Tape un nom (ex: oignon, crème liquide…) »,
Entrée = rechercher) + bouton « Chercher » (primary, activé si non vide et pas de recherche en
cours). `AppSpinner` de 36 px centré pendant la recherche.

**Liste des résultats** — lignes de 48 px, rayon `sm`, fond `primary` à 10 % au survol sinon
zébrage `transparent` / `colorBorder` à 6 % :
- badge source 60×22 (couleurs §2.6, fond à **14 %**) ;
- nom (`fontSizeMd`, élidé) + sous-ligne : `brand` si non vide, sinon `categoryL1` (italique,
  `fontSizeXs`) ;
- « ★ » en `colorWarning` si `inLibrary === true` ;
- bouton « Choisir » (primary, 100 px).
Double-clic sur la ligne (la `MouseArea` a `anchors.rightMargin: 110` pour ne pas couvrir le bouton)
= même effet.

`_pickResult(item)` :

```js
si !item || !item.id → return
si item.inLibrary !== true : ingredientVM.importExisting(item.id)
recipeUrlImportVM.setLineChosenIngredient(targetLineIdx, item.id)
close()
```

> Commentaire du code : `setLineChosenIngredient` « ajoute aussi l'id en tête des candidates pour que
> la combobox de la ligne affiche son nom ».

Pied : « Annuler » (secondary).

---

### 3.15 `RestoreBackupDialog` — « Restaurer une sauvegarde »

**Fichier** : `dialogs/RestoreBackupDialog.qml` (285 lignes).
**Fenêtre** : 580×480, min 480×360. **VM** : `backupVM`.

`openCentered(parentWindow)` : centre, `_refreshList()`, affiche.
`_refreshList()` : sort si `backupVM` absent, sinon `_backupDir = backupVM.backupDirectory()` puis
`backupVM.listBackups()` → items `{ path, name, timestampHuman, humanSize }`.

Contenu :
- Titre « Sauvegardes disponibles » ; ligne « Dossier : <chemin> » (`fontSizeXs`, élision au milieu).
- Liste (`AppListItem`, 56 px, `currentIndex` initial **−1**) : `timestampHuman` (medium) au-dessus
  de `name + "  ·  " + humanSize`. Simple clic = sélectionner ; **double-clic = restaurer**.
- État vide : « Aucune sauvegarde » (`fontSizeLg` medium) + « Les sauvegardes sont créées
  automatiquement à chaque lancement de l'application. Reviens ici après quelques sessions. »
- Bandeau de succès (visible après restauration, fond `colorSuccess` à 10 %) :
  « ✓ Restauration effectuée. L'état précédent a été sauvegardé dans :\n<safetyPath>\n\nFerme et
  relance l'application pour appliquer la restauration. »
- Boutons : « Ouvrir le dossier » (ghost, activé si `_backupDir !== ""`) →
  `Qt.openUrlExternally("file:///" + _backupDir.replace(/\\/g, "/"))` ; « Fermer » (secondary) ;
  « Restaurer la sélection » (primary, activé si `currentIndex >= 0 && !_restoreSucceeded`).

**Confirmation** (`AppDialog` modal, 480 px, `standardButtons: Ok | Cancel` → libellés Qt natifs) :
titre « Confirmer la restauration », texte RichText
`"Restaurer la sauvegarde du <b><label></b> ?"` + « L'état actuel sera lui-même sauvegardé avant
l'écrasement, donc cette opération est réversible. Tu devras relancer l'application après la
restauration. ». `onAccepted` → `backupVM.restoreFromPath(targetPath)` ; si OK,
`_restoreSucceeded = true`. Le chemin de la sauvegarde de sécurité arrive **par le signal**
`backupVM.restored(safetyPath)`.

`backupVM.error_emitted(message)` → toast rouge en bas (5 s).

**Ce dialogue n'a pas d'équivalent web direct** — voir §6.

---

### 3.16 `ShortcutsDialog` — « Raccourcis clavier »

**Fichier** : `dialogs/ShortcutsDialog.qml` (166 lignes).
**Fenêtre** : 540×580, min 420×400. Contenu statique (tableau `shortcuts` codé en dur).

Introduction : « Les raccourcis sont contextuels — Ctrl+N crée un nouvel ingrédient sur l'onglet
Ingrédients, une nouvelle recette sur l'onglet Recettes. »

| Catégorie | Touches | Libellé |
|---|---|---|
| **Navigation** | Ctrl+1 | Aller à l'onglet Ingrédients |
| | Ctrl+2 | Aller à l'onglet Recettes |
| | Ctrl+3 | Aller à l'onglet Calendrier |
| | Ctrl+4 | Aller à l'onglet Liste de courses |
| | Ctrl+5 | Aller à l'onglet Frigo / Cellier |
| | Ctrl+K | Recherche unifiée (ingrédients / recettes / calendrier) |
| | Ctrl+/ | Afficher cette aide |
| | Échap | Fermer le dialog ouvert |
| **Actions globales** | Ctrl+N | Créer (ingrédient ou recette selon l'onglet) |
| | Ctrl+S | Enregistrer le formulaire en cours |
| | Suppr | Retirer l'élément sélectionné |
| | Ctrl+F | Focus sur la barre de recherche |
| **Calendrier** | Ctrl+← | Semaine précédente |
| | Ctrl+→ | Semaine suivante |
| | Ctrl+T | Aller à la semaine courante (today) |
| **Affichage** | Ctrl+Shift+D | Basculer mode clair / sombre |
| **Diagnostic** | Menu Aide | Ouvrir le dossier de logs (~/.prandia/logs/) |
| | PRANDIA_DEBUG=1 | Activer DEBUG en variable d'env (relance requise) |

Rendu : titre de catégorie en **majuscules**, `colorPrimary`, `fontSizeXs` semi-bold,
`letterSpacing 0.8`. Chaque ligne : « keycap » (rectangle 130×24, fond `colorSurfaceHover`, bordure
`colorBorder`, rayon `sm`, police `"Consolas, Monaco, monospace"` `fontSizeSm` medium) + libellé.

---

## 4. Composants réutilisables porteurs de logique

### 4.1 `QuantityField.qml` — conversion d'unités et gestion des pièces

**Le composant le plus critique à porter fidèlement.** Spinbox + combobox d'unité, **stockage
interne toujours en grammes**.

#### API publique

| Propriété | Type | Défaut | Rôle |
|---|---|---|---|
| `grams` | real | `0.0` | **source de vérité** — valeur en grammes |
| `pieceWeightG` | real | `0` | `0` = pas d'unité pièce ; `> 0` = ajoute « pièce (X g) » en tête |
| `decimals` | int | `1` | décimales du spinbox |
| `maxGrams` | real | `1000000.0` | borne haute |
| `preferredUnit` | string | `""` | code d'unité à restaurer au chargement (`"g"`, `"ml"`, `"_piece"`…) ; `""` = heuristique historique |

| Signal | Émission |
|---|---|
| `gramsEdited(real grams)` | **uniquement** sur saisie utilisateur dans le spinbox — **pas** au changement d'unité |
| `unitChanged(string unitCode)` | au changement d'unité dans la combobox |

Espacement interne `spaceXs` (4 px). Spinbox en `fillWidth`, combobox de **110 px**.

#### Table d'unités statiques (miroir exact de `app/domain/units.py`)

| `code` | `label` (affiché) | `factor` (→ grammes) |
|---|---|---|
| `g` | « g » | 1.0 |
| `kg` | « kg » | 1000.0 |
| `mg` | « mg » | 0.001 |
| `ml` | « ml » | 1.0 |
| `cl` | « cl » | 10.0 |
| `dl` | « dl » | 100.0 |
| `L` | « L » | 1000.0 |
| `c_cafe` | « c. à café » | 5.0 |
| `c_soupe` | « c. à soupe » | 15.0 |
| `tasse` | « tasse » | 250.0 |
| `pincee` | « pincée » | 1.0 |

> Note : `ml` et `g` ont le même facteur 1.0 (hypothèse densité = 1). `pincee` vaut 1 g.

#### Construction de la liste effective

```js
_buildUnits(pw):
    si pw > 0 : renvoie [{ code: "_piece", label: "pièce (" + _formatG(pw) + ")", factor: pw }]
                       .concat(staticUnits)
    sinon      : renvoie staticUnits

_formatG(g):
    si |g − round(g)| < 1e-6 : round(g) + " g"          // ex. "60 g"
    sinon                    : g.toFixed(1) avec "." → "," + " g"   // ex. "62,5 g"
```

L'unité pièce, quand elle existe, est **toujours à l'index 0**.

#### Synchronisation grammes ↔ affichage

```js
_currentFactor()  = units[unitIndex]?.factor ?? 1.0

_refreshSpinFromGrams():
    _suppressEdit = true
    spin.realValue = grams / _currentFactor()
    _suppressEdit = false
```

Le drapeau `_suppressEdit` est le garde-fou anti-boucle : il neutralise les handlers pendant les
écritures programmatiques.

**À l'initialisation** (`Component.onCompleted`) : `_applyPreferredUnit()` puis
`_refreshSpinFromGrams()`.

**`_applyPreferredUnit()`** : si `preferredUnit` est vide → ne fait rien ; sinon cherche l'index du
code et l'applique s'il existe et diffère de l'index courant.

**Changement de `preferredUnit`** : `_applyPreferredUnit()` + `_refreshSpinFromGrams()`.

**Changement de `pieceWeightG`** (logique complète, à reproduire à l'identique) :

```js
oldGrams  = grams
wasOnPiece = (units[unitIndex]?.code === "_piece")
units = _buildUnits(pieceWeightG)

si preferredUnit et présent dans la nouvelle liste :
    unitIndex = index(preferredUnit)          // la préférence du parent PRIME
sinon si pieceWeightG > 0 :
    unitIndex = 0                             // "_piece" est en index 0
sinon si wasOnPiece :
    unitIndex = 0                             // "g" est en index 0 quand pas de pièce

grams = oldGrams                              // la valeur en grammes est préservée
_refreshSpinFromGrams()
```

**Changement externe de `grams`** (liaison du parent) : si `_suppressEdit`, ne rien faire ;
sinon recalculer `expected = grams / _currentFactor()` et ne rafraîchir le spin que si
`|spin.realValue − expected| > 1e-6`.

**Saisie dans le spin** :

```js
onRealValueChanged:
    si _suppressEdit → return
    newGrams = realValue × _currentFactor()
    si |newGrams − grams| > 1e-9 :
        _suppressEdit = true ; grams = newGrams ; _suppressEdit = false
        émet gramsEdited(newGrams)
```

**Changement d'unité** (`onActivated(index)`) : `unitIndex = index` ; `_refreshSpinFromGrams()` ;
émet `unitChanged(units[index].code)`. **La valeur en grammes ne change pas** (1000 g → « kg »
affiche 1,0).

Le spinbox interne a `realFrom: 0`, `realTo: maxGrams × 1000` (« amplement suffisant en pièces ou
kg »), `realStep: 1.0`.

**Comportement de référence documenté** : passer `pieceWeightG` de 0 à 60 ajoute « pièce (60 g) » en
tête et bascule dessus ; 100 g deviennent alors « 1.67 pièces ». Repasser à 0 fait disparaître
l'entrée et retomber sur « g » en préservant les grammes.

---

### 4.2 `FixedUnitField.qml` — nombre + unité figée

`RowLayout` avec `spacing: 0` : `AppSpinBox` (fillWidth) + cellule d'unité collée à droite
(`Rectangle` de largeur `unitLabel.implicitWidth + spaceMd × 2`, hauteur = celle du spin, fond
`colorSurfaceHover`, bordure 1 px `colorBorder`, **`radius: 0`**, texte `fontSizeSm`
`colorTextSecondary` centré).

| Propriété | Défaut |
|---|---|
| `value` | `0.0` |
| `unitText` | `"g/100g"` |
| `maxValue` | `10000.0` |
| `decimals` | `2` |

Signal `valueEdited(real value)`. Fonction `clear()` : `spin.realValue = 0.0` et `value = 0.0`.
Le spin est en `emptyOnZero: true`, `realFrom: 0`, `realTo: maxValue`, `realStep: 0.1`.

**Bug documenté à ne pas reproduire naïvement** : la liaison `realValue: root.value` sert
**uniquement d'initialisation**. Dès la première saisie, `AppSpinBox` écrit impérativement dans
`realValue`, ce qui **casse la liaison QML**. Sans le handler explicite ci-dessous, changer
d'ingrédient dans le formulaire n'aurait plus mis à jour le champ :

```js
onValueChanged: if (|value − spin.realValue| > 1e-9) spin.realValue = value
onRealValueChanged (du spin): si |realValue − value| > 1e-6 { value = realValue ; valueEdited(realValue) }
```

En web (React/Svelte), un composant contrôlé standard élimine ce problème — mais **il faut conserver
les seuils de tolérance** (`1e-9` / `1e-6`) pour éviter les boucles de rendu sur les flottants.

---

### 4.3 `IngredientSearch.qml` — champ + popup de suggestions

| Propriété | Défaut |
|---|---|
| `scope` | `"personal"` (l'autre valeur observée : `"all"`) |
| `placeholderText` | `"Rechercher un ingrédient…"` |
| `debounceMs` | `200` |
| `maxResults` | `12` |

Signal `ingredientPicked(int ingredientId, string ingredientName)`. Fonction `clear()`.
`implicitWidth: 320`, hauteur = celle du champ.

**Anti-rebond** : `Timer` de `debounceMs` (200 ms), `restart()` à chaque frappe. Un changement de
`scope` relance aussi la recherche si le champ n'est pas vide.

**Perte de focus** : si ni le champ ni le popup n'ont le focus → `Qt.callLater(popup.close)`.

**Navigation clavier** (sur le champ) :
- ↓ : `currentIndex = min(count − 1, currentIndex + 1)` (si le popup est ouvert et non vide)
- ↑ : `currentIndex = max(0, currentIndex − 1)`
- Entrée : `_pickAt(currentIndex)` si le popup est ouvert et `currentIndex >= 0`
- Échap : ferme le popup

Le survol souris d'une suggestion met aussi à jour `currentIndex`.

**`_runSearch()`** :

```js
q = input.text.trim() ; resultsModel.clear()
si q.length < 1 : popup.close() ; return
si ingredientVM absent : return                      // garde-fou pour les tests
matches = ingredientVM.searchOnce(q, scope, maxResults)
pour chaque m :
    append { ingredientId: m.id || 0,
             name:         m.name || "",
             source:       m.source || "manual",
             kcal:         (typeof m.kcal === "number")         ? m.kcal         : -1,
             pieceWeightG: (typeof m.pieceWeightG === "number") ? m.pieceWeightG : 0 }
si count > 0 : currentIndex = 0 ; ouvre le popup s'il ne l'est pas
sinon        : ferme le popup
```

**`_pickAt(index)`** : borne l'index, émet `ingredientPicked(id, name)`, **vide le champ**,
vide le modèle, ferme le popup.

**Popup** : `AppPopup`, positionné à `y = input.height + 4`, largeur = celle du champ, hauteur
`min(contentHeight + spaceXs × 2, 280)`, padding `spaceXs`, `ScrollIndicator` vertical.

**Délégué de suggestion** (`AppListItem`, 38 px) : nom (fillWidth, `fontSizeMd`, élidé) +
badge de source (hauteur 18, rayon `sm`, couleurs §2.6, fond à 12 %) + **indicateur pièce**
`"● 1 pc = " + pieceWeightG + " g"` (`fontSizeXs`, `colorTextSecondary`) visible si
`pieceWeightG > 0`.

> La valeur `kcal` est stockée dans le modèle mais **jamais affichée** dans le délégué.

---

### 4.4 `NutritionPanel.qml` — tableau réglementaire UE 1169/2011

`Rectangle` (surface, rayon `md`, bordure) contenant un tableau à N colonnes de valeurs.

| Propriété | Défaut | Rôle |
|---|---|---|
| `title` | `""` | titre facultatif (`fontSizeSm` medium `colorTextSecondary`) |
| `columnTitles` | `[]` | ex. `["Pour 100 g", "Par portion", "Recette entière"]` |
| `columnSubtitles` | `[]` | ex. `["", "≈ 281 g cuit", "561 g cuit"]` — italique, opacité 0.85 |
| `columnData` | `[]` | un dict par colonne |
| `valueColumnWidth` | `110` | largeur d'une colonne de valeurs (mode fixe) |
| `unitSlotWidth` | `30` | largeur réservée à l'unité — calée sur « kcal », la plus large |
| `labelColumnWidth` | `0` | `0` = zone de libellé élastique avec `minimumWidth: 160` |
| `useFlexibleColumns` | `false` | `true` = colonnes en `fillWidth` (alignement sur une grille externe) |
| `cellSpacing` | `spaceMd` | doit être identique à celui de la grille externe pour rester aligné |
| `centerCells` | `false` | `true` = titres et valeurs centrés ; `false` = alignés à droite avec le slot d'unité |
| `iconSize` | `22` | 18 px recommandé pour le calendrier (place réduite) |

`implicitHeight = contenu + spaceMd × 2` ;
`implicitWidth = 280 + valueColumnWidth × max(1, columnTitles.length)`.

**Les 8 lignes, dans l'ordre réglementaire UE — à ne pas modifier** :

| # | `key` | Libellé | `type` (icône) | Unité | Décimales | Sous-ligne |
|---|---|---|---|---|---|---|
| 1 | `kcal` | « Énergie » | `energy` | kcal | 0 | non |
| 2 | `fats` | « Lipides » | `fats` | g | 1 | non |
| 3 | `saturatedFats` | « dont saturés » | `saturatedFats` | g | 1 | **oui** |
| 4 | `carbs` | « Glucides » | `carbs` | g | 1 | non |
| 5 | `sugars` | « dont sucres » | `sugars` | g | 1 | **oui** |
| 6 | `fiber` | « Fibres » | `fiber` | g | 1 | non |
| 7 | `proteins` | « Protéines » | `proteins` | g | 1 | non |
| 8 | `salt` | « Sel » | `salt` | g | **2** | non |

Formatage : `_fmt(v, d)` renvoie **« — »** si `v` est `undefined` ou `null`, sinon
`Number(v).toLocaleString(Qt.locale(), 'f', d)` (donc **virgule décimale** en français).

Style : libellé normal en `colorText` `fontSizeMd` ; sous-ligne en
`colorTextSecondary` à 85 % d'alpha **et italique**. Valeur normale : `fontSizeMd` semi-bold ;
valeur de sous-ligne : regular + italique + même gris. Unité toujours `fontSizeXs`
`colorTextSecondary`.

Ordre visuel de la zone libellé : `[espace élastique] [libellé] [icône]` — l'icône est **à droite du
texte**, juste avant les colonnes de valeurs, et sert de séparateur visuel (pas de « : »).

**Truc d'alignement à reproduire** : titre de colonne et valeur partagent la structure
`[flex][texte][slot d'unité de largeur fixe]`. En mode non centré, la colonne d'en-tête est ancrée à
`parent.right` avec `rightMargin: unitSlotWidth`, et la valeur à `parent.right` avec
`rightMargin: unitSlotWidth − largeurUnité − 4`. Résultat : les nombres s'alignent verticalement
malgré la largeur variable de « kcal » vs « g ». **En CSS** : une grille avec une colonne d'unité de
largeur fixe (`grid-template-columns: … 1fr 30px`) reproduit exactement ce comportement.

Séparateur 1 px `colorBorder` à 60 % d'opacité sous les en-têtes.

---

### 4.5 `MacrosChart.qml` — donut Atwater

`Rectangle` (surface, rayon `md`, bordure), `implicitWidth: 280`, hauteur = contenu + `spaceMd × 2`.
Titre « Composition macros » (`fontSizeSm` medium `colorTextSecondary`), puis un `Canvas` carré dans
un `Item` de **220 px** de haut.

| Propriété | Défaut |
|---|---|
| `nutritionData` | `({})` |
| `perLabel` | `"/ 100 g"` |

**Conventions énergétiques (FAO Atwater)** — codées en dur :

```
1 g lipide   = 9 kcal
1 g glucide  = 4 kcal
1 g fibre    = 2 kcal
1 g protéine = 4 kcal
```

```js
fatsG     = nutritionData?.fats     ?? 0     // en réalité : test de véracité, donc 0 si falsy
carbsG    = nutritionData?.carbs    ?? 0
fiberG    = nutritionData?.fiber    ?? 0
proteinsG = nutritionData?.proteins ?? 0

kcalFats = fatsG*9 ; kcalCarbs = carbsG*4 ; kcalFiber = fiberG*2 ; kcalProteins = proteinsG*4
kcalAtwater = kcalFats + kcalCarbs + kcalFiber + kcalProteins    // base des pourcentages
_pct(part) = kcalAtwater > 0 ? part / kcalAtwater * 100 : 0
```

> **Attention** : le total affiché au centre est le **total Atwater recalculé**, PAS la valeur
> `kcal` fournie par les données. Les deux peuvent diverger (le CIQUAL publie une énergie mesurée).

**Quatre secteurs**, dans cet ordre : « Lipides » (`#FDA406`), « Glucides » (`#509938`),
« Fibres » (`#7CC04C`), « Protéines » (`#0B6BBB`), tous avec 1 décimale pour les grammes.

**Tracé** :

```
cx = w/2 ; cy = h/2 ; outerR = min(w,h)/2 − 4 ; innerR = outerR × 0.62

si kcalAtwater <= 0 :
    anneau plein colorBorder à 35 % d'alpha
    texte "aucune donnée" centré, "italic 12px <fontFamily>", colorTextSecondary
    → fin

startAngle = −π/2                              // départ à 12 h
pour chaque secteur (kcal > 0 seulement) :
    sweep = kcal / kcalAtwater × 2π
    ro = survolé ? outerR + 4 : outerR         // extrusion de 4 px au survol
    dessine l'anneau [innerR, ro] de startAngle à startAngle+sweep
    startAngle += sweep
```

**Texte central**, deux états :

- au repos : `Math.round(kcalAtwater) + " kcal"` en « bold 22px », `colorText`, à `(cx, cy − 6)` ;
  puis `perLabel` en « 11px » `colorTextSecondary` à `(cx, cy + 14)` ;
- au survol : libellé du nutriment en « bold 14px » de la couleur du secteur à `(cx, cy − 18)` ;
  grammes formatés (`'f', 1`, locale) + « g » en « bold 18px » `colorText` à `(cx, cy + 4)` ;
  `Math.round(kcal) + " kcal · " + pct('f',0) + " %"` en « 11px » `colorTextSecondary` à
  `(cx, cy + 22)`.

**Test de survol radial** (sans état pré-calculé, recalculé à chaque mouvement) :

```js
dist = hypot(mouse.x − cx, mouse.y − cy)
si dist < innerR || dist > outerR + 6 → hoveredIndex = −1     // +6 pour couvrir l'extrusion
ang = atan2(dy, dx) + π/2 ; si ang < 0 : ang += 2π            // origine à 12 h
acc = 0
pour chaque secteur avec kcal > 0 :
    sweep = kcal / kcalAtwater × 2π
    si acc <= ang < acc + sweep → hoveredIndex = i ; stop
    acc += sweep
```

Curseur : `PointingHandCursor` si `kcalAtwater > 0`, sinon flèche. `onExited` → `hoveredIndex = −1`.

Repeinture déclenchée par : changement de chaque macro, changement de `hoveredIndex`, changement de
taille, et **changement de `Theme.darkMode`** (le Canvas ne se relie pas automatiquement).

> La légende sous le donut a été **volontairement supprimée** (« le tableau nutritionnel à gauche
> affiche déjà toutes les valeurs »).

---

### 4.6 `MealSlot.qml` — cellule de calendrier + cible de glisser-déposer

| Propriété | Défaut |
|---|---|
| `dayOfWeek` | `0` |
| `slot` | `"morning"` |
| `entriesModel` | `null` (`QAbstractListModel` = `calendarVM.entries`) |

| Signal | Charge utile |
|---|---|
| `addRequested(int dayOfWeek, string slot)` | clic n'importe où sur la cellule |
| `entryRemoved(int entryId)` | clic sur la croix d'une entrée |
| `ingredientDropped(int dayOfWeek, string slot, int ingredientId, real quantityG)` | dépôt d'une chip |

**Hauteur dynamique** (constantes internes : `_minHeight: 140`, `_entryHeight: 28`,
`_entrySpacing: 4`, `_addButtonHeight: 22`) :

```js
entries = visibleEntryCount × 28 + max(0, visibleEntryCount − 1) × 4
gap     = visibleEntryCount > 0 ? spaceSm : 0
content = spaceSm × 2 + entries + gap + 22
implicitHeight = max(140, content)
```

`visibleEntryCount` est **recalculé impérativement** en parcourant le modèle Qt :

```js
_recomputeVisibleCount():
    si !entriesModel → 0
    dayRole  = entriesModel.Roles ? entriesModel.Roles.dayOfWeek : −1
    slotRole = entriesModel.Roles ? entriesModel.Roles.slot      : −1
    si dayRole < 0 || slotRole < 0 → 0
    compte les lignes où data(idx, dayRole) === dayOfWeek && data(idx, slotRole) === slot
```

Recalculé sur `modelReset`, `rowsInserted`, `rowsRemoved`, `dataChanged`, à
`Component.onCompleted`, et sur changement de `entriesModel`, `dayOfWeek` ou `slot`.
→ **En web** : un simple `entries.filter(e => e.dayOfWeek === d && e.slot === s)` réactif suffit.

**États visuels** (transitions `ColorAnimation` de `durationFast` sur `color` et `border.color`) :

| État | Fond | Bordure |
|---|---|---|
| survol de dépôt (`containsDrag`) | `colorPrimary` à 18 % | 2 px `colorPrimary` |
| survol souris | `colorSurfaceHover` | 1 px `colorBorderHover` |
| repos | `colorSurface` | 1 px `colorBorder` |

Rayon `sm`.

**Zone de dépôt** :

```js
onDropped(drop):
    source = drop.source
    si source && source.ingredientId !== undefined :
        qty = (source.pieceWeightG > 0) ? source.pieceWeightG : 100.0   // défaut 100 g
        émet ingredientDropped(dayOfWeek, slot, source.ingredientId, qty)
        drop.accept(Qt.CopyAction)
```

**Entrées affichées** : `Repeater` sur le modèle complet avec
`visible: model.dayOfWeek === dayOfWeek && model.slot === slot` et
`Layout.preferredHeight: visible ? 28 : 0` (donc **toutes** les entrées sont instanciées dans
**chaque** cellule — 35 cellules × N entrées ; coûteux, à ne pas reproduire en web).
Style : rayon `sm`, fond `colorPrimary` à 10 % (ou `colorSurfacePressed` au survol), `z: 2`.
Contenu : `model.description` (`fontSizeSm`, élidé) + « ✕ » (22 px de large, `colorTextSecondary` à
65 %, `colorError` au survol, zone de clic élargie de 3 px) → `entryRemoved(model.entryId)`.

**Bouton d'ajout** : texte **« + Ajouter »** centré en bas, toujours visible.
Au repos : `colorTextSecondary` à 55 %, poids regular. Au survol de la cellule : `colorPrimary`,
poids semi-bold. Toute la surface libre est cliquable (`MouseArea` de fond,
`cursorShape: PointingHandCursor`). La `MouseArea` de survol d'une entrée laisse passer les clics
(`propagateComposedEvents: true`, `mouse.accepted = false`).

---

### 4.7 `DraggableIngredientChip.qml` — chip de glisser-déposer

| Propriété | Défaut |
|---|---|
| `ingredientId` | `-1` |
| `ingredientName` | `""` |
| `sourceTag` | `"manual"` (`ciqual` / `openfoodfacts` / `manual`) |
| `pieceWeightG` | `0` |

Signal `clicked`. `implicitHeight: 28`.

**Architecture du glisser (bug corrigé, à reproduire)** : la chip elle-même **ne bouge jamais**.
Un « fantôme » interne (`Item` séparé, `z: 1000`, `Drag.dragType: Drag.Internal`,
`Drag.hotSpot` au centre) est la cible du glisser. Motif du correctif documenté : avec
`drag.target: chip`, au relâchement `chip.x = chip.y = 0` était bien envoyé mais le `Flow` parent ne
recalculait pas sa disposition — la chip se figeait à une position aléatoire et chevauchait ses
voisines.

Le fantôme **duplique** les propriétés de données (`ingredientId`, `ingredientName`,
`pieceWeightG`, `sourceTag`) pour que la cible puisse lire `drop.source.*`.

Séquence :

```js
onPressed:  cursorShape = ClosedHandCursor ; ghost.x = ghost.y = 0 ; ghost.Drag.active = true
onReleased: cursorShape = OpenHandCursor ; ghost.Drag.drop() ; ghost.Drag.active = false
            ghost.visible = false ; ghost.x = ghost.y = 0
onClicked:  émet clicked()
```

`drag.threshold: 6` px. Curseur au repos : `OpenHandCursor`.

**Apparence de la chip** : rayon `full`, largeur `contenu + spaceMd × 2`, hauteur 28.
Fond : `colorPrimary` à 18 % pendant le glisser, `colorSurfaceHover` au survol, `colorSurface` sinon.
Bordure : `colorPrimary` pendant le glisser, `colorBorder` sinon. Transitions `durationFast`.
Contenu : pastille 6×6 (rayon 3) de la couleur de source (§2.6) + nom (`fontSizeSm` medium, élidé,
largeur max **160 px**) + « ● 1pc » (`fontSizeXs`, `colorTextSecondary`) si `pieceWeightG > 0`.

**Apparence du fantôme** : rayon `full`, fond `colorPrimary` à 92 % d'alpha, bordure `colorPrimary`,
texte blanc semi-bold centré `"🛒  " + ingredientName`.

---

### 4.8 `DatePickerPopup.qml` — mini-calendrier contextuel

**Aucune dépendance externe** (« Qt.labs.calendar pas disponible dans cette build PySide6 ») ;
toute la logique de date passe par `Date` JS, **sans fuseau horaire — on travaille en jours**.

| API | Description |
|---|---|
| `selectedIso: string` | `"AAAA-MM-JJ"` mis en surbrillance |
| `dateSelected(string iso)` | émis au clic sur une cellule et au clic sur « Aujourd'hui » |
| `openAt(anchorItem, iso)` | ouvre sous l'ancre et initialise la sélection |

Largeur **280 px**, `padding: 0`, non modal, `focus: true`,
`closePolicy: CloseOnEscape | CloseOnPressOutsideParent | CloseOnReleaseOutsideParent`.
Fond `colorSurface`, rayon `md`, bordure `colorBorder` + halo interne
`colorText` à 5 %. Entrée : opacité 0 → 1 et scale 0.96 → 1.0 sur `durationFast`.

**`openAt(anchorItem, iso)`** :

```js
parsed = _parseIso(iso) || new Date()          // repli sur aujourd'hui si vide/invalide
selectedIso = _formatIso(parsed)
_viewYear = parsed.getFullYear() ; _viewMonth = parsed.getMonth()   // mois 0-indexé
_rebuildGrid()
win = anchorItem.Window.window
si win :
    pt = anchorItem.mapToItem(win.contentItem, 0, anchorItem.height + 4)
    parent = win.contentItem
    x = clamp(pt.x, 8, win.contentItem.width  − width  − 8)
    y = clamp(pt.y, 8, win.contentItem.height − height − 8)
open()
```

**Parsing / formatage** :

```js
_parseIso(iso): si !iso ou longueur < 10 → null
                regex ^(\d{4})-(\d{2})-(\d{2})  → new Date(y, m-1, d) ; null si NaN
_formatIso(d):  y + "-" + pad2(m+1) + "-" + pad2(day)
```

**Construction de la grille (42 cellules, 6 × 7, semaine commençant le LUNDI)** :

```js
firstOfMonth = new Date(_viewYear, _viewMonth, 1)
jsDay     = firstOfMonth.getDay()      // 0 = dimanche … 6 = samedi
isoOffset = (jsDay + 6) % 7            // 0 = lundi … 6 = dimanche
startDate = new Date(_viewYear, _viewMonth, 1 − isoOffset)
pour i de 0 à 41 :
    d = startDate + i jours
    cellule = { iso: _formatIso(d), day: d.getDate(),
                inMonth: d.getMonth() === _viewMonth && d.getFullYear() === _viewYear,
                isToday: même année/mois/jour que new Date() }
```

`_shiftMonth(delta)` : normalise `m` dans `[0, 11]` en ajustant `y`, puis reconstruit la grille.

**Mise en page** :
- En-tête 36 px : « ‹ » (36 px, `colorPrimary` au survol) — nom du mois **capitalisé** via
  `Qt.locale().standaloneMonthName(_viewMonth, Locale.LongFormat)` + « » + année
  (`fontSizeMd` semi-bold) — « › » (36 px).
- Séparateur 1 px.
- Bandeau des jours (24 px) : 7 cellules, texte
  `Qt.locale().standaloneDayName((index + 1) % 7, Locale.NarrowFormat).toUpperCase()`
  → en français **L M M J V S D**.
- Grille : 7 colonnes × 6 rangées, cellules de `grid.width / 7` × **32 px**, rayon `sm`.
  - Sélectionnée : fond `colorPrimary`, texte `colorOnPrimary`, semi-bold.
  - Aujourd'hui (non sélectionné) : bordure **1.5 px** `colorPrimary`, texte `colorPrimary`,
    semi-bold.
  - Hors du mois affiché : texte `colorTextDisabled`.
  - Survol : fond `colorSurfaceHover`.
  Clic → `selectedIso = iso` ; émet `dateSelected(iso)` ; ferme.
- Séparateur 1 px.
- Pied 36 px, deux moitiés séparées par un trait vertical :
  **« Aujourd'hui »** (saute à la date système, met à jour la vue, émet `dateSelected`, ferme) et
  **« Fermer »**. Texte `fontSizeSm` medium, `colorPrimary` au survol.

**Clavier** : `PageUp` → mois précédent, `PageDown` → mois suivant (accepte l'événement).

---

### 4.9 `UndoToast.qml` — annulation d'action destructrice

| Propriété | Défaut |
|---|---|
| `timeoutMs` | `5000` |
| `label` | `""` |

Signal `undoClicked`. Fonctions `show(text)` (affecte le libellé, rend visible, redémarre le timer)
et `hide()` (arrête le timer, masque).

Positionnement : ancré en bas du parent, centré horizontalement, marge `spaceXl`, `z: 100`.
Dimensions : `contenu + spaceXl × 2` en largeur, `contenu + spaceMd × 2` en hauteur.
Style : fond `#1f2937` en clair / `colorSurface` en sombre, bordure `rgba(255,255,255,0.10)`,
rayon `md`, opacité **0.96** (animée sur `durationFast`).
Contenu : libellé blanc `fontSizeMd` + bouton **« Annuler »** (rectangle 28 px de haut, rayon `sm`,
fond `rgba(255,255,255,0.10)` → `0.20` au survol, texte blanc `fontSizeSm` semi-bold).
Au clic : émet `undoClicked()` puis `hide()`.

Usage type (IngredientsPage) : le VM émet `deletion_pending_undo(label)` → `undoToast.show(label)` ;
le clic appelle `vm.undoLastDelete()`.

---

### 4.10 `AppConfirmDialog.qml` — confirmation à deux modes

Basé sur `AppDialog` (modal, largeur **480 px**, `closePolicy: CloseOnEscape`).

| Propriété | Défaut |
|---|---|
| `mode` | `"save"` (ou `"destroy"`) |
| `message` | `""` |
| `saveLabel` | `"Enregistrer"` |
| `discardLabel` | `"Abandonner"` |
| `confirmLabel` | `"Supprimer"` |
| `cancelLabel` | `"Annuler"` |
| `payload` | `({})` — contexte arbitraire mémorisé entre l'ouverture et l'émission |

Signaux : `cancelled()`, `saveRequested()`, `discarded()`, `confirmed()`.
Fonction `openWith(p)` : `payload = p || {}` puis `open()`.

**Mode `"save"`** (3 boutons) : `[Annuler (secondary)] … [Abandonner (danger)] [Enregistrer (primary)]`.
**Mode `"destroy"`** (2 boutons) : `[Annuler (secondary)] … [Supprimer (danger)]`.

Chaque bouton émet son signal **puis** ferme. **Échap ferme sans émettre aucun signal** — l'appelant
doit donc considérer « fermé sans signal » comme équivalent à « annulé ».

Le corps est un simple texte `fontSizeMd` `colorText` en `WordWrap`.

Exemples réels d'utilisation :
- RecipesPage : `mode: "save"`, titre « Modifications non sauvées », message « La recette en cours
  d'édition a des modifications non sauvegardées. Veux-tu les enregistrer avant de continuer ? »
- PantryPage : `mode: "destroy"`, titre « Retirer du stock », `confirmLabel: "Retirer"`,
  `onConfirmed` lit `payload.stockId` puis `pantryVM.deleteStock(stockId)` et
  `shoppingVM.refreshList()`.

---

### 4.11 `AppSpinBox.qml` — spinbox décimal

Le `SpinBox` de Qt Quick ne gère que des entiers : ce composant expose un `realValue` fractionnaire
via un facteur d'échelle.

| Propriété | Défaut |
|---|---|
| `realValue` | `0.0` |
| `realFrom` | `0.0` |
| `realTo` | `1000000.0` |
| `realStep` | `1.0` |
| `decimals` | `1` |
| `emptyOnZero` | `false` |

```js
_factor  = 10^decimals
from     = round(realFrom × _factor)
to       = round(realTo   × _factor)
stepSize = round(realStep × _factor)
value    = round(realValue × _factor)

onValueChanged:      v = value / _factor ; si |v − realValue| > 1e-9 → realValue = v
onRealValueChanged:  target = round(realValue × _factor) ; si value !== target → value = target
```

**Formatage** : `textFromValue(v, locale)` renvoie **la chaîne vide** si `emptyOnZero && v === 0`,
sinon `Number(v / _factor).toLocaleString(locale, 'f', decimals)`.
**Parsing** : `valueFromText(t, locale)` renvoie `0` si `emptyOnZero && t.trim() === ""`, sinon
`round(Number.fromLocaleString(locale, t) × _factor)`.

Validateur : `DoubleValidator` avec `bottom: realFrom`, `top: realTo`, `decimals`,
`StandardNotation`, **`locale: "fr_FR"`** (donc la virgule est acceptée comme séparateur décimal).

Champ éditable, texte **centré horizontalement**, `inputMethodHints:
Qt.ImhFormattedNumbersOnly | Qt.ImhDigitsOnly`, sélection à la souris.
Boutons « + » (haut) et « − » (bas) : rectangles de 24 px de large, moitié de la hauteur chacun,
collés au bord droit, `radius: 0`, texte `colorTextSecondary` semi-bold, fond
`colorSurfacePressed` / `colorSurfaceHover` / transparent.
Fond du contrôle : rayon `md`, hauteur `controlHeightMd` (36), largeur implicite 120, bordure
`colorBorderFocus` au focus / `colorBorderHover` au survol / `colorBorder` sinon
(transition `durationFast`) ; fond `colorSurfaceHover` si désactivé.

> **`emptyOnZero` est le mécanisme qui distingue « non renseigné » de « 0 »** (équivalent
> `QSpinBox.setSpecialValueText("")`). À porter par un `<input>` dont la valeur vide se sérialise en
> `null`.

---

### 4.12 Autres composants à logique

#### `AppSpinner.qml`

Arc rotatif de **270°** (`Math.PI × 1.5`) en `colorPrimary`, `lineCap: "round"`, au-dessus d'un
anneau complet `colorBorder` à 40 % d'alpha.
Propriétés : `running` (bool), `size` (48 par défaut), `arcThickness` (4),
`trackColor`, `arcColor`. `visible: running`.
Rayon de tracé : `min(w, h)/2 − arcThickness/2 − 1` (abandon si `<= 0`).
Animation : `angleStart` de `0` à `2π`, **durée 1000 ms**, boucle infinie, active si `running`.
Repeinture sur changement de `darkMode`, `arcColor`, `trackColor`.
→ **CSS** : `@keyframes spin { to { transform: rotate(360deg) } }` + `animation: spin 1s linear infinite`.

#### `RecipeTagsChips.qml`

`ColumnLayout` : label **« Tags : »** (`fontSizeMd` medium) puis un `Flow` de puces
(espacement `spaceXs`).
Entrées (poussées par le parent, aucun `Connections` interne — « pour rester stateless et
testable ») : `allTags: [{ id, name, colorHex }]` et `currentTags: [{ id, name, colorHex }]`.
Une puce est « attachée » si `currentTags.some(t => t.id === modelData.id)`.
Style : rayon `full`, hauteur **26 px**, largeur `texte + spaceMd × 2`, texte `fontSizeSm` semi-bold.
- attachée : fond = `colorHex` plein, bordure = `colorHex`, texte **blanc** ;
- détachée : fond = `colorHex` à 15 %, bordure = `colorHex` à 40 %, texte = `colorHex`.
Transitions `durationFast`. Clic → `recipeEditorVM.toggleTag(modelData.id)` (appel direct au VM
depuis le composant).

#### `NutrientLabel.qml`

`Item` avec `RowLayout` **ancré à droite** : `[libellé] [icône]` (dans cet ordre, pas de « : » —
l'icône fait office de séparateur). Espacement 8 px.
Propriétés : `type` (les 8 valeurs de §2.7), `text` (alias), `subline` (bool), `iconSize` (24).
`implicitWidth = max(140, iconSize + largeurTexte + spacing × 2 + 8)`.
Style de sous-ligne : `colorTextSecondary` à 85 % + italique (identique à `NutritionPanel`).

#### `RecipePhotoBlock.qml`

`RowLayout` : zone photo **300×200** + colonne de boutons.
Propriétés : `photoUrl` (string, `file://` ou vide), `selectedId` (int : `-1` = rien,
`-2` = nouvelle recette non sauvée, `> 0` = persistée). Signal `photoSaved()`.

Zone photo (rayon `md`, `clip: true`, bordure 2 px `colorPrimary` pendant un survol de dépôt) :
`Image` en `PreserveAspectCrop`, `asynchronous: true`, `cache: false`.
Placeholder (visible si `photoUrl === ""` ou `status === Image.Error`) :
- pictogramme « 📥 » pendant un survol de dépôt, « 🍽 » sinon (48 px, `colorTextDisabled`) ;
- texte : « Déposer ici » (survol de dépôt) / « Photo introuvable » (fichier disparu du disque) /
  « Enregistre la recette d'abord » (`selectedId === -2`) / « Aucune photo » ;
- mention « (ou glisse une image ici) » (italique, `fontSizeXs`, opacité 0.7) si aucune photo et
  `selectedId > 0`.
Halo `colorPrimary` à 10 % pendant le survol de dépôt.

`DropArea` — **désactivée si `selectedId <= 0`** (« besoin d'un id stable pour nommer le fichier
photo sur disque »), `keys: ["text/uri-list", "text/plain"]`. Priorité aux URLs
(`drop.urls[0]`), repli sur `drop.text.trim()` (« certains navigateurs envoient l'URL en
text/plain »).

Routage `_handleDroppedUrl(url)` (comparaison en minuscules) :
- `file://…`   → `recipeEditorVM.setPhotoFromUrl(url)`
- `http://…` / `https://…` → `recipeEditorVM.setPhotoFromHttpUrl(url)`
- autre (`data:`, `ftp:`…) → **rien**, silencieusement.
Si l'appel renvoie vrai, émet `photoSaved()`.

Boutons : « + Ajouter une photo » / « Modifier la photo » (secondary, activé si `selectedId > 0`)
→ ouvre un `FileDialog` natif titré « Choisir une photo de recette », filtre
`["Images (*.png *.jpg *.jpeg *.webp *.gif *.bmp)"]` ; et « Retirer la photo » (danger, visible si
une photo est présente) → `recipeEditorVM.removePhoto()`.
Note si `selectedId === -2` : « Sauvegarde d'abord la recette pour pouvoir y attacher une photo. »

---

## 5. Composants de chrome (styling pur)

Ces composants n'apportent pas de logique métier ; ils sont à recréer comme des classes CSS /
composants de base.

### `AppButton.qml`

`implicitHeight: controlHeightMd` (36), `implicitWidth: max(80, contenu + spaceLg × 2)`,
padding horizontal `spaceLg` (16), rayon `md`, texte `fontSizeMd` medium centré et élidé,
transitions `durationFast` easing `OutCubic`.

| `variant` | Fond (repos / survol / pressé) | Bordure | Texte |
|---|---|---|---|
| `"primary"` | `colorPrimary` / `colorPrimaryHover` / `colorPrimaryPressed` | aucune | `colorOnPrimary` |
| `"secondary"` | `colorSurface` / `colorSurfaceHover` / `colorSurfacePressed` | 1 px `colorBorder` → `colorBorderHover` au survol | `colorPrimary` |
| `"ghost"` | transparent / `colorSurfaceHover` / `colorSurfacePressed` | aucune | `colorPrimary` |
| `"danger"` | transparent / `colorError` à 10 % / `colorError` à 20 % | aucune | `colorError` |
| `"success"` | `colorSuccess` / `lighter(×1.08)` / `darker(×1.15)` | aucune | `colorOnPrimary` |

Désactivé : texte `colorTextDisabled` ; fond `colorPrimaryDisabled` pour `primary` et `success`,
transparent sinon ; bordure `colorBorder`.
**Anneau de focus clavier** : rectangle à `margins: -3`, `radius + 3`, bordure 2 px
`colorBorderFocus`, opacité **0.4**, visible si `activeFocus && !pressed`.

> `"success"` est documenté comme un état temporaire (« ✓ Enregistré » pendant ~1,5 s après une
> action réussie, puis retour à `primary` »).

### `AppTextField.qml`

`implicitWidth: 200`, `implicitHeight: controlHeightMd` (36), padding horizontal `spaceMd`,
rayon `md`, `fontSizeMd` regular, sélection à la souris.
Couleurs : texte `colorText` (`colorTextDisabled` si désactivé), placeholder
`colorTextPlaceholder`, sélection `colorPrimary` à 35 %, texte sélectionné `colorText`.
Bordure : `colorBorderFocus` au focus / `colorBorderHover` au survol / `colorBorder`
(transition `durationFast`). Fond `colorSurface`, `colorSurfaceHover` si désactivé.
**Halo de focus** : rectangle à `margins: -3`, `radius + 3`, bordure 2 px `colorBorderFocus`,
opacité **0.18**.

### `AppComboBox.qml`

Hauteur 36, largeur 140, `leftPadding: spaceMd`, `rightPadding: spaceXl + spaceMd` (36),
rayon `md`, mêmes règles de bordure que `AppTextField` (avec en plus focus si `popup.opened`).
**Flèche** : triangle plein dessiné au Canvas, 10×6 px, à `spaceMd` du bord droit, centré
verticalement, `colorTextSecondary` (`colorTextDisabled` si désactivé). Repeinture sur changement de
`pressed` et de `darkMode`.
**Délégué** (hauteur 32) : gère **3 formes de modèle** — tableau de chaînes JS (`modelData`),
`ListModel` multi-rôles (`model[textRole]`), objets JS avec `textRole` (`modelData[textRole]`).
Résolution :

```js
si textRole non vide :
    si model[textRole] !== undefined      → String(model[textRole])
    si modelData[textRole] !== undefined  → String(modelData[textRole])
sinon                                      → String(modelData) ou ""
```

Fond du délégué : `colorSurfaceHover` au survol, `colorPrimary` à 10 % si c'est l'élément courant,
transparent sinon.
**Popup** : `y = height + 4`, largeur = celle du contrôle, hauteur `min(contenu + 2, 320)`,
padding 1, ombre subtile 2 couches (§2.2), animation d'entrée opacité 0 → 1 et
`y` de `height − 4` → `height + 4` sur `durationFast`.

### `AppCheckBox.qml`

Indicateur 18×18, rayon `sm`, bordure **1.5 px**. Coché : fond + bordure `colorPrimary` ;
sinon fond `colorSurface`, bordure `colorBorderHover` au survol / `colorBorder`.
**Coche dessinée au Canvas** : `strokeStyle: colorOnPrimary`, `lineWidth: 2`, `lineCap`/`lineJoin`
`"round"`, tracé `(0.20w, 0.55h) → (0.42w, 0.78h) → (0.82w, 0.25h)`, marges 3 px.
Animation : opacité 0 → 1 et scale 0.6 → 1.0 sur `durationFast` easing `OutQuad`.
Espacement libellé `spaceSm`, texte `fontSizeMd`.

### `AppListItem.qml`

`ItemDelegate` de hauteur implicite **40 px**, padding `spaceMd` horizontal / `spaceSm` vertical,
rayon `sm`.
Fond : `colorPrimary` à 12 % si `selected`, `colorSurfacePressed` si pressé, `colorSurfaceHover` au
survol, transparent sinon (transition `durationFast`).
**Indicateur de sélection** : barre verticale de **3 px** (rayon 1.5) `colorPrimary` collée à gauche,
avec 4 px de marge haute et basse.
Le contenu est fourni par la propriété par défaut `content`.

### `AppTabButton.qml`

Hauteur 40, largeur `max(120, contenu + spaceLg × 2)`, padding horizontal `spaceLg`.
Texte : `colorPrimary` semi-bold si coché ; `colorText` au survol ; `colorTextSecondary` sinon ;
`colorTextDisabled` si désactivé. `fontSizeMd`, transition `durationFast`.
Fond : `colorPrimary` à 6 % si coché ; `colorPrimary` à 20 % pendant un survol de dépôt ;
`colorSurfaceHover` au survol ; transparent sinon. `radius: 0`.
Indicateurs : barre **2 px** `colorPrimary` en bas si coché ; barre 2 px `colorPrimary` en haut
pendant un survol de dépôt (si non coché).

**`DropArea` magnétique** : après **300 ms** de survol pendant un glisser, l'onglet
s'auto-sélectionne (`root.parent.currentIndex = root.tabIndex`, façon macOS Mission Control).
Le timer est annulé si le glisser sort de la zone. **Il n'y a pas de `onDropped`** — le dépôt final
est géré par la page cible.

### `AppDialog.qml`

`Dialog` modal centré, padding `spaceXl` (24), fond `colorSurface` rayon `lg`, bordure `colorBorder`,
ombre élevée à 3 couches (§2.2).
Overlay : `colorOverlay`, transition d'opacité `durationNormal`.
Entrée : opacité 0 → 1 et scale 0.94 → 1.0 sur `durationNormal` easing `OutQuad`.
Sortie : opacité 1 → 0 et scale 1.0 → 0.96 sur `durationFast` easing `InQuad`.
En-tête (visible si `title !== ""`) : texte `fontSizeXl` semi-bold, marges `spaceXl` horizontales
et `spaceLg` en haut, hauteur `contenu + spaceXl`.

### `AppPopup.qml`

Padding `spaceXs`, `closePolicy: CloseOnEscape | CloseOnPressOutsideParent`,
fond `colorSurface` rayon `md` + bordure, ombre normale 2 couches (§2.2).
Entrée : opacité 0 → 1 et `y` de `y − 4` → `y` sur `durationFast` easing `OutQuad`.
Sortie : opacité 1 → 0 sur `durationFast` easing `InQuad`.

### `AppMenu.qml`

Items de **34 px**, padding horizontal `spaceMd`, texte en **RichText** via
`Theme.formatMnemonic(item.text)`.
Texte : `colorPrimary` medium si surligné, `colorText` regular sinon, `colorTextDisabled` si
désactivé. Fond de l'item : `colorSurfaceHover` si surligné, transparent sinon.
Fond du menu : largeur implicite 220, rayon `md`, `colorSurface` + bordure, ombre normale 2 couches.

### `AppScrollBar.qml`

Largeur/hauteur implicite 10, `minimumSize: 0.08`, padding 2, `policy: AsNeeded`, fond transparent.
Poignée : 6 px, rayon 4, `colorTextSecondary` à **20 %** au repos, **45 %** au survol ou quand la
barre est active, **65 %** quand pressée (transition `durationFast`).

---

## 6. Points de portage délicats (desktop → web)

| # | Élément desktop | Fichier(s) | Équivalent web proposé |
|---|---|---|---|
| 1 | **`Window` détachables non modales** (13 dialogues) : déplaçables hors de l'app, redimensionnables, plusieurs ouvertes en parallèle | tous les dialogues | Modales `<dialog>` empilées ou panneaux latéraux. En mobile-first, plein écran avec pile de navigation. Le multi-fenêtrage n'a pas d'équivalent utile — assumer sa perte. `CategoryPickerDialog` (`ApplicationModal`) et le `linePicker` (`WindowModal`) deviennent des modales imbriquées |
| 2 | **`FileDialog` natif** — 3 occurrences : ticket PDF (`ReceiptImportDialog`), photo de recette (`RecipePhotoBlock`) | `ReceiptImportDialog`, `RecipePhotoBlock` | `<input type="file" accept="application/pdf">` / `accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"`. Sur mobile, ajouter `capture="environment"` pour photographier le ticket |
| 3 | **`loadFromPath(file://…)`** : le VM lit le fichier sur le disque | `ReceiptImportDialog` | Le fichier doit être **téléversé** au Worker (`multipart/form-data` ou `ArrayBuffer`) qui fait le parsing PDF côté serveur. Le chemin disque n'existe plus |
| 4 | **Surveillance de dossier** (`receiptImportVM.pendingFileCount`, `loadNextPending()`) — un watcher détecte les PDF déposés dans un dossier | `Main.qml` (badge status bar) | Aucun équivalent web. Options : (a) supprimer la fonctionnalité ; (b) « boîte de réception » côté serveur alimentée par téléversement, e-mail ou Cloudflare R2, avec la même sémantique « N tickets en attente » |
| 5 | **`keyring` / Windows Credential Manager** pour le refresh token Lidl Plus | `LidlPlusSetupDialog` | Stocker le token **chiffré côté serveur** (D1 + clé dans les secrets du Worker), jamais dans `localStorage`. Les voyants « lib installée » / « keyring disponible » n'ont plus de sens — les remplacer par « proxy Lidl configuré » |
| 6 | **Polling Lidl en arrière-plan** (`pollIntervalMinutes`, 5–1440 min, thread Python) | `LidlPlusSetupDialog` | Cloudflare **Cron Trigger** sur le Worker. L'intervalle en minutes devient un cron ; le champ UI doit alors se limiter aux valeurs supportées |
| 7 | **Appels HTTP synchrones bloquants** vers OpenFoodFacts (`fetchOnlineAndList`, `lookupBarcodeAsDict`, `searchBySource`) enveloppés dans `Qt.callLater` | `ImportIngredientDialog`, `ReceiptImportDialog`, `IngredientSearchPopup` | `async/await` + état de chargement réel. **Supprimer** les astuces `Qt.callLater` et les drapeaux `offSearchBusy` manuels ; garder les libellés « ⏳ Recherche… » |
| 8 | **Glisser-déposer Qt** (`Drag.dragType: Drag.Internal`, `drop.source.<prop>`) | `DraggableIngredientChip`, `MealSlot`, `AppTabButton` | HTML5 DnD (`dataTransfer.setData('application/json', …)`) ou une lib pointer-events. **Le contournement du « fantôme » devient inutile** : en CSS, l'élément source ne bouge pas naturellement. Sur mobile, prévoir un chemin alternatif (appui long → menu) car le DnD tactile est fragile |
| 9 | **Glisser-déposer de fichiers/URL externes** sur la zone photo (`text/uri-list` + repli `text/plain`) | `RecipePhotoBlock` | `dragover`/`drop` sur un `<div>`, lecture de `e.dataTransfer.files` puis de `e.dataTransfer.getData('text/uri-list' \|\| 'text/plain')`. Le téléchargement d'une URL http(s) distante doit passer par le Worker (CORS) |
| 10 | **`Qt.openUrlExternally("file:///" + dir)`** (ouvrir le dossier de sauvegardes / de logs) | `RestoreBackupDialog`, `Main.qml` | Impossible en web. Remplacer par un téléchargement du fichier de sauvegarde, ou supprimer |
| 11 | **`RestoreBackupDialog` entier** : sauvegardes locales du fichier SQLite + message « relance l'application » | `RestoreBackupDialog` | Sans objet sur D1. Remplacer par des exports/imports JSON, ou par les *Time Travel* de D1 côté administration |
| 12 | **Canvas 2D impératif** (donut, courbe de prix, coche, flèche de combobox, spinner) avec repeinture manuelle sur `darkMode` | `MacrosChart`, `PriceHistoryDialog`, `AppCheckBox`, `AppComboBox`, `AppSpinner` | SVG déclaratif (le donut et la courbe se font très bien en `<path>`), ou `<canvas>` + `matchMedia('(prefers-color-scheme: dark)')`. La coche et la flèche deviennent de simples SVG statiques |
| 13 | **Infobulles Qt** (`ToolTip.visible: hovered`, `ToolTip.delay: 300/400/600`) | partout | `title` HTML (pas de contrôle du délai) ou un composant d'infobulle avec `transition-delay` équivalent. Sur mobile, préférer des libellés visibles |
| 14 | **`Number.fromLocaleString` / `toLocaleString(Qt.locale(), 'f', n)`** — la locale française impose la **virgule décimale** | `AppSpinBox`, `NutritionPanel`, `PriceHistoryDialog`, `ReceiptImportDialog` | `Intl.NumberFormat('fr-FR', { minimumFractionDigits: n, maximumFractionDigits: n })` pour l'affichage, et un parseur tolérant `,`/`.` pour la saisie. **Ne pas envoyer de nombres localisés à l'API** |
| 15 | **`Qt.locale().standaloneMonthName` / `standaloneDayName`** | `DatePickerPopup` | `Intl.DateTimeFormat('fr-FR', { month: 'long' })` et un tableau `["L","M","M","J","V","S","D"]`. Envisager surtout `<input type="date">` natif, qui gère déjà locale, clavier et mobile |
| 16 | **Raccourcis `Shortcut` Qt** (Ctrl+1..5, Ctrl+K, Ctrl+/, Ctrl+N/S/F/T, Ctrl+←/→, Ctrl+Shift+D, Suppr) | `Main.qml`, pages | `keydown` global avec garde `e.target` (ne pas capturer dans un champ de saisie). Attention aux collisions navigateur : **Ctrl+N**, **Ctrl+S**, **Ctrl+T**, **Ctrl+F**, **Ctrl+1..5** sont réservés par la plupart des navigateurs — prévoir des alternatives (Alt+…, ou `preventDefault` assumé) |
| 17 | **`transientParent`** — nécessaire sous Windows pour que la sous-fenêtre reste devant | `ReceiptImportDialog.linePicker` | Sans objet ; `z-index` / ordre d'empilement des `<dialog>` |
| 18 | **`window.navigateToIngredient(id)`** appelée depuis un dialogue via `Window.window.transientParent` | `RecipeMatchDialog` | Routeur / store global. Le chemin d'accès actuel est fragile (cf. §7) |
| 19 | **Parcours impératif de `QAbstractListModel`** (`rowCount()`, `index(i,0)`, `data(idx, Roles.x)`) | `MealSlot`, `AddCalendarEntryDialog` | Tableaux JS réactifs. **Attention** : `MealSlot` instancie toutes les entrées de la semaine dans chacune des 35 cellules — filtrer côté données en web |
| 20 | **Icônes PNG bitmap** `icons/nutrient/<type>.png` chargées avec `sourceSize ×2` | `NutrientLabel`, `NutritionPanel` | SVG (ou sprite SVG). 8 icônes à produire |
| 21 | **Dimensions fixes en pixels** (largeurs de colonnes 220/250/100/140/150/54, fenêtres 1300×760…) | tous les tableaux | Grilles CSS avec `minmax()` ; sur mobile, replier chaque ligne de tableau en carte empilée. Le tableau du ticket (1300 px de large) est le cas le plus critique |
| 22 | **`DialogButtonBox.Ok | Cancel`** → libellés fournis par Qt, non traduits par l'app | `ImportRecipeUrlDialog` (création manuelle), `RestoreBackupDialog` (confirmation) | Fixer explicitement « Annuler » / « Valider » en français |
| 23 | **`echoMode: TextInput.Password`** | `LidlPlusSetupDialog` | `<input type="password" autocomplete="off">` |
| 24 | **`AppSpinner` + appel bloquant** : l'animation ne tourne pas pendant le gel du thread | `IngredientSearchPopup` | Résolu de fait par `async/await` |

---

## 7. Ambiguïtés et incohérences relevées dans le code

Ces points sont signalés **tels qu'observés** ; ils demandent un arbitrage produit avant portage.

1. **`ImportIngredientDialog` — chargement différé jamais implémenté.**
   `CatalogTabRich.Component.onCompleted` est gardé par `if (typeof ingredientVM !== "undefined" && ingredientVM)`.
   Le commentaire annonce « il sera trigger au premier focus de l'onglet », mais **aucun handler
   `onVisibleChanged` / `onCurrentIndexChanged` n'existe**. Si le VM n'est pas résolu au chargement,
   la liste de catégories et la première recherche ne se font jamais.

2. **`ReceiptImportDialog` — date DLC invalide silencieusement ignorée.**
   Si la saisie ne correspond pas à `JJ/MM/AAAA` (ou variantes `-` / `.`), rien n'est envoyé au VM et
   **aucun message n'est affiché** ; le champ conserve un texte que la ligne n'a pas enregistré.
   En web : valider et signaler l'erreur, ou utiliser `<input type="date">`.

3. **`ReceiptImportDialog` — accords de pluriel approximatifs.**
   Le compteur produit `"<matched> / <total> ligne(s) mappée(s)"` où « ligne » s'accorde sur `total`
   et « mappée » sur `matched` : « 1 / 3 lignes mappée », « 3 / 3 lignes mappées ». À corriger.

4. **`RecipeMatchDialog` — navigation probablement morte.**
   Le clic sur une suggestion d'achat fait
   `Window.window.transientParent.navigateToIngredient(...)`, mais ce `Window` **n'assigne jamais
   `transientParent`** (contrairement au `linePicker` de `ReceiptImportDialog` qui le fait
   explicitement). La condition échoue donc probablement toujours et rien ne se passe.

5. **`UnifiedSearchDialog` — navigation clavier sur les en-têtes de section.**
   ↑ / ↓ parcourent la liste **plate**, en-têtes compris. Quand la sélection tombe sur un en-tête,
   Entrée est sans effet (`_activateSelected` sort si `kind === "section_header"`). Il faut sauter
   les en-têtes.

6. **`UnifiedSearchDialog` — promesse non tenue pour les ingrédients.**
   L'en-tête du fichier annonce « kind="ingredient" → payload.id : la page Ingrédients sélectionne la
   ligne », mais le handler de `Main.qml` se contente de `tabBar.currentIndex = 0`. L'`id` n'est pas
   utilisé, alors que `window.navigateToIngredient(id)` existe et ferait exactement cela.

7. **`AddCalendarEntryDialog` — libellés de créneau incomplets.**
   `_slotLabel(s)` ne gère que `morning`, `noon` et « tout le reste → soir ». Les créneaux d'en-cas
   (`snack_morning`, `snack_afternoon`), pourtant présents dans `UnifiedSearchDialog` et dans le
   calendrier (5 créneaux), s'afficheront donc « soir ».

8. **`AddCalendarEntryDialog` — fermeture même sans sélection.**
   `_accept()` appelle `close()` inconditionnellement : si aucune recette n'est sélectionnée
   (liste vide) ou aucun ingrédient choisi, le dialogue se ferme **sans rien ajouter et sans
   message**. Le bouton « Ajouter » n'a pas de condition `enabled`.

9. **`PriceHistoryDialog` — écriture sur une propriété inexistante.**
   `openFor()` fait `qtyField.value = …` alors que `qtyField` est un `AppSpinBox` qui expose
   `realValue`. QML crée alors dynamiquement une propriété `value` sans effet visible.
   `_submitNew()` lit bien `qtyField.realValue`, et le reset après ajout écrit correctement
   `qtyField.realValue`. **Conséquence : à l'ouverture, la quantité par défaut n'est pas
   pré-remplie** (contrairement à l'intention documentée).

10. **`PriceHistoryDialog` — dates en UTC.**
    `new Date().toISOString().slice(0, 10)` : en fin de soirée en France (UTC+1/+2), la date proposée
    est celle de la **veille**. Idem dans `CookingHistoryDialog`. À corriger avec une date locale.

11. **`PriceHistoryDialog` — modèle de liste = un entier.**
    `ListView.model: historyModel.count` puis lecture inverse `historyModel.get(count − 1 − index)`.
    Fonctionnel en QML mais totalement idiomatique-Qt ; en web, trier le tableau.

12. **`PriceHistoryDialog` — champ « Prix (€) » non validé côté UI.**
    Texte libre, transmis brut (`priceField.text`) au VM. Le placeholder suggère « ex : 2,50 » mais
    rien n'empêche « abc ». La condition d'activation ne teste que la longueur.

13. **`CookingHistoryDialog` — désynchronisation possible.**
    `recipeEditorVM.cookingLogAsList()` et `addCookingLog()` **ne prennent pas de `recipeId`** : ils
    opèrent sur la recette chargée dans le VM. Si l'utilisateur change de recette dans l'éditeur
    pendant que ce dialogue non modal est ouvert, `root.recipeId` et le contenu affiché divergent.

14. **Suppressions sans confirmation.**
    Suppression d'une observation de prix (`PriceHistoryDialog`), d'une entrée de journal
    (`CookingHistoryDialog`), d'une ligne de ticket (`ReceiptImportDialog`) et purge des
    credentials Lidl (`LidlPlusSetupDialog`) sont **immédiates**, sans confirmation ni annulation —
    alors que `AppConfirmDialog` et `UndoToast` existent et sont utilisés ailleurs.

15. **`ImportRecipeUrlDialog` — 2e argument de `updateMeta` toujours vide.**
    `_pushMeta()` appelle `recipeUrlImportVM.updateMeta(name, "", portions)`. La signification du 2e
    paramètre (instructions ? description ?) n'est pas déterminable depuis le QML, et **l'UI ne
    permet jamais de le renseigner** — les instructions extraites sont donc éditées ailleurs
    (l'écran de confirmation parle de « finitions » dans l'éditeur de recette).

16. **`ImportRecipeUrlDialog` — échec silencieux de la création manuelle.**
    Si `createManualForLine(...)` renvoie `<= 0`, le sous-dialogue reste ouvert **sans message
    d'erreur** ; le signal `error_emitted` alimente `commitError` qui n'est visible qu'à l'étape 1,
    derrière la modale.

17. **`ImportIngredientDialog` — sélection vidée même en cas d'échec.**
    `_promoteMany` appelle `tab._clearSelection()` **hors** du test `count > 0` : si l'import échoue
    entièrement, l'utilisateur perd sa sélection sans explication.

18. **`SettingsCategoriesDialog` — `categoryVM.delete(...)`.**
    `delete` est un mot-clé JS réservé. Toléré en QML, mais devra être renommé (ou appelé via
    `vm["delete"]`) en TypeScript.

19. **`CategoryPickerDialog` — signature héritée.**
    `openPicker(currentL1, currentL2, parentWindow)` **ignore `currentL2`**, et
    `categorySelected(l1, l2)` émet toujours `""` en 2e argument. Le portage peut simplifier la
    signature à un seul niveau.

20. **`MacrosChart` — total affiché ≠ énergie de la base.**
    Le centre du donut montre `Math.round(kcalAtwater)`, recalculé depuis les macros, et non la
    valeur `kcal` du jeu de données. Pour un aliment CIQUAL dont l'énergie est mesurée, les deux
    peuvent différer sensiblement. Décider quelle valeur fait foi.

21. **`MacrosChart` — lecture par test de véracité.**
    `nutritionData && nutritionData.fats ? nutritionData.fats : 0` : une valeur légitime `0` et une
    valeur absente sont indiscernables (peu gênant ici, mais le motif est repris ailleurs).

22. **`ImportIngredientDialog` — sentinelle `-1` pour « inconnu ».**
    Les macros absentes sont stockées à `-1` et masquées par un test `>= 0`. Une donnée réellement
    négative serait donc masquée. En web, préférer `null` avec un rendu explicite.

23. **`MealSlot` — coût de rendu.**
    Toutes les entrées de la semaine sont instanciées dans chacune des 35 cellules, la plupart avec
    `visible: false` et `height: 0`. Ne pas reproduire.

24. **`UnifiedSearchDialog` — portée de la recherche calendrier.**
    Le commentaire précise « semaine courante uniquement ». Ce n'est pas vérifiable depuis le QML
    (`calendarVM.searchOnce(q, 12)` ne prend pas de semaine). À confirmer côté viewmodel.

25. **`ShortcutsDialog` — table statique à maintenir à la main.**
    Le commentaire l'admet (« Pour ajouter un raccourci, l'enregistrer dans la page concernée ET
    l'ajouter au modèle ci-dessous »). Il y a donc un risque de dérive entre la documentation
    affichée et les raccourcis réellement actifs.

26. **`ReceiptImportDialog` — `console.log` de débogage laissé en production**
    (`linePicker.openFor`, avec `JSON.stringify` des suggestions).

27. **`ReceiptImportDialog` — colonne « ACTION » nommée `colFrigoW`.**
    Vestige du toggle « Frigo » supprimé (« tout va automatiquement au frigo »). Le comportement
    « tout est envoyé au stock » est donc implicite et non configurable ligne par ligne — seul le
    bouton 🗑 permet d'écarter une ligne.

28. **Contrat de `commitImport()` non observable depuis le QML.**
    L'ordre de priorité entre `quantityG` saisie, `pieceWeightG` et le prix unitaire pour alimenter
    `PantryStock.quantity_g` / `PriceHistory.quantity_g` n'est décrit que par un commentaire
    (« priorité dans la cascade »). À spécifier depuis le viewmodel Python.




