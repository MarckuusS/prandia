# 05 — ViewModels & Models de liste (surface d'API pour le portage web)

Source lue : `app/ui/viewmodels/*.py` (13 fichiers) + `app/ui/models/*.py` (5 `QAbstractListModel`) +
`app/main.py` (câblage). Tout ce qui suit provient du **code réel** au 2026-08-01. Les affirmations
de `CLAUDE.md` / `architecture.md` n'ont pas été utilisées comme source (elles ne mentionnent que
4 viewmodels sur 13).

---

## 0. Vue d'ensemble — ce que `main.py` expose réellement

`app/main.py` instancie 13 viewmodels et les injecte comme **context properties** QML
(`engine.rootContext().setContextProperty(...)`). Toutes les classes sont aussi enregistrées via
`@QmlElement` dans le module QML `App.ViewModels` v1 (jamais instanciées depuis QML en pratique).

| Context property QML | Classe Python | Fichier | Rôle |
|---|---|---|---|
| `ingredientVM` | `IngredientViewModel` | `ingredient_vm.py` | Bibliothèque perso d'ingrédients, filtres/tri/groupement, import CIQUAL/OFF, historique de prix |
| `recipeListVM` | `RecipeListViewModel` | `recipe_vm.py` | Liste des recettes, filtre par tags, « qu'est-ce que je peux cuisiner ? » |
| `recipeEditorVM` | `RecipeEditorViewModel` | `recipe_vm.py` | Buffer d'édition d'UNE recette + dérivés (nutrition, coût, poids, scaling) + photo + tags + journal de cuisson |
| `calendarVM` | `CalendarViewModel` | `calendar_vm.py` | Semaine ISO, entrées de menu, agrégats jour/semaine, templates, historique de coût |
| `shoppingVM` | `ShoppingViewModel` | `shopping_vm.py` | Liste de courses d'une semaine ISO (semaine **indépendante** de `calendarVM`) |
| `tagVM` | `TagListViewModel` | `tag_vm.py` | Catalogue des tags (lecture seule) |
| `backupVM` | `BackupViewModel` | `backup_vm.py` | Liste / restauration des sauvegardes SQLite |
| `networkVM` | `NetworkStatusViewModel` | `network_vm.py` | Ping périodique OpenFoodFacts (online/offline) |
| `pantryVM` | `PantryViewModel` | `pantry_vm.py` | Frigo / cellier (stock + péremption) |
| `receiptImportVM` | `ReceiptImportViewModel` | `receipt_import_vm.py` | Import de tickets de caisse (PDF/HTML/JSON Lidl) |
| `recipeUrlImportVM` | `RecipeUrlImportViewModel` | `recipe_url_import_vm.py` | Assistant d'import de recette depuis une URL (3 étapes) |
| `lidlPlusVM` | `LidlPlusViewModel` | `lidl_plus_vm.py` | Auto-fetch API Lidl Plus (polling opt-in) |
| `categoryVM` | `CategoryViewModel` | `category_vm.py` | Éditeur de l'arbre de catégories (rayons L1 / sous-rayons L2) |

Autre context property non-VM : `logDirPath` (string, chemin du dossier de logs) — pour les actions
« Ouvrir le dossier » du menu Aide. **Ne se porte pas** sur le web.

Câblage supplémentaire fait dans `main.py` (hors QML) :

- `ReceiptWatcher.file_detected` → `receiptImportVM.onWatcherDetectedFile(path)` ; puis
  `receiptImportVM.rescanPending()` au boot.
- `lidlPlusVM.start_if_enabled()` au boot (arme le `QTimer` de polling si activé en DB).
- `backup_on_startup()` et `ensure_receipt_dir()` avant l'ouverture du contexte DB.

### Conventions VM ↔ QML (valables partout)

1. **Nommage des slots** : `camelCase` (convention Qt/QML). Beaucoup de slots sont de simples
   wrappers autour d'une méthode Python `snake_case` (ex. `refreshList()` → `refresh()`),
   conservée pour les tests. Les deux API coexistent.
2. **Nommage des signaux** : déclarés `snake_case` côté Python ; côté QML on les écoute via
   `Connections { function onSnake_case_name(args) {...} }` (PySide6 préfixe `on` + le nom brut).
3. **`Decimal` → `str`** : jamais de `decimal.Decimal` vers QML. Toujours sérialisé en chaîne
   (`"12.0000"`, `"3.50"`). Le formatage est fait côté QML.
4. **Enums Pydantic** (`Source`, `MealSlot`) → `.value` (str) à la frontière.
5. **`datetime`** → deux formes fréquentes : `...Iso` (ISO-8601, `isoformat()`) et `...Human`
   (déjà formaté FR, `%d/%m/%Y` ou `%d/%m/%Y %H:%M`). Le formatage FR est **fait en Python**.
6. **Listes** → `QAbstractListModel` exposé par une `Property(QObject, constant=True)` (constant
   parce que l'instance interne est réutilisée, seul son contenu est reset).
7. **Payloads** → `QVariantMap` (objet JS) en entrée, `QVariantMap` / `QVariantList` en sortie.
   Un `{}` en retour signifie « erreur / refus » (le détail passe par `error_emitted`).
8. **Sessions DB** : chaque slot ouvre/ferme sa propre session (`with ctx.session()`). Aucune
   session longue durée. Équivaut naturellement à « 1 requête HTTP = 1 transaction ».

---

## 1. `IngredientViewModel` (`ingredientVM`) — `app/ui/viewmodels/ingredient_vm.py`

Le plus gros VM (1090 lignes). Trois responsabilités mêlées : la bibliothèque personnelle, le
catalogue (CIQUAL/OFF) et l'historique de prix.

### 1.1 Slots

| Slot | Paramètres | Retour | Effet | Écrit en base ? |
|---|---|---|---|---|
| `setFilter` | `query: str` | — | `_filter = query.strip()` puis `refresh()`. Vide = pas de filtre texte. | non |
| `refreshList` | — | — | Alias de `refresh()` (recharge + refiltre + retrie la liste). | non |
| `setSortBy` | `field: str` | — | Si `field ∈ SORT_FIELDS` et différent : change le tri, émet `view_options_changed` (→ persistance QSettings) et `refresh()`. Sinon **no-op silencieux**. | non (QSettings) |
| `setGroupBy` | `field: str` | — | Idem + `model.set_group_by(field)` (recalcul du rôle `groupKey`). | non (QSettings) |
| `setFilterSources` | `sources: QVariantList<str>` | — | Remplace l'ensemble des sources affichées. Liste vide = toutes. | non (QSettings) |
| `setFilterRayons` | `rayons: QVariantList<str>` | — | Remplace l'ensemble des `category_l1` affichés. Vide = tous. | non (QSettings) |
| `setFilterInSeason` | `value: bool` | — | Ne garder que les ingrédients de saison **ce mois-ci**. | non (QSettings) |
| `setFilterWithBrand` | `value: bool` | — | Ne garder que ceux qui ont une marque non vide. | non (QSettings) |
| `setFilterWithPieceWeight` | `value: bool` | — | Ne garder que `piece_weight_g > 0`. | non (QSettings) |
| `setFilterWithPrice` | `value: bool` | — | Ne garder que `price_eur > 0`. | non (QSettings) |
| `setMacroRange` | `macro: str, vmin: float, vmax: float` | — | Bornes min/max sur une macro. `macro ∈ {kcal, proteins, carbs, fats, fiber, salt}` (nom inconnu = no-op). `0` = pas de borne de ce côté ; les négatifs sont ramenés à `0` (`max(0.0, v)`). | non (QSettings) |
| `resetFilters` | — | — | Remet **tous** les filtres à zéro. **Ne touche ni au tri ni au groupement.** | non (QSettings) |
| `macroRange` | `macro: str` | `{min: float, max: float}` | Lecture de l'état d'un filtre macro. Macro inconnue → `{min:0.0, max:0.0}`. | non |
| `getAsDict` | `ingredient_id: int` | `QVariantMap` (voir §1.4) | Charge un ingrédient. `{}` si introuvable. | non |
| `saveFromDict` | `payload: QVariantMap` | `QVariantMap` de l'ingrédient sauvé, ou `{}` | Crée (`id` absent) ou met à jour (`id` présent). Voir §1.5 pour les règles fines. | **OUI** |
| `deleteIngredient` | `ingredient_id: int` | — | Suppression *soft ou hard* selon la source (voir §1.6). | **OUI** |
| `undoLastDelete` | — | — | Restaure la dernière suppression bufferisée. Idempotent (no-op si buffer vide). | **OUI** |
| `importExisting` | `ingredient_id: int` | `QVariantMap` de l'ingrédient, ou `{}` | Passe `in_personal_library = True`. | **OUI** |
| `importMany` | `ingredient_ids: QVariantList<int>` | `int` (nb réellement basculés) | Idem en lot, une seule session, un seul `refresh()` à la fin. Les ids falsy sont ignorés. | **OUI** |
| `fetchOnline` | `query: str` | `int` (nb de résultats mis en cache) | Appel HTTP OpenFoodFacts + cache local (`add_to_personal_library=False`). Sur `OpenFoodFactsError` : `error_emitted` + retourne 0. | **OUI** (cache OFF) |
| `fetchOnlineAndList` | `query: str, limit: int = 30` | `QVariantList<map>` | Comme `fetchOnline` mais renvoie les `limit` premiers résultats convertis en dicts. | **OUI** (cache OFF) |
| `searchOnce` | `query: str, scope: str = "personal", limit: int = 25` | `QVariantList<map>` | Recherche FTS5 **locale**, one-shot, ne touche pas la liste principale. `scope ∈ {"personal","all"}`. Query vide/blanche → `[]`. Aucun appel HTTP. | non |
| `searchBySource` | `query: str, source: str, limit: int = 50` | `QVariantList<map>` | FTS5 restreinte à un catalogue (`scope="all"`, `source=Source(source)`). Source invalide ou query vide → `[]`. | non |
| `lookupBarcodeAsDict` | `ean: str` | `QVariantMap` | Lookup OFF par code-barres. Validation locale : non vide, **uniquement des chiffres**, longueur ≥ 8, sinon `{}` sans appel réseau. Erreur OFF → `error_emitted` + `{}`. **N'écrit rien en DB** (lecture indicative pour préremplir un formulaire). | non |
| `searchCatalogPaged` | `opts: QVariantMap` | `{matches: [...], totalCount, page, pageSize, pageCount}` | Recherche riche du dialogue d'import (filtres + tri + pagination). Voir §1.7. | non |
| `priceHistoryFor` | `ingredient_id: int` | `QVariantList<map>` | Historique chronologique des prix. `[]` si `id <= 0`. Chaque entrée porte `pricePer100g` déjà calculé. | non |
| `addPriceHistory` | `payload: QVariantMap` | `QVariantMap` de l'entrée sauvée, ou `{}` | Ajoute une observation de prix **puis** `recompute_current_price(ingredient_id)` (met à jour `price_eur` + `price_quantity_g` de l'ingrédient). Puis `refresh()` + `current_price_recomputed(id)`. | **OUI** |
| `deletePriceHistory` | `entry_id: int` | `bool` | Supprime une observation, recalcule le prix de référence (ou le remet à NULL s'il ne reste rien), `refresh()` + `current_price_recomputed(id)`. | **OUI** |
| `knownStores` | — | `QVariantList<str>` | Magasins distincts déjà utilisés (autocomplétion). | non |
| `categoriesL1` | `source: str` | `QVariantList<str>` | Valeurs distinctes de `category_l1` pour une source donnée. Source invalide → `[]`. | non |

### 1.2 Properties

| Property | Type | Change quand | Notes |
|---|---|---|---|
| `items` | `QObject` (`IngredientListModel`), `constant=True` | jamais (l'instance ne change pas) | Le contenu change via `set_items()` / `update_one()` |
| `sortBy` | `str` | `view_options_changed` | Défaut `"name_asc"` |
| `groupBy` | `str` | `view_options_changed` | Défaut `"none"` |
| `filterSources` | `QVariantList<str>` | `view_options_changed` | Trié alphabétiquement |
| `filterRayons` | `QVariantList<str>` | `view_options_changed` | Trié alphabétiquement |
| `filterInSeason` | `bool` | `view_options_changed` | |
| `filterWithBrand` | `bool` | `view_options_changed` | |
| `filterWithPieceWeight` | `bool` | `view_options_changed` | |
| `filterWithPrice` | `bool` | `view_options_changed` | |
| `activeFilterCount` | `int` | `view_options_changed` | Badge « N filtres actifs ». Comptage : +1 si sources non vide, +1 si rayons non vide, +1 par toggle actif (4 max), +1 **par macro** dont `min > 0` ou `max > 0`. Max théorique = 12. |

### 1.3 Signaux

| Signal | Charge utile | Déclenché par | Écouté par |
|---|---|---|---|
| `items_changed` | — | fin de `refresh()` | (aucun `Connections` QML trouvé — utilisé implicitement) |
| `view_options_changed` | — | tout changement de tri/groupement/filtre **et** fin de `refresh()` | QML (barre de contrôles, badge) + slot interne `_save_view_options` (persistance QSettings) |
| `error_emitted` | `str` (message FR ou `str(exception)`) | validation Pydantic échouée, nom vide, erreur OFF, parsing prix | `IngredientsPage.qml` → toast |
| `deletion_pending_undo` | `str` = `"« <nom> » retiré"` | fin de `delete()` | `IngredientsPage.qml` → `UndoToast` |
| `current_price_recomputed` | `int` (ingredient_id) | après `addPriceHistory` / `deletePriceHistory` | `IngredientsPage.qml` → rafraîchit l'affichage lecture seule du prix |
| `name_collision_detected` | `int` (id existant), `str` (nom) | `saveFromDict` en **création** quand un ingrédient manuel du même nom existe déjà | `IngredientsPage.qml` → dialogue « Éditer l'existant / Annuler » |

### 1.4 Forme du dict ingrédient (`_ing_to_dict`) — **contrat de sérialisation**

```
id, name, source ("ciqual"|"openfoodfacts"|"manual"|"lidl"), sourceRef,
brand (str, "" si NULL), cookedWeightPer100gRaw (float|null),
kcal, proteins, carbs, sugars, fats, saturatedFats, fiber, salt   (float|null, pour 100 g)
priceEur (str, "" si NULL), priceQuantityG (float|null), pieceWeightG (float|null),
inLibrary (bool), categoryL1 (str|null), categoryL2 (str|null),
seasonMonths (str CSV, "" si NULL), hasSeasonality (bool), inSeasonNow (bool)
```

**Rôles dérivés :**
- `hasSeasonality` = `season_months` parse en au moins un mois valide.
- `inSeasonNow` = `datetime.now().month ∈ months`, `False` si aucune saisonnalité.
- Parsing CSV (`_parse_season_months`) : split sur `,`, `strip()`, ignore les vides, `int()`,
  garde uniquement `1 ≤ m ≤ 12`, ignore silencieusement les non-entiers. Résultat = `set`.

### 1.5 Règles de `saveFromDict` / `_dict_to_ing` (à reproduire exactement)

1. Si `payload.id` présent → on charge l'existant (`existing`).
2. `source` et `source_ref` : **repris de `existing`** s'il existe ; sinon `source = MANUAL` et
   `source_ref = payload.sourceRef or None`. Le formulaire n'édite jamais la source directement.
3. `price_eur` / `price_quantity_g` : **jamais lus du payload**. Repris de `existing`, sinon `None`.
   (Ils sont dérivés de l'historique de prix.)
4. `brand` : si la clé `"brand"` est **présente** dans le payload → `strip()` puis `"" → None` ;
   sinon on préserve l'existant.
5. `categoryL1`, `categoryL2`, `seasonMonths` : sémantique **« clé présente »** — si la clé existe
   (même à `""`/`null`) on prend la valeur du payload ; sinon on préserve l'existant.
6. `seasonMonths` passe par `_normalize_season_csv` : accepte str CSV **ou** liste ; garde
   `1..12` ; **dédoublonne + trie** ; renvoie `None` si rien ne reste (= pas de saisonnalité).
7. Macros + `pieceWeightG` + `cookedWeightPer100gRaw` passent par `_or_none` :
   `None`, `""` ou `0` → `None` ; non-numérique → `None` ; valeur `<= 0` → `None`.
   **Conséquence : impossible d'enregistrer une macro à 0.** (comportement volontaire, à conserver)
8. `in_personal_library` est **forcé à `True`** à chaque save (aussi dans `save()` via `model_copy`).
9. Erreur Pydantic → `error_emitted(str(exc))` + retour `{}`.
10. Nom vide après `strip()` → `error_emitted("Le nom de l'ingrédient est obligatoire.")` + `{}`.
11. **Contrôle de doublon (création uniquement)** : `IngredientRepo.find_by_name(name, Source.MANUAL)`.
    Si un doublon existe → `name_collision_detected(existing_id, name)` + retour `{}` **sans écrire**.
    Aucun contrôle sur les updates (renommer vers soi-même déclencherait un faux positif).
12. `save()` : si c'est un update **et** que `model.update_one(saved)` trouve la ligne → mise à jour
    en place (`dataChanged` sur une seule row, pas de reset de la ListView, préserve le scroll).
    Sinon → `refresh()` complet.

### 1.6 Suppression / undo

- `delete(id)` : charge l'ingrédient ; s'il est introuvable → no-op.
  - `source == "manual"` → **hard delete** (`repo.delete`), `_last_deleted_was_unflagged = False`.
  - sinon (ciqual/off/lidl) → **soft** : `mark_in_personal_library(id, False)`,
    `_last_deleted_was_unflagged = True`.
  - Puis `refresh()` + `deletion_pending_undo("« <nom> » retiré")`.
- `undoLastDelete()` :
  - cas soft → `mark_in_personal_library(id, True)` (même id).
  - cas hard → `repo.create(copy avec id=None)` → **nouvel id**. Toute référence externe (ligne de
    recette, entrée de calendrier) n'est **pas** re-liée.
  - Buffer vidé après usage ; un seul niveau d'undo.

### 1.7 `searchCatalogPaged` — contrat exact

Entrée (toutes les clés optionnelles sauf `source`) :

```
source: 'ciqual' | 'openfoodfacts'   (valeur invalide → repli sur 'ciqual')
query: str                            (défaut "")
categoryL1: str                       ("" → pas de contrainte)
minKcal/maxKcal/minProteins/maxProteins/minCarbs/maxCarbs/minFats/maxFats: float
     (via `_pos_or_none` : None/"" → None ; <= 0 → None ; donc 0 = « pas de contrainte »)
sortBy: 'rank' | 'name' | 'kcal' | 'proteins' | 'carbs' | 'fats'   (défaut 'rank')
sortDesc: bool                        (défaut false)
page: int (1-indexé, défaut 1)
pageSize: int (défaut 25)
```

Sortie : `{matches: [dict ingrédient…], totalCount, page, pageSize, pageCount}` où
`pageCount = ceil(totalCount / pageSize)` et vaut `1` si `pageSize <= 0` ou `totalCount <= 0`.
Sans contexte DB → `{matches: [], totalCount: 0, page: 1, pageSize: 25, pageCount: 1}`.

### 1.8 Pipeline de `refresh()` (à répliquer)

1. **Source des données** : si `_filter` non vide → `search_fts(_filter, limit=500, scope="personal")` ;
   sinon → `list_personal(limit=2000)`. **Ces limites sont en dur.**
2. **Filtres Python-side** (`_matches_filters`), dans l'ordre : sources, rayon (`category_l1 or ""`),
   en saison, avec marque, avec poids unitaire, avec prix, puis les 6 plages macro.
   *Point important* : dès qu'une plage macro est active, un ingrédient dont la macro vaut `None`
   est **exclu**.
3. **Tri** (`_apply_sort`) : nom via `casefold()` ; macros et prix avec clé `(1, 0)` pour `None` et
   `(0, v)` / `(0, -v)` sinon → **les `None` finissent toujours en fin de liste, dans les deux
   sens**. (La docstring dit le contraire pour le tri descendant : elle est fausse.)
   `created_desc` / `created_asc` utilisent `created_at or datetime.min`.
4. **Groupement** : si `_group_by != "none"`, tri stable supplémentaire par `groupKey`
   (`sorted(items, key=_compute_group_key)`) pour éviter qu'un même en-tête de section
   apparaisse plusieurs fois dans la ListView.
5. `model.set_items(items)` → `items_changed` + `view_options_changed`.

### 1.9 Persistance des options de vue (QSettings) — **spécifique desktop**

Préfixe `view_options/ingredients`. Clés : `sort_by`, `group_by`, `filter_sources` (CSV),
`filter_rayons` (CSV), `filter_in_season`, `filter_with_brand`, `filter_with_piece_weight`,
`filter_with_price`, `filter_<macro>_min`, `filter_<macro>_max` (6 macros × 2).
Chargées dans `__init__` **avant** le premier `refresh()` (silencieusement, sans signal).
Sauvegardées à chaque `view_options_changed` (connecté à `_save_view_options`).
Valeurs invalides ignorées (repli sur le défaut). Booléens relus de façon tolérante
(`"true"/"1"/"yes"`, insensible à la casse) car le registre Windows renvoie des chaînes.

→ **Équivalent web** : `localStorage` (clé `viewOptions.ingredients`, un seul objet JSON), ou un
endpoint `GET/PUT /api/preferences/ingredients` si l'on veut la synchro multi-appareil.

---

## 2. `RecipeListViewModel` (`recipeListVM`) — `app/ui/viewmodels/recipe_vm.py`

### 2.1 Slots

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `refreshList` | — | — | `RecipeRepo.list_all(tag_ids=_tag_filter or None)` → `model.set_items` → `items_changed`. | non |
| `deleteRecipe` | `recipe_id: int` | — | Snapshot complet (lignes + tags) dans le buffer undo puis `repo.delete`. `refresh()` + `deletion_pending_undo("Recette « X » supprimée")`. Recette introuvable → no-op. | **OUI** |
| `undoLastDelete` | — | — | Recrée la recette (`id=None` → **nouvel id**). Les entrées de calendrier qui pointaient sur l'ancien id **ne sont pas** re-liées. | **OUI** |
| `searchOnce` | `query: str, limit: int = 12` | `QVariantList<{id, name, defaultPortions, lineCount}>` | Recherche **par sous-chaîne** (`casefold()`, pour gérer Œ/œ) sur le nom, dans `list_all()` chargé intégralement en mémoire. Query vide → `[]`. Utilisé par le Ctrl+K unifié. | non |
| `setTagFilter` | `tag_ids: QVariantList<int>` | — | Remplace le filtre. Liste vide = pas de filtre. No-op si identique. Émet `tag_filter_changed` puis `refresh()`. | non |
| `toggleTagFilter` | `tag_id: int` | — | Ajoute/retire un tag du filtre. | non |
| `clearTagFilter` | — | — | Vide le filtre (no-op s'il est déjà vide). | non |
| `findByIngredients` | `ingredient_ids: QVariantList<int>, min_match: float = 0.5` | `QVariantList<{recipeId, name, score, matchCount, totalCount, photoUrl}>` | Score = `|ingrédients de la recette ∩ fournis| / |ingrédients de la recette|`. Filtre `score >= min_match`. Tri décroissant par `(score, matchCount)`. Recettes sans ingrédient exclues. `photoUrl` = URI `file://` absolu ou `""`. | non |
| `findByIngredientsCategorized` | `ingredient_ids: QVariantList<int>, max_missing: int = 3` | `{ready: [...], missing: [...], shopping: [...]}` | 3 sections (voir ci-dessous). Liste d'ids vide → les 3 listes vides. | non |

**`findByIngredientsCategorized` — forme de sortie :**
- `ready` / `missing` : `{recipeId, name, score, matchCount, totalCount, missingCount, missingNames: [str], photoUrl}`.
  - `ready` = recette entièrement couverte (`recipe ⊆ provided`), triée par taille de recette décroissante.
  - `missing` = `1 ≤ manquants ≤ max_missing`, triée par nb de manquants croissant puis taille décroissante.
- `shopping` : `{ingredientId, name, unlockCount}` — **top 5** des ingrédients à acheter, où
  `unlockCount` = nombre de recettes de `missing` qui deviendraient `ready` si on l'achetait.

### 2.2 Properties

| Property | Type | Change quand |
|---|---|---|
| `items` | `QObject` (`RecipeListModel`), constant | — |
| `tagFilter` | `QVariantList<int>` | `tag_filter_changed` |

### 2.3 Signaux

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `items_changed` | — | fin de `refresh()` | — |
| `tag_filter_changed` | — | `setTagFilter` / `toggleTagFilter` / `clearTagFilter` | `RecipesPage.qml` (chips) |
| `deletion_pending_undo` | `str` | fin de `delete()` | `RecipesPage.qml` → `UndoToast` |

---

## 3. `RecipeEditorViewModel` (`recipeEditorVM`) — `app/ui/viewmodels/recipe_vm.py`

Buffer d'édition **en mémoire** d'une recette. Toutes les mutations de méta et de lignes sont
bufferisées jusqu'à `saveCurrent()` ; **photo et tags se persistent immédiatement**.
Recette vide par défaut : `Recipe(name="(nouvelle recette)")`.

### 3.1 Slots

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `loadById` | `recipe_id: int` | — | Charge depuis la DB (deep copy). `id <= 0` ou pas de contexte → charge une recette vide. Réinitialise le scaling et le flag *dirty*. Émet `display_portions_changed`, `photo_changed`, `tags_changed`, `loaded`, `derived_changed`, `unsaved_changed`. | non |
| `loadEmpty` | — | — | `load(None)`. | non |
| `updateMeta` | `name: str, instructions: str, default_portions: int` | — | Buffer. `default_portions = max(1, v)`. Si le nombre de portions par défaut change → **le scaling est annulé**. Marque *dirty* **seulement si une valeur a réellement changé** (évite les faux positifs quand le formulaire renvoie les mêmes valeurs au blur). Émet `derived_changed`. | non |
| `addLineById` | `ingredient_id: int, quantity_g: float, notes: str = ""` | — | Hydrate l'ingrédient depuis la DB (introuvable → no-op), ajoute une ligne avec `ordinal = len(lines)`. `quantity_g <= 0` → no-op. Émet `lines_changed` + `derived_changed`, *dirty*. | non |
| `removeLineByOrdinal` | `ordinal: int` | — | Retire la ligne puis **renumérote tous les ordinaux** (0..n-1). | non |
| `updateLineQty` | `ordinal: int, displayed_g: float` | — | La valeur saisie est en unités **affichées** (donc déjà scalée). On divise par `scaleRatio` pour stocker la quantité d'origine. `<= 0` → no-op. Émet `derived_changed`. | non |
| `updateLineNotes` | `ordinal: int, notes: str` | — | `strip()` puis `"" → None`. **N'émet aucun signal de re-render** (les notes n'affectent ni nutrition ni coût) mais marque *dirty*. | non |
| `updateLineUnit` | `ordinal: int, unit_code: str` | — | Mémorise le code d'unité choisi (pour restituer la même unité au rechargement). `"" → None`. Émet `lines_changed`. **Ne marque pas *dirty*** (incohérence, cf. §12). | non |
| `linesAsList` | — | `QVariantList<map>` | Lignes triées par `(categoryL1 ou "~~~", ordinal)` → les lignes sans rayon finissent en bas. Chaque dict : `ordinal, ingredientId, ingredientName, ingredientSource, ingredientPieceWeightG, categoryL1 ("" si NULL), quantityG (scalée), unit ("" si NULL), notes ("" si NULL), originalQuantityG`. | non |
| `setDisplayPortions` | `portions: int` | — | `max(1, v)`. Si égal à `default_portions` → repasse en mode « pas de scaling ». Émet `display_portions_changed` + `derived_changed`. | non |
| `resetDisplayPortions` | — | — | Annule le scaling (no-op s'il n'y en avait pas). | non |
| `nutritionTotalAsDict` | — | `QVariantMap` (8 macros) | Total de la recette **multiplié par `scaleRatio`**. | non |
| `nutritionPerPortionAsDict` | — | `QVariantMap` | Par portion — **invariant au scaling** (retourné tel quel). | non |
| `nutritionPer100gAsDict` | — | `QVariantMap` | Densité pour 100 g de **poids cru** : `total * (100 / Σ quantity_g)`. Recette vide ou poids nul → tous les champs à 0 (évite la division par zéro). Invariant au scaling. | non |
| `costInfoAsDict` | — | voir §3.4 | Coût total scalé + coût par portion + compteurs. | non |
| `portionWeightAsDict` | — | voir §3.5 | Poids cuit estimé total et par portion. | non |
| `saveCurrent` | — | `bool` | Crée ou met à jour la recette, puis **recharge** la version persistée (récupère le nouvel id) — ce qui réinitialise le flag *dirty*. Retourne `False` si pas de contexte ou nom vide/blanc. | **OUI** |
| `setPhotoFromUrl` | `file_url: str` (`file:///...`) | `bool` | Copie/redimensionne l'image locale (1024×1024 max, JPEG q85, rotation EXIF appliquée) sous `<photo_dir>/<recipe_id>.jpg`, met à jour `image_path` **et persiste immédiatement**. Exige que la recette ait un `id` (sinon `error_emitted("Sauvegarde la recette avant d'ajouter une photo.")`). Décodage manuel du schéma `file://` (cas Windows `file:///C:/...`). | **OUI** + disque |
| `setPhotoFromHttpUrl` | `http_url: str` | `bool` | Télécharge (httpx, timeout 15 s / connect 5 s, redirections suivies, plafond 20 Mo) puis même traitement. Rejette toute URL qui ne commence pas par `http://` / `https://`. | **OUI** + réseau + disque |
| `removePhoto` | — | `bool` | Supprime le fichier et met `image_path = NULL`. `False` si pas d'id ou pas de photo. | **OUI** + disque |
| `currentTags` | — | `QVariantList<{id, name, colorHex}>` | Tags du buffer courant. | non |
| `toggleTag` | `tag_id: int` | — | Ajoute/retire. À l'ajout, hydrate le tag depuis `TagRepo` (introuvable → no-op). **Persiste immédiatement** via `RecipeRepo.set_tags` si la recette a un id. Émet `tags_changed`. Ne marque **pas** *dirty*. | **OUI** (si id) |
| `cookingLogAsList` | — | `QVariantList<map>` | Journal de cuisson, plus récent d'abord. Dict : `{id, recipeId, cookedAtIso, cookedAtHuman ("%d/%m/%Y"), rating (0 = pas de note), notes ("" si NULL)}`. `[]` si pas d'id. | non |
| `cookedTimesThisMonth` | — | `int` | `CookingLogRepo.count_in_window(recipe_id, days=30)`. ⚠ Le nom dit « ce mois » mais c'est une **fenêtre glissante de 30 jours**. | non |
| `addCookingLog` | `payload: QVariantMap` | `QVariantMap` de l'entrée, ou `{}` | `cookedAtIso` optionnel (vide → `now()` ; `"YYYY-MM-DD"` → minuit ; tz-aware → converti en naïf). `rating` : `None`/`""`/`0` → `None`, sinon `int`. `notes` : `strip()` puis `"" → None`. Erreur → `error_emitted` + `{}`. | **OUI** |
| `deleteCookingLog` | `entry_id: int` | `bool` | `False` si `entry_id <= 0`. | **OUI** |

### 3.2 Properties

| Property | Type | Change quand |
|---|---|---|
| `recipeName` | `str` | `loaded` |
| `defaultPortions` | `int` | `loaded` |
| `instructions` | `str` | `loaded` |
| `photoUrl` | `str` (URI `file://` absolu, `""` si pas de photo **ou fichier absent du disque**) | `photo_changed` |
| `hasPhoto` | `bool` | `photo_changed` |
| `displayPortions` | `int` | `display_portions_changed` |
| `isScaled` | `bool` (override défini **et** différent de `default_portions`) | `display_portions_changed` |
| `scaleRatio` | `float` = `displayPortions / defaultPortions`, `1.0` si pas de scaling ou `defaultPortions <= 0` | `display_portions_changed` |
| `hasUnsavedChanges` | `bool` | `unsaved_changed` |

⚠ `recipeName` / `defaultPortions` / `instructions` sont notifiés par `loaded` **uniquement** —
ils ne se rafraîchissent donc pas après un `updateMeta()` (comportement voulu : le formulaire est
la source de vérité pendant l'édition).

### 3.3 Signaux

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `loaded` | — | `load()` seulement | `RecipesPage.qml` (repeuple tout le formulaire) |
| `lines_changed` | — | ajout/suppression de ligne, `updateLineUnit` | `RecipesPage.qml` → reconstruit le tableau des lignes |
| `derived_changed` | — | **toute** mutation (méta, lignes, qty, scaling, load) | `RecipesPage.qml` → recalcule uniquement les panneaux nutrition/coût |
| `display_portions_changed` | — | `setDisplayPortions`, `resetDisplayPortions`, `load`, `updateMeta` (si portions par défaut changent) | `RecipesPage.qml` |
| `photo_changed` | — | set/remove photo, `load` | `RecipesPage.qml` → rebind `Image.source` |
| `tags_changed` | — | `toggleTag`, `load` | `RecipesPage.qml` |
| `error_emitted` | `str` | photo, tags, journal de cuisson | `RecipesPage.qml` → toast |
| `unsaved_changed` | — | `_mark_dirty()` / `_mark_clean()` | `RecipesPage.qml` → dialogue « Enregistrer / Abandonner / Annuler » avant de changer de recette |

### 3.4 `costInfoAsDict` — formule exacte

```
total_eur, missing_total        = pricing.recipe_cost(recipe)
per_portion_eur, _              = pricing.recipe_cost_per_portion(recipe)
ratio                           = scaleRatio
scaled_total = (total_eur * Decimal(str(ratio))).quantize(Decimal("0.01"))   # arrondi à 2 déc.
→ {
    total:             str(scaled_total),
    perPortion:        str(per_portion_eur),        # NON scalé
    missingPriceCount: len(missing_total),          # nb de lignes sans prix
    lineCount:         len(recipe.lines),
    displayPortions, defaultPortions, isScaled, scaleRatio
  }
```

### 3.5 `portionWeightAsDict` — formule exacte

Pour chaque ligne, avec `scale = scaleRatio` :
- `qty_raw = line.quantity_g * scale`
- si `ingredient.cooked_weight_per_100g_raw` est défini et `> 0` :
  `cooked += qty_raw * ratio / 100.0` et `ratiosDefinedCount += 1`
- sinon : `cooked += qty_raw` (hypothèse 1:1)

`perPortionCookedG = totalCookedG / max(1, displayPortions)`, ou `0.0` si `totalCookedG <= 0`.

Sortie : `{totalCookedG, perPortionCookedG, hasAnyRatio (= ratiosDefinedCount > 0),
ratiosDefinedCount, totalLines, defaultPortions, displayPortions, isScaled}`.
`hasAnyRatio` sert à griser le résultat quand il est purement « 1:1 par défaut ».

---

## 4. `CalendarViewModel` (`calendarVM`) — `app/ui/viewmodels/calendar_vm.py`

Semaine courante initialisée à `IsoWeek.from_date(now())` (format `'2026-W18'`).

### 4.1 Slots

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `setIsoWeek` | `value: str` | — | Valide le format via `IsoWeek(value=...)` (lève si invalide — **non catché**), puis `refresh()`. | indirect (voir archivage) |
| `shiftWeek` | `weeks: int` | — | Décale de N semaines (via `datetime.fromisocalendar(year, week, 1) + timedelta(weeks=N)`), robuste aux bascules d'année. Puis `refresh()`. | indirect |
| `refreshWeek` | — | — | Recharge les entrées, calcule leur description pré-résolue, **archive le coût de la semaine** si elle a au moins une entrée. | **OUI** (snapshot de coût) |
| `addRecipe` | `day_of_week: int (0=lundi…6=dimanche), slot: str, recipe_id: int, portions: float` | — | `MealPlanRepo.add(MealPlanEntry(...))` puis `refresh()`. `slot` est converti par `MealSlot(slot)` — **valeur invalide lève**. | **OUI** |
| `addIngredient` | `day_of_week: int, slot: str, ingredient_id: int, quantity_g: float` | — | Idem côté ingrédient. | **OUI** |
| `removeEntry` | `entry_id: int` | — | Snapshot pour l'undo (retrouvé dans la liste locale, pas re-requêté), `repo.remove(id)`, `refresh()`, `deletion_pending_undo("<description> retiré")`. | **OUI** |
| `undoLastDelete` | — | — | Réinsère avec `id=None` → **nouvel id**. | **OUI** |
| `copyPreviousWeek` | — | `int` (nb copié) | Copie **en append** les entrées de la semaine précédente (n'efface rien). No-op si `src == dst`. L'UI doit confirmer si la semaine courante n'est pas vide. | **OUI** |
| `currentWeekEntryCount` | — | `int` | `len(self._entries)` — sert à décider d'afficher la confirmation. | non |
| `saveAsTemplate` | `name: str` | `{id, name, entryCount}` ou `{}` | Snapshot JSON de la semaine sous ce nom (**upsert** : écrase le template de même nom). Nom vide → `ValueError` → `{}`. Semaine vide acceptée (`[]`). | **OUI** |
| `applyTemplate` | `template_id: int` | `int` (nb ajouté) | Ajoute (append) les entrées du template à la semaine courante. Template absent/corrompu → 0. Entrées malformées ignorées une par une. `refresh()` si > 0. | **OUI** |
| `listTemplates` | — | `QVariantList<{id, name, entryCount}>` | Ordre alphabétique par nom. | non |
| `deleteTemplate` | `template_id: int` | `bool` | `False` si `id <= 0` ou introuvable. | **OUI** |
| `searchOnce` | `query: str, limit: int = 12` | `QVariantList<{id, isoWeek, dayOfWeek, slot, description}>` | Recherche par sous-chaîne (`casefold`) dans les **descriptions rendues** de la semaine **courante uniquement**. ⚠ **Ce slot est cassé en l'état** — cf. §12. | non |
| `dayTotalAsDict` | `day_of_week: int` | `QVariantMap` (8 macros) | `nutrition_service.aggregate_day(iso_week, day)`. | non |
| `weekTotalAsDict` | — | `QVariantMap` | `nutrition_service.aggregate_week(iso_week)`. | non |
| `weekCostAsDict` | — | `{total: str, missingPriceCount: int}` | Voir §4.4. | non |
| `daysAsList` | — | `QVariantList<{dayOfWeek, dayNumber, monthShort, isoDate}>` | 7 entrées, lundi→dimanche. `monthShort` est une **table FR codée en dur** : `jan, fév, mars, avr, mai, juin, juil, août, sep, oct, nov, déc` (pas la locale système). | non |
| `costHistoryRecent` | `weeks: int = 12` | `QVariantList<{isoWeek, totalEur: str, missingCount}>` | Derniers snapshots hebdomadaires, du plus ancien au plus récent. | non |

### 4.2 Properties

| Property | Type | Change quand |
|---|---|---|
| `entries` | `QObject` (`MealPlanModel`), constant | — |
| `isoWeek` | `str` | `week_changed` |

### 4.3 Signaux

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `week_changed` | — | fin de `refresh()` (donc à chaque changement de semaine **ou** d'entrées) | `CalendarPage.qml` → `_refreshDerived()` |
| `deletion_pending_undo` | `str` | fin de `remove()` | `CalendarPage.qml` → `UndoToast` |

### 4.4 Coût de la semaine — formule exacte (`week_cost`)

Parcourt les entrées chargées :
- **Entrée recette** : `rec_cost, rec_missing = pricing.recipe_cost(recipe)` ;
  `factor = Decimal(str(entry.portions or 1.0)) / Decimal(max(recipe.default_portions, 1))` ;
  `total += rec_cost * factor` ; `missing += len(rec_missing)`.
  Recette introuvable → entrée ignorée.
- **Entrée ingrédient** : `cost = pricing.ingredient_cost(ing, entry.quantity_g or 0)` ;
  `None` → `missing += 1`, sinon `total += cost`. Ingrédient introuvable → ignorée.
- Retour `(total.quantize(Decimal("0.01")), missing)` → **arrondi à 2 décimales à la toute fin**.

### 4.5 Archivage automatique du coût (effet de bord de `refresh()`)

À **chaque** `refresh()`, si la semaine a au moins une entrée, `WeeklyCostRepo.upsert(
WeeklyCostSnapshot(iso_week, total_eur, missing_count))`. Les semaines vides ne sont pas archivées
(pas de zéros parasites dans l'historique).
→ **Portage web** : c'est une écriture cachée dans une lecture. À isoler : soit un `POST` explicite,
soit le recalculer côté serveur à chaque `GET /api/calendar/:week`.

### 4.6 Description pré-résolue d'une entrée (`_describe_with_repos`)

- Recette : `"🍽 {nom} (1 portion)"` si `portions == 1.0`, sinon `"🍽 {nom} ({portions:g} portions)"`
  (`:g` supprime les zéros inutiles : `2.0` → `2`). Recette absente → `"recette #<id>"`.
- Ingrédient : `"🥕 {nom} ({quantity_g:g} g)"`. Ingrédient absent → `"ingrédient #<id>"`.
- Ni l'un ni l'autre : `"?"`.

---

## 5. `ShoppingViewModel` (`shoppingVM`) — `app/ui/viewmodels/shopping_vm.py`

**Sa propre semaine ISO**, indépendante de `calendarVM` (bouton QML « ← semaine du calendrier »
qui appelle `shoppingVM.setIsoWeek(calendarVM.isoWeek)`).

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `setIsoWeek` | `value: str` | — | Valide, émet `week_changed`, `refresh()`. | non |
| `shiftWeek` | `weeks: int` | — | Décale, émet `week_changed`, `refresh()`. | non |
| `refreshList` | — | — | `shopping_service.aggregate_shopping_list(iso_week)` → `model.set_items` + `totalEur` + `missingPriceCount`, émet `list_changed`. | non |
| `setInFridge` | `ingredient_id: int, in_fridge: bool` | — | Coche/décoche « déjà au frigo » sur une ligne. **Purement local, non persisté**, réinitialisé à chaque `set_items` (re-seed depuis `is_covered_by_pantry`). Parcours linéaire du modèle par `ingredientId`. | non |
| `asText` | — | `str` | Rend la liste en texte brut via `shopping_service.format_as_text`. **Recalcule l'agrégation** (ne réutilise pas le modèle en mémoire). | non |
| `copyToClipboard` | — | `bool` | `asText()` puis presse-papiers système. `False` si aucune `QGuiApplication` (contexte de test). **Spécifique desktop.** | non |

| Property | Type | Change quand |
|---|---|---|
| `items` | `QObject` (`ShoppingListModel`), constant | — |
| `isoWeek` | `str` | `week_changed` |
| `totalEur` | `str` (Decimal sérialisé, `"0.00"` par défaut) | `list_changed` |
| `missingPriceCount` | `int` | `list_changed` |
| `itemCount` | `int` (= `model.rowCount()`) | `list_changed` |

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `week_changed` | — | `set_iso_week` / `shift_week` | `ShoppingPage.qml` (handler vide — le refresh est déjà fait dans le setter) |
| `list_changed` | — | fin de `refresh()` | `ShoppingPage.qml` (total, compteurs) |

**Couplage implicite** : `PantryPage.qml` appelle `shoppingVM.refreshList()` après un ajout ou une
suppression de stock (la précoche « déjà au frigo » dépend des totaux du frigo). Ce couplage est
codé **dans le QML**, pas dans les VMs.

---

## 6. `PantryViewModel` (`pantryVM`) — `app/ui/viewmodels/pantry_vm.py`

⚠ `__init__` appelle `refresh()` **inconditionnellement** (même sans contexte : dans ce cas
`set_items([])`).

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `refreshList` | — | — | Charge tous les stocks, résout les ingrédients en un seul `list_by_ids`, construit les `PantryRow`, applique le filtre texte puis le tri. Les stocks orphelins (ingrédient supprimé) sont **ignorés défensivement**. | non |
| `setSortBy` | `field: str` | — | `field ∈ {"urgency","name","quantity","expiry","category"}`, sinon no-op. Émet `view_options_changed` + `refresh()`. | non |
| `setGroupBy` | `field: str` | — | `field ∈ {"urgency","category","none"}`. Le groupement est **rendu côté QML** (`section.property`) ; le VM refresh quand même pour cohérence de l'ordre. | non |
| `setFilter` | `text: str` | — | `strip().casefold()`. Filtre par sous-chaîne sur le **nom d'ingrédient** uniquement. | non |
| `addStock` | `payload: {ingredientId, quantityG, expiryIso?, notes?}` | dict du stock, ou `{}` | Crée un `PantryStock`. `expiryIso` : `""`/absent → `None` ; `"YYYY-MM-DD"` → minuit ; ISO datetime accepté (tz retiré) ; date invalide → `None` + warning log. `notes` : `strip()` → `None` si vide. Émet `stock_changed`. | **OUI** |
| `updateStock` | `payload: {id, quantityG?, expiryIso?, notes?}` | dict du stock, ou `{}` | `id` requis (`<= 0` → `{}`), stock introuvable → `{}`. **Sémantique « clé présente »** pour `expiryIso` et `notes` (absente → on préserve l'existant). `quantityG` absent/0 → on préserve l'existant (`float(payload.get("quantityG") or existing.quantity_g)`). Émet `stock_changed`. | **OUI** |
| `deleteStock` | `stock_id: int` | `bool` | `False` si `<= 0`. Émet `stock_changed` en cas de succès. | **OUI** |

**Tri (`_apply_sort`)** — les `None` d'expiration passent toujours en fin (clé `(1, 0)` vs `(0, days)`) :
- `urgency` : `(clé_expiry, nom casefold)` — le plus urgent d'abord.
- `name` : nom `casefold()`.
- `quantity` : `-quantity_g` (décroissant).
- `expiry` : clé d'expiration seule.
- `category` : `(category_l1 or "~~~" en casefold, nom casefold)`.

| Property | Type | Change quand |
|---|---|---|
| `items` | `QObject` (`PantryListModel`), constant | — |
| `sortBy` | `str` (défaut `"urgency"`) | `view_options_changed` |
| `groupBy` | `str` (défaut `"urgency"`) | `view_options_changed` |
| `filterText` | `str` (déjà `casefold()`) | `view_options_changed` |
| `soonExpiringCount` | `int` — nb d'items avec `daysUntilExpiry ≤ 5` | `items_changed` |
| `totalCount` | `int` | `items_changed` |

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `items_changed` | — | fin de `refresh()` | bindings des compteurs |
| `error_emitted` | `str` | payload invalide | `PantryPage.qml` |
| `stock_changed` | — | add/update/delete | prévu pour que `ShoppingPage` se rafraîchisse (en pratique le QML appelle `shoppingVM.refreshList()` directement) |
| `view_options_changed` | — | setSortBy / setGroupBy / setFilter | `PantryPage.qml` (rebind de `section.property`) |

⚠ Les options de vue du frigo ne sont **pas** persistées (contrairement à celles des ingrédients).

---

## 7. `ReceiptImportViewModel` (`receiptImportVM`) — `app/ui/viewmodels/receipt_import_vm.py`

Machine à état avec un buffer `MatchedReceipt` mutable, mutée ligne par ligne depuis QML.

### 7.1 Slots

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `loadFromPath` | `path_str: str` | `bool` | Retire les préfixes `file:///` puis `file://`, parse via `parse_receipt(path)` (détection de format), matche contre la bibliothèque. Format inconnu ou erreur → `error_emitted` + `False`. Mémorise `_source_path`, remet `forceImport = False`, émet `receipt_loaded`. | non |
| `loadFromLidlJson` | `ticket_json: QVariantMap` | `bool` | Même chose depuis le JSON brut de l'API Lidl (`adapt_lidl_json`). Ticket sans article → `error_emitted` + `False`. `_source_path = None` (pas de fichier à nettoyer). | non |
| `linesAsList` | — | `QVariantList<map>` | Une entrée par ligne (voir §7.4). | non |
| `setLineChosenIngredient` | `index: int, ingredient_id: int` | — | `id <= 0` → `None` (dissocie). Émet `line_changed(index)`. | non |
| `toggleLineAddToPantry` | `index: int, value: bool` | — | Marque « ajouter aussi au frigo ». | non |
| `removeLine` | `index: int` | — | Retire complètement la ligne du buffer. Émet **`receipt_loaded`** (et non `line_changed`) car tous les index suivants décalent. | non |
| `setLineQuantity` | `index: int, quantity: int` | — | Compteur entier du ticket (legacy / scanner EAN). `max(1, v)`. Recalcule `total_price = unit_price × qty` **sauf si `user_price_override`**. | non |
| `setLineQuantityG` | `index: int, grams: float` | — | Quantité réelle **en grammes** (prioritaire au commit). `max(0.0, v)`. No-op si l'écart est `< 1e-6`. **Ne touche pas au prix.** | non |
| `setLineTotalPrice` | `index: int, price_str: str` | — | Nettoie (`,`→`.`, retire `€`, `strip`). Chaîne vide → no-op. Non parsable → `error_emitted("Prix invalide : « X »")`. `<= 0` → `error_emitted("Le prix doit être strictement positif.")`. Sinon : fixe `total_price`, recalcule `unit_price = total / max(qty,1)` et **verrouille `user_price_override = True`**. | non |
| `setLineBarcode` | `index: int, barcode: str` | — | Mémorise un EAN saisi (utilisé comme `source_ref` à la création). | non |
| `lookupBarcodeAndAssign` | `index: int` | `int` (id assigné, 0 sinon) | 1) valide l'EAN (chiffres uniquement, ≥ 8) sinon `error_emitted` ; 2) cherche en DB par `source_ref` sur `OPENFOODFACTS` **puis** `LIDL` → si trouvé : `mark_in_personal_library(True)` + assigne ; 3) sinon lookup OFF en ligne → si trouvé : `create()` avec `in_personal_library=True` + assigne ; 4) sinon `error_emitted`. | **OUI** |
| `setLineExpiry` | `index: int, expiry_iso: str` | — | `""` → `None` ; sinon `datetime.fromisoformat(expiry_iso + "T00:00:00")` — donc **strictement `YYYY-MM-DD`** ; invalide → `None` + warning. | non |
| `setForceImport` | `value: bool` | — | Autorise l'import malgré un doublon détecté. Émet `receipt_loaded`. | non |
| `suggestCreatePayload` | `index: int` | `QVariantMap` | Pré-remplissage du mini-formulaire de création (voir §7.5). | non |
| `createIngredientFromLine` | `payload: QVariantMap` | `int` (nouvel id, 0 si échec) | Crée l'ingrédient et l'assigne à la ligne (voir §7.6). | **OUI** |
| `commitImport` | — | `{success, message, priceCount?, pantryCount?}` | Commit transactionnel complet (voir §7.7). | **OUI** + **supprime un fichier** |
| `reset` | — | — | Vide le buffer (`_matched`, `_source_path`, `_force_import`), émet `receipt_loaded`. | non |
| `rescanPending` | — | — | Re-scanne le dossier surveillé (`list_pending_files()`), émet `pending_files_changed`. **Spécifique desktop.** | non |
| `onWatcherDetectedFile` | `path_str: str` | — | Slot branché sur le signal du watcher : ajoute à la liste si absent, émet `pending_files_changed` puis `new_file_detected(path)`. **Spécifique desktop.** | non |
| `loadNextPending` | — | `str` (chemin chargé, `""` sinon) | Charge le plus ancien fichier en attente. Fichier disparu ou échec de parsing → retiré de la liste et `""`. **Spécifique desktop.** | non |

### 7.2 Properties

| Property | Type | Change quand | Valeur |
|---|---|---|---|
| `hasReceipt` | `bool` | `receipt_loaded` | buffer non vide |
| `isDuplicate` | `bool` | `receipt_loaded` | `matched.is_duplicate` (ticket déjà en table `imported_receipt`) |
| `store` | `str` | `receipt_loaded` | `"lidl"`, `"intermarche"`, `"carrefour"`… (valeur brute du parser) |
| `receiptDateIso` | `str` | `receipt_loaded` | `""` si pas de date |
| `receiptDateHuman` | `str` | `receipt_loaded` | `"%d/%m/%Y %H:%M"` |
| `ticketId` | `str` | `receipt_loaded` | `""` si absent |
| `totalEur` | `str` | `receipt_loaded` | `""` si absent |
| `lineCount` | `int` | `receipt_loaded` | |
| `forceImport` | `bool` | `receipt_loaded` | |
| `pendingFileCount` | `int` | `pending_files_changed` | Badge de la barre de statut (`Main.qml`) |

### 7.3 Signaux

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `receipt_loaded` | — | load / removeLine / setForceImport / reset | `ReceiptImportDialog.qml` → re-snapshot complet du tableau |
| `line_changed` | `int` (index) | toute mutation ponctuelle d'une ligne | `ReceiptImportDialog.qml` → rafraîchit une ligne |
| `import_completed` | `bool success, str message` | `commitImport` (succès **et** échec) | `ReceiptImportDialog.qml` → ferme le dialogue / toast |
| `error_emitted` | `str` | format inconnu, prix invalide, EAN invalide, erreur OFF | `ReceiptImportDialog.qml` → toast |
| `pending_files_changed` | — | scan / détection / nettoyage | `Main.qml` → badge « N tickets en attente » |
| `new_file_detected` | `str` (chemin absolu) | watcher | notification ponctuelle |

### 7.4 Forme d'une ligne (`linesAsList`)

```
index, rawName, quantity (int),
unitPrice (str, "" si None), totalPrice (str, "" si None),
vatCode, isLikelyFood (bool),
matchSource, matchScore,        // provenance et score du matching automatique
suggestionIds ([int]),          // ids d'ingrédients suggérés
chosenId (int, 0 = non associé),
addToPantry (bool),
expiryIso ("YYYY-MM-DD" ou ""), expiryHuman ("%d/%m/%Y" ou ""),
userBarcode (str), quantityG (float), userPriceOverride (bool)
```

### 7.5 `suggestCreatePayload` — règles

- `name` = `raw_name` du ticket (l'utilisateur corrige en général : `"FRANUI FRAMBSE CHOCO"` → nom propre).
- `categoryL1` = `"Alimentaire"` si `is_likely_food` **ou** `store == "lidl"`, sinon `""`.
- `sourceRef` = `store_key` de la ligne si `store == "lidl"` (= `art_id` stable), sinon `""`.
- `pieceWeightG` et `priceQuantityG` = `0.0` (à saisir).
- Renvoie aussi `index`, `store`, `vatCode`, `quantity` pour contexte.

### 7.6 `createIngredientFromLine` — choix de la source

- `store == "lidl"` → `source = LIDL`, `source_ref = line.store_key or payload.sourceRef`.
- sinon si l'utilisateur a saisi un `sourceRef` (EAN) → `source = OPENFOODFACTS`, `source_ref = EAN`.
- sinon → `source = MANUAL`, `source_ref = NULL`.
- Toujours `in_personal_library = True` ; `pieceWeightG` / `priceQuantityG` retenus seulement s'ils
  sont `> 0`, sinon `NULL`.
- **Pour les enseignes ≠ Lidl**, un alias est aussi enregistré :
  `ReceiptAliasRepo.upsert(store, source_key = line.store_key, ingredient_id)` — c'est
  l'**apprentissage** qui rendra le matching déterministe aux imports suivants.
- Retourne l'id créé et assigne `chosen_ingredient_id` sur la ligne.

### 7.7 `commitImport` — algorithme exact (le plus critique du fichier)

1. Pas de buffer → `import_completed(False, "Aucun ticket chargé.")`.
2. `is_duplicate` et pas `force_import` → refus :
   `"Ticket déjà importé. Active 'Forcer' pour ré-importer."`.
3. `receipt_date = parsed.date or now()`.
4. Pour chaque ligne :
   - ignorée si `chosen_ingredient_id is None` ;
   - ignorée si `unit_price is None` ou `<= 0` (log warning) ;
   - **cascade de détermination de `qty_g`** (dans cet ordre) :
     1. `line.quantity_g` s'il est `> 0` (saisi explicitement par l'utilisateur) ;
     2. `ingredient.price_quantity_g` s'il est `> 0` ;
     3. `ingredient.piece_weight_g * line.quantity` (compteur du ticket) si `> 0` ;
     4. sinon **`1000.0` g** (placeholder ; le €/100 g devient approximatif mais les
        variations relatives restent interprétables).
   - `PriceHistoryEntry(ingredient_id, price_eur = unit_price × quantity, quantity_g = qty_g,
     store = parsed.store, recorded_at = receipt_date, notes = "Import ticket — <raw_name>")` ;
   - `recompute_current_price(ingredient_id)` ; `priceCount += 1` ;
   - si `add_to_pantry` : `PantryStock(ingredient_id, quantity_g = qty_g, expiry_date,
     notes = "Importé depuis ticket <store>")` ; `pantryCount += 1` ;
   - si `store != "lidl"` : `ReceiptAliasRepo.upsert(store, store_key, ingredient_id)`.
5. Si `parsed.ticket_id` existe **et** que ce n'était pas un doublon → `ImportedReceiptRepo.add(
   ticket_id, store, receipt_date, total_eur, line_count)`.
   ⚠ En mode « forcer », le ticket **n'est pas ré-enregistré** (il l'est déjà).
6. `s.commit()`.
7. **Nettoyage du fichier source (Option B)** : si `_source_path` est défini **et** que son chemin
   résolu commence par le dossier de tickets surveillé → `unlink(missing_ok=True)` + retrait de
   `pending_files`. Un fichier importé depuis n'importe où ailleurs sur le disque est **conservé**.
   Erreur OS → log warning, le commit reste un succès.
8. Message : `"Import réussi : N prix enregistré[s]"` + `" + M ajout(s) au frigo"` si M > 0 +
   `" · fichier supprimé"` si applicable.
   ⚠ Le pluriel « prix enregistrés » est appliqué sur `price_count > 1`.

---

## 8. `RecipeUrlImportViewModel` (`recipeUrlImportVM`) — `app/ui/viewmodels/recipe_url_import_vm.py`

Assistant en 3 étapes : `0` saisie d'URL → `1` revue + association → `2` confirmation.

### 8.1 Slots

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `extractFromUrl` | `url: str` | — (fire-and-forget) | URL vide → `extraction_failed("Colle une URL avant de charger.")`. Sinon `extraction_started` puis **thread daemon** : `fetch_recipe(url)` (5–10 s), puis résolution locale des candidats (`_build_resolved`). Résultat renvoyé au thread Qt par signal interne. | non (lecture DB) |
| `goToStep0` / `goToStep1` | — | — | Navigation. `goToStep1` no-op si rien d'extrait. | non |
| `reset` | — | — | Vide le buffer, revient à l'étape 0. | non |
| `updateMeta` | `name: str, instructions: str, portions: int` | — | Édite le buffer. Nom vide → **on conserve le nom extrait**. `portions = max(1, v)` (0/absent → 1). | non |
| `linesAsList` | — | `QVariantList<map>` | Voir §8.3. Ouvre **une** session et met en cache les ingrédients candidats pour éviter N requêtes. | non |
| `setLineChosenIngredient` | `idx: int, ingredient_id: int` | — | `0` → `None`. Si l'id n'est pas dans `candidates`, il y est **inséré en tête** (sinon la combobox n'aurait pas de libellé). | non |
| `setLineQuantityG` | `idx: int, qty_g: float` | — | `max(0.0, v)`. | non |
| `setLineUnitCode` | `idx: int, unit_code: str` | — | `"" → "g"`. | non |
| `setLineParsedName` | `idx: int, name: str` | — | Édite le nom parsé, marque `is_manual_override`, **relance** `resolve_ingredient_name` et auto-sélectionne le 1er candidat (ou `None` si aucun). | non |
| `searchCandidatesForLine` | `idx: int, query: str` | — | Relance la recherche locale avec une requête libre **sans** modifier `parsed_name`. Query vide → no-op. | non |
| `searchOnlineForLine` | `idx: int` | — | `fetch_from_openfoodfacts_and_cache(parsed_name, page_size=10)` puis re-résolution. N'écrase le choix courant que s'il était `None`. Erreur OFF → `error_emitted`. | **OUI** (cache OFF) |
| `ignoreLine` / `unignoreLine` | `idx: int` | — | Marque/démarque la ligne comme ignorée. | non |
| `createManualForLine` | `idx: int, payload: {name, categoryL1?, kcalPer100g?}` | `int` (id, 0 si échec) | Crée un ingrédient `MANUAL`, `in_personal_library=True`, l'insère en tête des candidats et le sélectionne. Nom vide → `error_emitted`. | **OUI** |
| `commit` | — | `{success, recipeId, message}` | Voir §8.4. | **OUI** + réseau (image) |

### 8.2 Properties

| Property | Type | Change quand |
|---|---|---|
| `stepIndex` | `int` (0/1/2) | `step_changed` |
| `hasExtracted` | `bool` | `meta_changed` |
| `name` | `str` | `meta_changed` |
| `instructions` | `str` | `meta_changed` |
| `defaultPortions` | `int` (1 si rien) | `meta_changed` |
| `prepTimeMin` | `int` (0 si inconnu) | `meta_changed` |
| `sourceUrl` | `str` | `meta_changed` |
| `lineCount` | `int` | `lines_changed` |

⚠ `prepTimeMin` est exposé mais **jamais persisté** au commit (`Recipe` n'a pas ce champ).

### 8.3 Résolution initiale d'une ligne (`_build_resolved`) — valeurs par défaut

- `qty = parsed_quantity or 0.0` ; `unit = parsed_unit or "g"`.
- `quantity_g` = `to_grams(qty, unit)` si `qty > 0` **et** `unit != "_piece"` ; sinon `qty * 1.0`.
  `KeyError` (unité inconnue) → `qty` si `> 0` sinon `100.0`. Puis, si `<= 0` → **`100.0`**.
- `unit_code` conservé seulement s'il appartient à
  `{g, kg, ml, cl, dl, L, c_cafe, c_soupe, tasse, pincee}` — sinon `"g"`.
- `candidates` = ids retournés par `resolve_ingredient_name(parsed_name)` ;
  `chosen_ingredient_id` = **le premier candidat** (auto-sélection).

Sortie de `linesAsList` :
```
idx, rawText, parsedName,
candidates: [{id, name, source, categoryL1, inLibrary, pieceWeightG}],
chosenIngredientId (0 si aucun), chosenIngredientName (""), chosenSource (""),
pieceWeightG (0.0 si absent), quantityG, unitCode, isIgnored, hasMatch
```

### 8.4 `commit` — règles de refus et effets

Refus (retour `{success: false, recipeId: 0, message}`) si :
- rien d'extrait → `"Aucune recette à importer."` ;
- pas de contexte → `"Contexte indisponible."` ;
- toutes les lignes ignorées → `"Toutes les lignes sont ignorées — rien à importer."` ;
- au moins une ligne active non associée → `"N ingrédient(s) non associé(s). Utilise « Ignorer »,
  « Créer manuellement » ou « Chercher en ligne (OFF) » sur chaque ligne."`.

Sinon :
1. Pour chaque ligne active (dans l'ordre) : hydrate l'ingrédient (introuvable → ligne sautée
   silencieusement) ; si `in_personal_library` est faux → **promotion** en bibliothèque perso ;
   crée une `RecipeLine(quantity_g = ln.quantity_g if > 0 else 100.0, unit = unit_code or None,
   notes = None, ordinal = index de boucle)`.
2. `Recipe(name = ext.name.strip() or "(recette importée)", instructions = ext.instructions or "",
   default_portions = max(1, ext.default_portions), lines = ...)` → `RecipeRepo.create`.
3. **Photo best-effort** : si `ext.image_url` est défini → `save_recipe_photo_from_http_url` puis
   `RecipeRepo.update` avec `image_path`. Toute exception est **avalée avec un log** — la recette
   est créée sans photo, le commit reste un succès.
4. Passe à l'étape 2, émet `import_completed(recipe_id)`.

### 8.5 Signaux

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `extraction_started` | — | `extractFromUrl` | `ImportRecipeUrlDialog.qml` → BusyIndicator |
| `extraction_completed` | `bool` | fin du worker (succès **ou** échec) | idem |
| `extraction_failed` | `str` (message FR) | URL vide, `RecipeImportError`, exception inattendue (`"Erreur inattendue : …"`) | idem |
| `lines_changed` | `int` (idx, `-1` = liste entière) | toute mutation de ligne | idem |
| `candidates_changed` | `int` (idx) | re-résolution des candidats | idem |
| `import_completed` | `int` (recipe_id) | commit réussi | idem (ferme, ouvre la recette) |
| `error_emitted` | `str` | erreur OFF, nom vide | idem |
| `step_changed` | — | changement d'étape | idem |
| `meta_changed` | — | extraction terminée, `updateMeta`, `reset` | idem |
| `_worker_result_ready` / `_worker_error_ready` | `object` / `str` | **internes** (thread → boucle Qt) | slots privés du VM |

---

## 9. `LidlPlusViewModel` (`lidlPlusVM`) — `app/ui/viewmodels/lidl_plus_vm.py`

Fonctionnalité **expérimentale** (la lib `lidl-plus` est testée DE/AT/UK, FR non garanti).
Polling opt-in : tant que `enabled` est faux, **aucune** requête réseau.

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `setEnabled` | `value: bool` | — | Persiste en DB **et** arme/désarme le `QTimer`. À l'activation, si la lib n'est pas installée → `error_emitted` + **remise à OFF en DB**. | **OUI** |
| `setPollIntervalMinutes` | `minutes: int` | — | **Refus silencieux si `minutes < 5`.** Persiste + reconfigure le timer. | **OUI** |
| `storeCredentials` | `email: str, refresh_token: str` | `bool` | Stocke le refresh-token (keyring). Erreur → `error_emitted` + `False`. | keyring OS |
| `purgeCredentials` | — | — | Supprime le token, désactive le polling en DB, arrête le timer. | **OUI** + keyring |
| `syncNow` | — | — | No-op si une sync est déjà en vol. Émet `sync_started`, lance un **thread daemon**. | **OUI** (voir ci-dessous) |
| `fetchTicketDetailAsDict` | `ticket_id: str` | `QVariantMap` (JSON brut) | Récupère un ticket complet pour le passer à `receiptImportVM.loadFromLidlJson`. Aucune écriture DB. Erreur → `error_emitted` + `{}`. | non |
| `pendingTicketIds` | — | `QVariantList<str>` | Copie de la liste en attente. | non |
| `removePendingTicketId` | `ticket_id: str` | — | Retire un id (après import réussi). | non |

**Worker de sync (`_sync_worker`)** : `fetch_recent_tickets(limit=20)` → filtre les ids déjà
présents dans `imported_receipt` (`repo.exists`) → `LidlPlusSettingsRepo.mark_fetched(now())`.
Message : `"N nouveau[x] ticket[s] Lidl"` ou `"Sync OK — aucun nouveau ticket."`.
`LidlPlusError` → `mark_error(str)` + `error_emitted`. Toute autre exception est attrapée
(`"Erreur inattendue : …"`) pour ne **jamais** tuer le timer. Dans le `finally` :
`_inflight = False`, `state_changed`, `sync_completed(nb, msg)`, et `new_tickets_pending(ids)`
s'il y en a.

**Démarrage** (`start_if_enabled`, appelé depuis `main.py`) : si la lib est dispo et
`settings.enabled` → `timer.setInterval(poll_interval_minutes × 60 000)` + `start()`, puis
**première sync différée de 15 s** (`QTimer.singleShot(15_000, syncNow)`).

| Property | Type | Change quand | Valeur |
|---|---|---|---|
| `isAvailable` | `bool` | `state_changed` | lib `lidl-plus` installée |
| `isKeyringAvailable` | `bool` | `state_changed` | |
| `isConnected` | `bool` | `state_changed` | un refresh-token est stocké (**pas de validation réseau**) |
| `connectedEmail` | `str` | `state_changed` | |
| `enabled` | `bool` | `state_changed` | **lit la DB à chaque accès** |
| `pollIntervalMinutes` | `int` (60 par défaut) | `state_changed` | lit la DB |
| `lastFetchedHuman` | `str` | `state_changed` | `"%d/%m/%Y %H:%M"` ou `"Jamais"` |
| `lastError` | `str` | `state_changed` | en mémoire seulement |
| `pendingTicketCount` | `int` | `state_changed` | |
| `isSyncing` | `bool` | `state_changed` | |

| Signal | Charge | Déclencheur | Écouteur |
|---|---|---|---|
| `state_changed` | — | toute mutation d'état | bindings du dialogue de configuration |
| `sync_started` | — | `syncNow` | `LidlPlusSetupDialog.qml` |
| `sync_completed` | `int nb, str message` | fin du worker | `LidlPlusSetupDialog.qml` |
| `error_emitted` | `str` | activation impossible, erreurs API | `LidlPlusSetupDialog.qml` |
| `new_tickets_pending` | `list<str>` (ticket ids) | fin de sync avec des nouveautés | **`Main.qml`** → propose l'import |

---

## 10. VMs simples

### 10.1 `CategoryViewModel` (`categoryVM`)

Arbre de catégories à **2 niveaux** (rayon L1 → sous-rayon L2). Aucune Property, tout passe par
des slots.

| Slot | Paramètres | Retour | Effet | Écrit ? |
|---|---|---|---|---|
| `tree` | — | `[{id, name, ordinal, children: [{id, name, ordinal}]}]` | Arbre complet pour l'éditeur des Paramètres. | non |
| `flatL1` | — | `[{id, name}]` | 1er écran du picker. | non |
| `l2For` | `parent_id: int` | `[{id, name}]` | 2e écran. `parent_id <= 0` → `[]`. | non |
| `addL1` | `name: str` | `int` (id, 0 si échec) | `ValueError` (nom vide / doublon) → `error_emitted` + 0. | **OUI** |
| `addL2` | `parent_id: int, name: str` | `int` | `parent_id <= 0` → 0. | **OUI** |
| `rename` | `category_id: int, new_name: str` | `bool` | Introuvable → `False` (sans commit). `ValueError` → `error_emitted` + `False`. | **OUI** |
| `delete` | `category_id: int` | `bool` | | **OUI** |

Signaux : `tree_changed` (après chaque mutation réussie) — écouté par `SettingsCategoriesDialog.qml`
et `CategoryPickerDialog.qml` ; `error_emitted(str)`.

### 10.2 `TagListViewModel` (`tagVM`)

| Slot | Retour | Effet |
|---|---|---|
| `listAll()` | `[{id, name, colorHex}]` | Tous les tags, tri alphabétique. **Lecture seule** — aucune édition de tag n'est exposée. |

Signal déclaré `tags_changed` — **jamais émis** dans le code (mort). Le QML appelle `listAll()` à la
demande (`RecipesPage.qml`).

### 10.3 `BackupViewModel` (`backupVM`) — **spécifique desktop**

| Slot | Paramètres | Retour | Effet |
|---|---|---|---|
| `listBackups` | — | `[{path, name, timestampIso, timestampHuman ("%d/%m/%Y à %Hh%M"), sizeBytes, humanSize}]` | Sauvegardes du plus récent au plus ancien. `humanSize` : `< 1 Ko` → `"N o"` ; `< 1 Mo` → `"X.X Ko"` ; sinon `"X.X Mo"`. |
| `restoreFromPath` | `backup_path: str` | `bool` | Restaure la base ; prend d'abord une **sauvegarde de sécurité** dont le chemin est renvoyé par `restored(path)`. **L'app doit être relancée** ensuite (le VM ne le fait pas — c'est le QML qui affiche « redémarrage requis »). Fichier absent → `error_emitted("Sauvegarde introuvable : …")`. |
| `backupDirectory` | — | `str` | Chemin du dossier de sauvegardes. |

Signaux : `error_emitted(str)`, `restored(str)` — écoutés par `RestoreBackupDialog.qml`.

### 10.4 `NetworkStatusViewModel` (`networkVM`) — **spécifique desktop**

Ping périodique de `search.openfoodfacts.org` (`is_off_alive(timeout=3.0)`) via `QTimer`
(intervalle par défaut **5 min**), premier ping **2 s** après le démarrage, exécution HTTP dans un
thread daemon. Optimiste au boot : `online = True` avant le premier ping.

| Membre | Type | Détail |
|---|---|---|
| `online` (Property) | `bool` | notifié par `online_changed` **seulement quand la valeur change** |
| `lastCheckedHuman` (Property) | `str` | `"%H:%M:%S"` ou `"jamais vérifié"` ; notifié par `last_checked_changed` à **chaque** ping |
| `checkNow()` (Slot) | — | Ping immédiat ; no-op si un ping est déjà en vol |

Consommé par `Main.qml` (pastille de statut cliquable) et `ImportIngredientDialog.qml`
(désactive « Chercher en ligne » hors-ligne).

---

## 11. Les `QAbstractListModel` — rôles exhaustifs

Chaque modèle expose une Property `Roles` (`QVariantMap`, constant) qui mappe **nom de rôle → id
entier**, pour éviter les nombres magiques côté QML. Tous font un **reset complet**
(`beginResetModel` / `endResetModel`) sur `set_items()` / `set_rows()`, sauf indication contraire.
`DisplayRole` (rôle Qt par défaut) a systématiquement un repli (voir tableaux).

### 11.1 `IngredientListModel` (21 rôles) — `items` de `ingredientVM`

| Rôle QML | Id | Type | Calcul |
|---|---|---|---|
| `ingredientId` | UserRole+1 | int | `ingredient.id` |
| `name` | +2 | str | `ingredient.name` |
| `source` | +3 | str | `ingredient.source.value` |
| `sourceRef` | +4 | str\|null | `ingredient.source_ref` |
| `kcal` | +5 | float\|null | `kcal_per_100g` |
| `proteins` | +6 | float\|null | `proteins_g` |
| `carbs` | +7 | float\|null | `carbs_g` |
| `fats` | +8 | float\|null | `fats_g` |
| `priceEur` | +9 | str\|null | `str(price_eur)` — **`None` reste `None`** (≠ `_ing_to_dict` qui renvoie `""`) |
| `priceQuantityG` | +10 | float\|null | `price_quantity_g` |
| `pieceWeightG` | +11 | float\|null | `piece_weight_g` |
| `inLibrary` | +12 | bool | `in_personal_library` |
| `categoryL1` | +13 | str\|null | brut (pas de repli) |
| `categoryL2` | +14 | str\|null | brut |
| `inSeasonNow` | +15 | bool | **dérivé** : parcourt le CSV `season_months`, `True` si l'un des mois vaut `datetime.now().month`. Pas de saisonnalité → `False`. Segments non entiers ignorés. |
| `brand` | +16 | str | `brand or ""` |
| `sourceLabel` | +17 | str | **dérivé** : table `{ciqual→"CIQUAL", openfoodfacts→"OFF", manual→"Manuel", lidl→"Lidl"}`, repli sur la valeur brute |
| `seasonStatus` | +18 | str | **dérivé** : `"—"` si pas de saisonnalité, sinon `"🌱 De saison"` / `"Hors saison"` |
| `kcalRange` | +19 | str | **dérivé** : `None → "Sans valeur kcal"` ; `< 100 → "0–100 kcal/100g"` ; `< 300 → "100–300 kcal/100g"` ; `< 500 → "300–500 kcal/100g"` ; sinon `"500+ kcal/100g"` |
| `rayon` | +20 | str | **dérivé** : `category_l1 or "Sans rayon"` |
| `groupKey` | +21 | str | **dérivé dynamique** selon `_group_by` : `"source"` → `sourceLabel` ; `"rayon"` → `rayon` ; `"season"` → `seasonStatus` ; `"kcal_range"` → `kcalRange` ; `"none"` → `""` (toutes les rows ont la même clé, donc pas de section) |

- `DisplayRole` → `ingredient.name`.
- `set_group_by(g)` n'entraîne **pas** de reset : il émet `dataChanged(0, n-1, [GroupKeyRole])`.
- `update_one(ing)` : remplace la row d'id correspondant, émet `dataChanged` sur **cette seule row**
  (tous rôles), retourne `False` si `ing.id is None` ou si la row n'est pas trouvée.

### 11.2 `RecipeListModel` (6 rôles) — `items` de `recipeListVM`

| Rôle QML | Id | Type | Calcul |
|---|---|---|---|
| `recipeId` | +1 | int | `recipe.id` |
| `name` | +2 | str | `recipe.name` |
| `defaultPortions` | +3 | int | `default_portions` |
| `lineCount` | +4 | int | `len(recipe.lines)` |
| `instructionsHead` | +5 | str | **dérivé** : **première ligne** de `instructions` (après `strip()` + `splitlines()`), tronquée à **80 caractères** avec `…` en 80e position (`preview[:79] + "…"`). `""` si vide. |
| `photoUrl` | +6 | str | **dérivé** : `absolute_photo_path(image_path).as_uri()` → URI `file://` **absolu**. `""` si `image_path` est NULL **ou si le fichier n'existe plus sur le disque** (un warning est loggé). |

`DisplayRole` → `recipe.name`.

**Note portage** : `photoUrl` en `file://` doit devenir une URL HTTP (ex.
`/api/recipes/:id/photo` ou un lien R2/S3). La sémantique « fichier manquant → `""` » doit être
conservée (le QML affiche un placeholder « 🍽 Aucune photo »).

### 11.3 `MealPlanModel` (9 rôles) — `entries` de `calendarVM`

Chaque row est un `MealPlanRow = (entry, description)` : la **description est pré-résolue par le
viewmodel** (qui a accès à la DB), le modèle reste un pur porteur de données.

| Rôle QML | Id | Type | Calcul |
|---|---|---|---|
| `entryId` | +1 | int | `entry.id` |
| `dayOfWeek` | +2 | int | 0 = lundi … 6 = dimanche |
| `slot` | +3 | str | `entry.slot.value` — `"morning" \| "noon" \| "evening"` |
| `kind` | +4 | str | **dérivé** : `"recipe"` si `recipe_id is not None`, sinon `"ingredient"` |
| `recipeId` | +5 | int\|null | |
| `ingredientId` | +6 | int\|null | |
| `quantityG` | +7 | float\|null | |
| `portions` | +8 | float\|null | |
| `description` | +9 | str | **pré-résolue** par `_describe_with_repos` (cf. §4.6) : `"🍽 Nom (N portions)"` / `"🥕 Nom (X g)"`. Une seule résolution par refresh, pas par rendu de delegate. |

`DisplayRole` → `description`. La grille 7×3 est construite **côté QML** en filtrant ce modèle plat
par `(dayOfWeek, slot)`.

### 11.4 `PantryListModel` (11 rôles) — `items` de `pantryVM`

Row = `PantryRow` = jointure en mémoire `PantryStock` + champs dénormalisés de l'ingrédient
(`ingredient_name`, `ingredient_source`, `category_l1`, `piece_weight_g`).

Seuils de classe : `SOON_THRESHOLD_DAYS = 5`, `WATCH_THRESHOLD_DAYS = 14`.

| Rôle QML | Id | Type | Calcul |
|---|---|---|---|
| `stockId` | +1 | int | `stock.id` |
| `ingredientId` | +2 | int | `stock.ingredient_id` |
| `name` | +3 | str | nom dénormalisé |
| `quantityG` | +4 | float | `stock.quantity_g` |
| `expiryIso` | +5 | str | `expiry_date.date().isoformat()` ou `""` |
| `daysUntilExpiry` | +6 | int\|null | **dérivé** : `(expiry_date.date() - date.today()).days`. `None` si pas d'expiration. **Négatif = déjà périmé** (affiché en rouge). Recalculé à chaque lecture → dépend de la date du jour. |
| `notes` | +7 | str | `stock.notes or ""` |
| `categoryL1` | +8 | str | `category_l1 or "Non catégorisé"` (repli ≠ celui de `IngredientListModel` qui dit `"Sans rayon"`) |
| `pieceWeightG` | +9 | float\|null | |
| `source` | +10 | str | source de l'ingrédient |
| `urgencyBucket` | +11 | str | **dérivé (le « seau d'urgence »)** : `days is None → "stock"` ; `days ≤ 5 → "soon"` ; `days ≤ 14 → "watch"` ; sinon `"stock"`. Utilisé comme `section.property` quand `groupBy == "urgency"`. Libellés FR côté QML : « À consommer vite » / « À surveiller » / « En stock ». |

`DisplayRole` → `ingredient_name`.

### 11.5 `ShoppingListModel` (12 rôles) — `items` de `shoppingVM`

Row = `ShoppingItem` (Pydantic frozen, `app/domain/shopping.py`).
Le modèle porte en plus un état local `_in_fridge: dict[ingredient_id → bool]`, **non persisté**,
**réinitialisé à chaque `set_items()`** et pré-alimenté depuis `is_covered_by_pantry`.

| Rôle QML | Id | Type | Calcul |
|---|---|---|---|
| `ingredientId` | +1 | int | |
| `name` | +2 | str | |
| `source` | +3 | str | |
| `quantityG` | +4 | float | quantité totale requise pour la semaine |
| `pieceWeightG` | +5 | float\|null | |
| `pieceCount` | +6 | float\|null | **dérivé** : `quantity_g / piece_weight_g`, `None` si `piece_weight_g` est falsy (**0 inclus**). Sert au « ≈ 6 pièces ». Pas d'arrondi côté modèle. |
| `categoryL1` | +7 | str\|null | brut (le regroupement est fait côté QML) |
| `costEur` | +8 | str\|null | `str(cost_eur)`, `None` si l'ingrédient n'a pas de prix |
| `hasPrice` | +9 | bool | **dérivé** : `cost_eur is not None` |
| `inFridge` | +10 | bool | **état UI local** — voir ci-dessus. Seul rôle **inscriptible** (`setData`) |
| `inPantryG` | +11 | float | quantité déjà au frigo (posée par `aggregate_shopping_list` depuis `PantryRepo`), `0.0` par défaut |
| `isCoveredByPantry` | +12 | bool | **dérivé** : `in_pantry_g >= quantity_g **et** quantity_g > 0`. Une ligne de quantité 0 n'est donc jamais « couverte ». |

`DisplayRole` → `item.name`.
`setData(index, value, role)` n'accepte **que** `InFridgeRole` ; sinon retourne `False`. Émet
`dataChanged(index, index, [InFridgeRole])`.

---

## 12. Ce qui ne se porte pas tel quel + anomalies relevées

### 12.1 Dépendances desktop et équivalents web proposés

| Élément desktop | Où | Équivalent web proposé |
|---|---|---|
| **QSettings** (options de vue des ingrédients) | `ingredient_vm.py` | `localStorage` (`viewOptions.ingredients`) ou `GET/PUT /api/preferences/:scope` si synchro multi-appareil souhaitée |
| **Surveillance de dossier** (`ReceiptWatcher`, `pending_files`, `loadNextPending`, `rescanPending`, `onWatcherDetectedFile`, `pendingFileCount`, `new_file_detected`) | `receipt_import_vm.py` | Upload explicite (`POST /api/receipts/parse`, multipart) + zone de drag-and-drop. Éventuellement une file côté serveur si l'on veut garder la notion de « tickets en attente » (ex. transfert d'e-mail vers une boîte dédiée) |
| **Suppression du fichier source après commit** (« Option B ») | `commitImport` | Sans objet : un upload n'a pas de fichier persistant. Conserver éventuellement l'objet uploadé quelques jours puis purge |
| **Photos sur disque** (`file://`, `~/.prandia/recipe_photos/<id>.jpg`, Pillow 1024px q85 + EXIF) | `photo_service.py`, `recipe_vm.py`, `RecipeListModel` | Stockage objet (R2) + `GET /api/recipes/:id/photo` ; redimensionnement côté client (Canvas/`createImageBitmap`) ou via un service d'images. `setPhotoFromUrl(file://…)` devient un upload multipart |
| **Threads daemon** (extraction URL, ping OFF, sync Lidl) + signaux Qt cross-thread | `recipe_url_import_vm.py`, `network_vm.py`, `lidl_plus_vm.py` | Requêtes `async` côté Worker. L'état « en cours » (`isSyncing`, BusyIndicator) devient un état React/Svelte local. Pour l'extraction longue : requête normale (le Worker a un budget CPU/temps suffisant) ou file + polling |
| **`QTimer`** (ping OFF 5 min, polling Lidl N min, sync différée 15 s) | `network_vm.py`, `lidl_plus_vm.py` | `setInterval` côté client pour le ping ; **Cron Trigger Cloudflare** pour le polling Lidl (mieux : ça marche app fermée) |
| **Presse-papiers** (`copyToClipboard`) | `shopping_vm.py` | `navigator.clipboard.writeText()` — purement client, l'API renvoie juste le texte |
| **Keyring OS** (refresh-token Lidl) | `lidl_plus_vm.py` | Secret chiffré côté Worker (Secrets Store / KV chiffré). **À traiter avec précaution : jamais exposé au front** |
| **Sauvegarde/restauration SQLite locale** (`backupVM`) | `backup_vm.py`, `db.py` | D1 gère ses propres sauvegardes (Time Travel). Conserver éventuellement un `GET /api/export` (dump JSON) et un `POST /api/import` |
| **Dialogues natifs** (`FileDialog` pour photo/ticket) | QML | `<input type="file">` |
| **Ouverture de dossier** (`logDirPath`) | `main.py` | Sans objet |
| **Toast d'annulation avec buffer mémoire** (`deletion_pending_undo` + `undoLastDelete`) | 3 VMs | Soit un buffer client (l'ordre `DELETE` n'est envoyé qu'après le délai du toast), soit un `POST /api/…/undo` serveur avec buffer en session. ⚠ **Sémantique à conserver** : l'undo d'une suppression *hard* recrée avec un **nouvel id** et ne re-lie aucune référence |

### 12.2 Anomalies / bugs constatés dans le code (à ne PAS reproduire)

1. **`CalendarViewModel.searchOnce` est cassé.** Le code fait `m = self._entries` (une
   `list[MealPlanEntry]`) puis appelle `m.rowCount()`, `m.index(i, 0)`, `m.data(...)` — méthodes
   qui n'existent que sur `MealPlanModel`. Tout appel avec une requête non vide lève
   `AttributeError`. **Intention manifeste** : itérer sur `self._model`. À corriger au portage
   (recherche par sous-chaîne, insensible à la casse, sur la description rendue, limitée à la
   semaine courante).
2. **`CalendarViewModel.saveAsTemplate` utilise `log.warning` alors que `log` n'est jamais
   défini dans `calendar_vm.py`** (pas d'`import logging`). Sur le chemin d'erreur (nom de template
   vide) → `NameError` au lieu du retour `{}` attendu.
3. **`IngredientViewModel._apply_sort` : la docstring contredit le code.** Elle annonce « None au
   début pour les tris décroissants » ; en réalité les `None` sont **toujours en fin** dans les deux
   sens. Le comportement du code fait foi.
4. **`RecipeEditorViewModel.updateLineUnit` ne marque pas la recette *dirty*.** Changer l'unité
   d'une ligne peut donc être perdu si l'utilisateur quitte l'éditeur (aucun avertissement).
5. **`cookedTimesThisMonth` mesure 30 jours glissants**, pas le mois calendaire, malgré le nom et
   le libellé UI « cuisiné 3× ce mois ».
6. **Incohérence de sérialisation du prix** : `_ing_to_dict` renvoie `""` pour un prix NULL, alors
   que le rôle `priceEur` du modèle renvoie `null`. Le front web doit choisir une convention unique
   (recommandé : `null`).
7. **Incohérence des replis de catégorie** : `"Sans rayon"` (IngredientListModel) vs
   `"Non catégorisé"` (PantryListModel) vs `null` brut (ShoppingListModel).
8. **`IngredientViewModel.save()` n'a pas de garde `ctx is None`** (contrairement à toutes les
   autres méthodes) → `AttributeError` en contexte de test sans DB.
9. **`commitImport` en mode « forcer »** ne réinsère pas le ticket dans `imported_receipt`, ce qui
   est correct pour l'anti-doublon mais signifie que `line_count`/`total_eur` du 1er import ne sont
   jamais mis à jour.
10. **`RecipeUrlImportViewModel.prepTimeMin` est exposé mais jamais persisté** — le modèle `Recipe`
    n'a pas de champ temps de préparation. Soit l'ajouter au schéma web, soit retirer la Property.
11. **`TagListViewModel.tags_changed` n'est jamais émis** (signal mort) et aucune édition de tag
    n'est exposée (pas de create/rename/delete) — le catalogue est figé par le seed.
12. **Deux sources de vérité pour les « rayons »** : `ingredientVM.categoriesL1(source)` (valeurs
    distinctes de `ingredient.category_l1`, du texte libre) et `categoryVM.flatL1()` (table
    `category` structurée avec des ids). Le QML utilise l'une ou l'autre selon l'écran
    (`IngredientFilterDialog` et `CategoryPickerDialog` utilisent `categoryVM`). **Ambiguïté à
    trancher au portage** : soit on normalise `ingredient.category_l1` en clé étrangère vers
    `category.id`, soit on assume le doublon.

### 12.3 Points d'ambiguïté signalés (sans trancher)

- La **valeur par défaut de 1000 g** dans `commitImport` (cascade `qty_g`, étape 4) est un
  placeholder assumé qui fausse le €/100 g. Elle est documentée comme « honnête » dans le code
  mais reste une hypothèse forte.
- `setLineQuantity` (compteur) et `setLineQuantityG` (grammes) coexistent avec des sémantiques
  différentes sur le même objet ligne ; laquelle prime est décidé **au commit** (grammes d'abord).
- `MealSlot(slot)` et `IsoWeek(value)` **lèvent** sur valeur invalide sans être catchés dans les
  slots correspondants (`addRecipe`, `addIngredient`, `setIsoWeek`) : côté desktop l'exception
  remonte dans la boucle Qt. Côté web, cela doit devenir une **400** propre.
- `ShoppingViewModel` et `CalendarViewModel` maintiennent **deux semaines ISO indépendantes**.
  C'est intentionnel (l'utilisateur peut préparer la liste d'une autre semaine) mais mérite
  d'être conservé explicitement (deux états d'URL / de store distincts).

---

## 13. Proposition d'API REST consolidée

Convention : `Decimal` sérialisé en `string`, dates en ISO-8601, corps et réponses en JSON.
`?week=YYYY-Www` pour les semaines ISO. Toutes les listes paginées renvoient
`{items, totalCount, page, pageSize, pageCount}`.

### 13.1 Ingrédients — bibliothèque personnelle

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/ingredients?q=&sort=&group=&sources=&rayons=&inSeason=&withBrand=&withPieceWeight=&withPrice=&kcalMin=&kcalMax=&…` | `setFilter`, `refreshList`, `setSortBy`, `setGroupBy`, `setFilter*`, `setMacroRange`, `resetFilters`, Property `items` | Un seul endpoint : les 12 setters de filtre du VM deviennent des query-params. Renvoie aussi `activeFilterCount` et les rôles dérivés (`inSeasonNow`, `sourceLabel`, `seasonStatus`, `kcalRange`, `rayon`, `groupKey`) — **ou** on les calcule côté client (recommandé pour `inSeasonNow`, qui dépend du fuseau du client). Limites en dur du desktop (500 filtré / 2000 non filtré) → vraie pagination |
| `GET /api/ingredients/:id` | `getAsDict` | |
| `POST /api/ingredients` | `saveFromDict` (création) | `409 Conflict` + `{existingId, name}` en cas de collision de nom manuel (remplace `name_collision_detected`) |
| `PUT /api/ingredients/:id` | `saveFromDict` (mise à jour) | Conserver la sémantique « clé présente » pour `brand`/`categoryL1`/`categoryL2`/`seasonMonths` → utiliser **PATCH** serait plus honnête |
| `DELETE /api/ingredients/:id` | `deleteIngredient` | Réponse `{mode: "hard" \| "unflagged", undoToken}` |
| `POST /api/ingredients/undo` | `undoLastDelete` | Corps `{undoToken}`. Alternative : garder l'undo purement client |
| `POST /api/ingredients/:id/library` | `importExisting` | Bascule `in_personal_library = true` |
| `POST /api/ingredients/library:batch` | `importMany` | Corps `{ids: [int]}` → `{promoted: int}` |

### 13.2 Catalogue & sources externes

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/catalog/search?source=&q=&categoryL1=&minKcal=&…&sortBy=&sortDesc=&page=&pageSize=` | `searchCatalogPaged`, `searchBySource`, `searchOnce` | **Trois doublons fusionnés.** `scope=personal` couvre `searchOnce` (autocomplétion), `source=ciqual` couvre `searchBySource` |
| `GET /api/off/search?q=&limit=` | `fetchOnline`, `fetchOnlineAndList` | **Doublon** : `fetchOnline` ne renvoie qu'un compteur, `fetchOnlineAndList` renvoie les lignes. Un seul endpoint suffit (le compteur est `items.length`). Effet de bord conservé : mise en cache locale des résultats |
| `GET /api/off/barcode/:ean` | `lookupBarcodeAsDict`, étape 2 de `lookupBarcodeAndAssign` | **Doublon.** Validation `^\d{8,}$` côté serveur, `404` si non trouvé |
| `GET /api/off/status` | `networkVM.online` | Optionnel ; le front peut aussi se contenter de gérer les erreurs des appels OFF |
| `GET /api/ingredients/categories?source=` | `categoriesL1` | Valeurs distinctes de `category_l1` — **à réconcilier avec `/api/categories`** (cf. §12.2 point 12) |

### 13.3 Historique de prix

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/ingredients/:id/prices` | `priceHistoryFor` | Chaque entrée porte `pricePer100g` précalculé |
| `POST /api/ingredients/:id/prices` | `addPriceHistory` | **Effet de bord obligatoire** : recalcul du prix de référence de l'ingrédient. Réponse : `{entry, ingredient}` (évite un aller-retour, remplace `current_price_recomputed`) |
| `DELETE /api/prices/:entryId` | `deletePriceHistory` | Idem, recalcul (ou remise à NULL) |
| `GET /api/stores` | `knownStores` | Autocomplétion du champ magasin |

### 13.4 Recettes

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/recipes?tags=1,2&q=` | `refreshList`, `setTagFilter`, `toggleTagFilter`, `clearTagFilter`, `searchOnce` | `toggleTagFilter` est **purement client** (état d'UI) |
| `GET /api/recipes/:id` | `loadById` | Renvoie la recette complète (lignes hydratées + tags + `photoUrl`) |
| `POST /api/recipes` / `PUT /api/recipes/:id` | `saveCurrent` | Le **buffer d'édition entier reste côté client** : `updateMeta`, `addLineById`, `removeLineByOrdinal`, `updateLineQty`, `updateLineNotes`, `updateLineUnit`, `hasUnsavedChanges` ne sont **pas** des endpoints. Un seul `PUT` avec la recette complète |
| `DELETE /api/recipes/:id` | `deleteRecipe` | + `POST /api/recipes/undo` si undo serveur |
| `GET /api/recipes/:id/derived?portions=N` | `nutritionTotalAsDict`, `nutritionPerPortionAsDict`, `nutritionPer100gAsDict`, `costInfoAsDict`, `portionWeightAsDict` | **5 slots fusionnés.** Alternative recommandée : **tout calculer côté client** (les formules sont pures, les données sont déjà dans la recette) → 0 requête. Le scaling (`setDisplayPortions`, `resetDisplayPortions`, `isScaled`, `scaleRatio`) est **100 % client** |
| `PUT /api/recipes/:id/photo` (multipart) | `setPhotoFromUrl` | Upload de fichier |
| `POST /api/recipes/:id/photo-from-url` | `setPhotoFromHttpUrl` | Corps `{url}` ; le serveur télécharge (garde-fou 20 Mo, timeout 15 s) |
| `DELETE /api/recipes/:id/photo` | `removePhoto` | |
| `PUT /api/recipes/:id/tags` | `toggleTag`, `currentTags` | Corps `{tagIds: [int]}` (remplacement complet, plus simple qu'un toggle) |
| `GET /api/recipes/:id/cooking-log` | `cookingLogAsList`, `cookedTimesThisMonth` | Renvoyer aussi `{last30DaysCount}` |
| `POST /api/recipes/:id/cooking-log` | `addCookingLog` | |
| `DELETE /api/cooking-log/:entryId` | `deleteCookingLog` | |
| `POST /api/recipes/suggest` | `findByIngredients`, `findByIngredientsCategorized` | **Doublon** : ne garder que la version catégorisée. Corps `{ingredientIds, maxMissing}` → `{ready, missing, shopping}` |

### 13.5 Calendrier

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/calendar/:week` | `setIsoWeek`, `shiftWeek`, `refreshWeek`, Property `entries` | `shiftWeek` est **purement client** (arithmétique de semaine ISO). Renvoyer entrées + descriptions pré-résolues + `days[]` (`daysAsList`) |
| `POST /api/calendar/:week/entries` | `addRecipe`, `addIngredient` | **Un seul endpoint** : `{dayOfWeek, slot, recipeId?, portions?, ingredientId?, quantityG?}` avec la contrainte XOR |
| `DELETE /api/calendar/entries/:id` | `removeEntry` | + `POST /api/calendar/entries/undo` |
| `POST /api/calendar/:week/copy-previous` | `copyPreviousWeek` | **Append**, ne vide pas. `currentWeekEntryCount` est déductible de `GET /api/calendar/:week` → pas d'endpoint dédié |
| `GET /api/calendar/:week/totals` | `dayTotalAsDict`, `weekTotalAsDict`, `weekCostAsDict` | **3 slots fusionnés** : `{week: {...}, days: [7 × {...}], cost: {total, missingPriceCount}}` |
| `GET /api/calendar/cost-history?weeks=12` | `costHistoryRecent` | ⚠ L'archivage automatique fait aujourd'hui **dans** `refresh()` doit devenir explicite (recalcul serveur, ou `POST /api/calendar/:week/snapshot`) |
| `GET /api/meal-templates` | `listTemplates` | |
| `POST /api/meal-templates` | `saveAsTemplate` | Upsert par nom. Nom vide → `400` |
| `POST /api/meal-templates/:id/apply` | `applyTemplate` | Corps `{week}` → `{applied: int}` |
| `DELETE /api/meal-templates/:id` | `deleteTemplate` | |

`calendarVM.searchOnce` (Ctrl+K) : purement client (filtre sur les entrées déjà chargées) — et de
toute façon actuellement cassé.

### 13.6 Liste de courses

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/shopping/:week` | `setIsoWeek`, `shiftWeek`, `refreshList`, Properties `items`/`totalEur`/`missingPriceCount`/`itemCount` | Chaque item porte `pieceCount`, `hasPrice`, `inPantryG`, `isCoveredByPantry` (dérivés) |
| `GET /api/shopping/:week/text` | `asText` | Ou calculer le texte côté client à partir du JSON. `copyToClipboard` reste **100 % client** |
| — | `setInFridge` | **Purement client** : état de coche non persisté, pré-alimenté par `isCoveredByPantry` |

### 13.7 Frigo / cellier

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/pantry?q=&sort=&group=` | `refreshList`, `setSortBy`, `setGroupBy`, `setFilter`, Properties `soonExpiringCount`/`totalCount` | Filtre/tri/groupement peuvent rester **côté client** (le stock est petit) — `daysUntilExpiry` et `urgencyBucket` dépendent de la date locale, donc les calculer côté client est plus juste |
| `POST /api/pantry` | `addStock` | |
| `PATCH /api/pantry/:id` | `updateStock` | **PATCH** rend explicite la sémantique « clé présente » |
| `DELETE /api/pantry/:id` | `deleteStock` | |

### 13.8 Tickets de caisse

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `POST /api/receipts/parse` (multipart) | `loadFromPath` | Renvoie un `MatchedReceipt` sérialisé (métadonnées + lignes + suggestions + `isDuplicate`) **sans rien écrire**. Le `receiptId` de session peut être un identifiant éphémère (KV) ou rien du tout si l'état vit côté client |
| `POST /api/receipts/parse-lidl-json` | `loadFromLidlJson` | Corps = JSON brut du ticket |
| — | `setLineChosenIngredient`, `toggleLineAddToPantry`, `removeLine`, `setLineQuantity`, `setLineQuantityG`, `setLineTotalPrice`, `setLineBarcode`, `setLineExpiry`, `setForceImport`, `suggestCreatePayload`, `reset` | **Tous purement client** : ce sont des mutations d'un buffer local. `suggestCreatePayload` est de la logique pure (règles §7.5) à réimplémenter en TS |
| `POST /api/ingredients/from-receipt-line` | `createIngredientFromLine` | Crée l'ingrédient **+ l'alias d'apprentissage** (`store`, `store_key`). Un `POST /api/ingredients` classique ne suffit pas : l'alias est essentiel |
| `POST /api/receipts/commit` | `commitImport` | Corps = ticket complet corrigé. Effets : N `price_history` + recalculs de prix + M `pantry_stock` + N aliases + 1 `imported_receipt`. **Doit être transactionnel.** Réponse `{success, message, priceCount, pantryCount}` |
| — | `rescanPending`, `loadNextPending`, `onWatcherDetectedFile`, `pendingFileCount` | **Sans objet** (surveillance de dossier). Remplacer par un upload |

### 13.9 Lidl Plus

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/lidl/settings` | Properties `enabled`/`pollIntervalMinutes`/`lastFetchedHuman`/`lastError`/`isConnected`/`connectedEmail`/`isAvailable` | |
| `PUT /api/lidl/settings` | `setEnabled`, `setPollIntervalMinutes` | Contrainte `minutes >= 5` conservée (mais en `400`, pas en refus silencieux) |
| `POST /api/lidl/credentials` | `storeCredentials` | **Le refresh-token ne doit jamais revenir au front.** Stockage chiffré côté Worker |
| `DELETE /api/lidl/credentials` | `purgeCredentials` | Purge + désactivation |
| `POST /api/lidl/sync` | `syncNow` | Version synchrone possible (pas de thread). Réponse `{newTicketIds, message}`. Le polling périodique devient un **Cron Trigger** |
| `GET /api/lidl/tickets/:id` | `fetchTicketDetailAsDict` | Renvoie le JSON brut à passer à `/api/receipts/parse-lidl-json` |
| — | `pendingTicketIds`, `removePendingTicketId`, `isSyncing` | **Client** (état d'UI) |

### 13.10 Import de recette par URL

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `POST /api/recipe-import/extract` | `extractFromUrl` + `_build_resolved` | Corps `{url}` → recette extraite + lignes résolues avec candidats. Peut être lent (5–10 s) → prévoir un timeout généreux, ou une file + polling |
| `GET /api/ingredients/resolve?q=` | `setLineParsedName`, `searchCandidatesForLine` (re-résolution locale) | Un seul endpoint de résolution ; le reste (mise à jour du buffer, auto-sélection du 1er candidat) est **client** |
| `GET /api/off/search?q=&limit=10` | `searchOnlineForLine` | Doublon avec §13.2 |
| `POST /api/ingredients` | `createManualForLine` | Doublon avec §13.1 (mêmes champs : `name`, `categoryL1`, `kcalPer100g`) |
| `POST /api/recipe-import/commit` | `commit` | Corps = recette résolue. Effets : promotion des ingrédients CIQUAL/OFF en bibliothèque perso, création de la recette, téléchargement **best-effort** de la photo |
| — | `goToStep0`, `goToStep1`, `reset`, `updateMeta`, `setLineQuantityG`, `setLineUnitCode`, `setLineChosenIngredient`, `ignoreLine`, `unignoreLine`, `stepIndex` | **Purement client** (machine à états du wizard) |

### 13.11 Divers

| Méthode / chemin | Remplace | Notes |
|---|---|---|
| `GET /api/tags` | `tagVM.listAll` | Prévoir aussi `POST`/`PUT`/`DELETE` — le desktop ne les a pas, c'est une lacune |
| `GET /api/categories` | `categoryVM.tree`, `flatL1`, `l2For` | **3 slots fusionnés** : renvoyer l'arbre complet, le front dérive les vues plates |
| `POST /api/categories` | `addL1`, `addL2` | **Doublon** : un seul endpoint `{name, parentId?}` |
| `PATCH /api/categories/:id` | `rename` | |
| `DELETE /api/categories/:id` | `delete` | |
| `GET /api/export` / `POST /api/import` | `backupVM.*` | Remplacement fonctionnel des sauvegardes locales |

### 13.12 Récapitulatif — doublons à fusionner

1. `searchOnce` (ingrédient) + `searchBySource` + `searchCatalogPaged` → **1** endpoint de recherche.
2. `fetchOnline` + `fetchOnlineAndList` → **1** endpoint OFF.
3. `lookupBarcodeAsDict` + étape OFF de `lookupBarcodeAndAssign` → **1** endpoint code-barres.
4. `findByIngredients` + `findByIngredientsCategorized` → **1** endpoint (garder le catégorisé).
5. Les 5 slots de dérivés de recette (`nutrition*`, `costInfo`, `portionWeight`) → **1** endpoint,
   ou **0** (calcul client).
6. `dayTotalAsDict` + `weekTotalAsDict` + `weekCostAsDict` → **1** endpoint de totaux.
7. `addRecipe` + `addIngredient` (calendrier) → **1** endpoint avec XOR.
8. `addL1` + `addL2` → **1** endpoint avec `parentId` optionnel.
9. `categoriesL1(source)` (texte libre) vs `flatL1()` (table structurée) → **à trancher**, pas
   simplement à fusionner.
10. `recipeListVM.searchOnce` + `calendarVM.searchOnce` (Ctrl+K unifié) → recherche client, ou
    **1** endpoint `GET /api/search?q=` multi-entités.

### 13.13 Ce qui doit rester purement côté client

- Tout le **buffer d'édition** de recette (`recipeEditorVM` hors `saveCurrent`/photo/tags/journal).
- Tout le **scaling de portions** (`displayPortions`, `isScaled`, `scaleRatio`, quantités affichées).
- Tout le **buffer d'import de ticket** (mutations ligne à ligne) et la **machine à états** du
  wizard d'import URL.
- Les **filtres / tri / groupement** et leur persistance (localStorage), y compris
  `activeFilterCount` et les clés de groupement (`groupKey`, `urgencyBucket`, `kcalRange`,
  `seasonStatus`, `sourceLabel`, `rayon`).
- L'état **« déjà au frigo »** de la liste de courses (`setInFridge`).
- Le **toast d'annulation** et son buffer (préférable : ne poster le `DELETE` qu'après expiration
  du toast — supprime le besoin d'un endpoint `undo`).
- `daysUntilExpiry` / `inSeasonNow` : dépendent de la **date locale** de l'utilisateur → à calculer
  côté client pour éviter les décalages de fuseau.
- Presse-papiers, navigation de semaine (arithmétique ISO), pagination visuelle, ping réseau.
