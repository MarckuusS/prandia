# Architecture : Prandia

> Memoire de travail persistante du projet. Ce fichier doit etre lu en premier pour reprendre le contexte sans relire tout le codebase.

Derniere mise a jour : 2026-05-02 (plan v2 livre — 17 propositions closes, **Frigo/Cellier** comme piece centrale)

## Etat actuel

**MVP livre + migration UI complete vers QML + 2 plans de developpement (v1 + v2) acheves**.

**342 tests passent** (`pytest tests/` — domaine + repos + services + viewmodels + list models + backup + photo + shopping + tags + history + logging + network + meal plan + pantry + cooking_log + seasonality + templates + price history + tests QML pytest-qt).

Ce qui est en place :

**Fondations** :
- Couches `domain/` `data/` `services/` `ui/` separees, dependances strictes (voir plus bas).
- Schema SQLite + FTS5 (`init_schema()`), triggers de sync `ingredient` ↔ `ingredient_fts`.
- Migrations inline idempotentes dans `db.py` (`_migrate_*` + `_seed_*` fonctions). Pas d'Alembic. Migrations actuelles : `_migrate_add_in_personal_library`, `_migrate_add_categories`, `_migrate_add_piece_weight`, `_migrate_add_meal_plan_entry_xor_check`, `_migrate_add_season_months`, plus `_seed_default_tags` + `_seed_seasonality`. Les nouvelles tables (`tag`, `recipe_tag`, `weekly_cost_snapshot`, `pantry_stock`, `meal_plan_template`, `recipe_cooking_log`, `ingredient_price_history`) sont creees idempotemment via `Base.metadata.create_all()`.
- Loader CIQUAL idempotent acceptant `.xls` / `.xlsx` / `.csv`.
- Client OpenFoodFacts `httpx` : `lookup_barcode` sur `world.openfoodfacts.org`, `search_by_name` sur `search.openfoodfacts.org`, `is_off_alive` (GET sur `/`, retourne 302 = alive — patche du HEAD initial qui recevait 405).
- Backup automatique de la DB au demarrage (rotation 7 jours + 1/mois sur 6 mois).
- Logging structure rotatif (`~/.prandia/logs/app.log`, 5 MB × 5 fichiers) + excepthook.

**Donnees & recherche enrichie** :
- Separation **bibliotheque personnelle** vs **catalogues sources** via `ingredient.in_personal_library`.
- Categories CIQUAL persistees (`category_l1`, `category_l2`).
- Conversions d'unites : `app/domain/units.py` + composant QML `QuantityField.qml`.
- **`Ingredient.piece_weight_g`** : poids unitaire d'une "piece" (1 oeuf=60g, 1 oignon=150g…).
- **`Ingredient.season_months`** (C3) : CSV de mois 1-12 ("6,7,8,9" pour ete). ~50 ingredients FR seedes via `app/data/seeds/seasons.py`. Badge "🌱 saison" + filtre "De saison uniquement" cote QML.
- **Tags** : table `tag` + jointure `recipe_tag`. 10 tags pre-seedes.
- **Historique des couts** : table `weekly_cost_snapshot`. Auto-archive a chaque refresh du calendrier.
- **Photos** : `recipe.image_path` → `~/.prandia/recipe_photos/<id>.jpg` (Pillow 1024×1024 + JPEG 85).
- **Frigo / Cellier** (F1, plan v2) : table `pantry_stock` (id, ingredient_id, quantity_g, expiry_date, notes). 5e onglet, 3 sections d'urgence, lien automatique avec liste de courses.
- **Templates de semaine NOMMES** (C1, plan v2) : table `meal_plan_template` (snapshot JSON). Save/apply/delete depuis CalendarPage.
- **Journal de cuisson** (C2, plan v2) : table `recipe_cooking_log` (recipe_id FK CASCADE, cooked_at, rating 1-5, notes). Stat "cuisinee X× ce mois" + bouton "✓ Cuisinee aujourd'hui" + dialog d'historique detache.
- **Historique des prix** (livre hors plan, fin de session) : table `ingredient_price_history` (ingredient_id FK CASCADE, price_eur, quantity_g, store, recorded_at, notes). Le prix de reference de l'ingredient (`price_eur` + `price_quantity_g`) est **auto-derive** de la plus recente entree par `recorded_at` via `pricing_history_service.recompute_current_price` ; le formulaire d'ingredient affiche les valeurs en lecture seule (cellules grisees avec icone 🔒).

**UI 100 % QML** :
- `Theme.qml` singleton : design system complet (palette, typo, espacements, animations, ombres, mode sombre).
- `Main.qml` : `ApplicationWindow` + `MenuBar` (Fichier / Affichage / Navigation / Aide) + `TabBar` 5 onglets + `StackLayout` avec fade-in subtil + status bar avec indicateur reseau OFF.
- **18 composants** reutilisables Theme-aware dans `app/ui/qml/components/`.
- **5 pages** dans `app/ui/qml/pages/` : `IngredientsPage`, `RecipesPage`, `CalendarPage`, `ShoppingPage`, **`PantryPage`** (F1).
- **9 dialogues / windows detachables** dans `app/ui/qml/dialogs/`.

**ViewModels Python** (couche pont, **9 VMs**) :
- `IngredientViewModel`, `RecipeListViewModel`, `RecipeEditorViewModel`, `CalendarViewModel`, `ShoppingViewModel`, `TagListViewModel`, `BackupViewModel`, `NetworkStatusViewModel`, **`PantryViewModel`**.
- Decores `@QmlElement` (module `App.ViewModels`), exposes en context properties.
- Listes via `QAbstractListModel` (5 modeles) avec **Property `Roles`** (R1).
- **`hasUnsavedChanges`** sur `RecipeEditorViewModel` (A3) — dirty tracking sur 5 mutations buffered (meta, lines, line qty, line notes), reset sur load + save.
- **Validateurs Pydantic enrichis** (A1) : `name` non-vide, prix > 0, quantites > 0, macros >= 0 quand renseignees, rating 1-5.

**Tests QML** (A4) :
- Fixture `qml_engine` partagee dans `conftest.py` qui instancie engine + 9 VMs + Theme singleton.
- 10 tests dans `tests/test_ui_qml.py` : smoke loads des 5 pages + Main.qml + 4 critical-path via `QSignalSpy` (collisions B4, prix recompute, hasUnsavedChanges A3, pantry stock_changed F1).

**Distribution** :
- Personnelle / Windows. Style `Basic` force au demarrage.
- Packaging PyInstaller en `.exe` autonome (`prandia.spec` + `build.bat`). `--onedir`, ~80 MB. Resolution du chemin QML via `sys._MEIPASS` quand `sys.frozen`.

## Vue d'ensemble (5 onglets + status bar)

```
+-------------------------------------------------------------------------+
| Prandia                                             |
+-------------------------------------------------------------------------+
| Fichier   Affichage   Navigation   Aide                                 |  <- MenuBar
+-------------------------------------------------------------------------+
|  Ingredients | Recettes | Calendrier | Liste de courses | Frigo/Cellier |  <- 5 onglets
+-------------------------------------------------------------------------+
|                                                                         |
|  Onglet 1 : bibliotheque des ingredients (IngredientsPage)              |
|  Onglet 2 : bibliotheque des recettes    (RecipesPage)                  |
|  Onglet 3 : planificateur hebdomadaire   (CalendarPage)                 |
|  Onglet 4 : liste de courses             (ShoppingPage)                 |
|  Onglet 5 : frigo / cellier              (PantryPage)  [F1, plan v2]    |
|                                                                         |
+-------------------------------------------------------------------------+
|                                       ● OpenFoodFacts en ligne          |  <- status bar (F10)
+-------------------------------------------------------------------------+
```

Recherche unifiee globale **Ctrl+K** (B6) : popup centre 3 sections (Ingredients / Recettes / Calendrier semaine courante), navigation flechee, Entree → bascule sur l'onglet pertinent et selectionne l'item.

## Couches (dependances strictes)

```
       +-----------+
       |    ui     |  --> imports services
       +-----------+
            |
            v
       +-----------+
       | services  |  --> imports domain + data + httpx + Pillow
       +-----------+
         /        \
        v          v
  +---------+  +---------+
  | domain  |  |  data   |  --> imports domain (pour types de retour)
  +---------+  +---------+
   pure        SQLAlchemy
```

- `domain` : Pydantic models + fonctions pures. **Zero Qt, zero SQLAlchemy.**
- `data` : ORM + repositories (split en package depuis A6 — voir plus bas). **Sans logique metier.**
- `services` : orchestre data + domain + APIs externes (OpenFoodFacts, Pillow).
- `ui` : QML + ViewModels Python (QObject) + QAbstractListModel. **Ne touche jamais data directement** ; passe par les viewmodels qui ouvrent des sessions courtes via `AppContext.session()`.

## Modules en details

### `app/domain/`

| Fichier | Contenu |
|---|---|
| `models.py` | Pydantic v2 avec **validateurs** (A1) : `Ingredient` (incl. `season_months`, `piece_weight_g`, `category_l1/l2`, `in_personal_library`), `Recipe` (avec `tags`), `RecipeLine` (`quantity_g > 0`), `MealPlanEntry` (XOR + portions/quantity > 0), `NutritionTotal`, `IsoWeek`, `Tag`, `WeeklyCostSnapshot`, `PriceHistoryEntry` (price > 0), **`PantryStock`** (`quantity_g > 0`, F1), **`CookingLogEntry`** (rating 1-5, C2), `ShoppingItem` (avec `in_pantry_g` + `is_covered_by_pantry`), `ShoppingList`. Enums : `Source` (`ciqual`/`openfoodfacts`/`manual`), `MealSlot` (5 valeurs : matin / **snack_morning** / midi / **snack_afternoon** / soir, B3). |
| `nutrition.py` | `aggregate_recipe(lines, default_portions) -> NutritionTotal`. |
| `pricing.py` | `recipe_cost(recipe) -> Decimal`, `recipe_cost_per_portion(recipe) -> Decimal`. |
| `units.py` | Table `UNITS` + `to_grams()` / `from_grams()`. |
| `shopping.py` | `ShoppingItem` (avec `in_pantry_g` champ + `is_covered_by_pantry` property F1), `ShoppingList`. |

### `app/data/`

| Fichier | Contenu |
|---|---|
| `db.py` | Engine + factory + `init_schema()`. Backup au demarrage. Migrations inline + seeders (default tags + seasonality). |
| `orm.py` | Tables : `IngredientRow` (avec `season_months`), `RecipeRow`, `RecipeIngredientRow`, `MealPlanEntryRow` (CHECK XOR), `TagRow`, `RecipeTagRow`, `WeeklyCostSnapshotRow`, `IngredientPriceHistoryRow`, **`PantryStockRow`**, **`MealPlanTemplateRow`**, **`RecipeCookingLogRow`**. |
| `repositories/` (package — split A6) | `__init__.py` re-exporte tous les noms publics ; `_search.py` (SearchFilters/Options/Page) ; `_mappers.py` (ORM↔Pydantic helpers, prive) ; `ingredient.py`, `recipe.py`, `tag.py`, `meal_plan.py`, `weekly_cost.py`, `price_history.py`, **`pantry.py`**, **`cooking_log.py`**. |
| `seeds/ciqual_loader.py` | Loader auto-detectant `.xls` / `.xlsx` / `.csv`. Idempotent. |
| `seeds/seasons.py` | **C3**. Dict `SEASONS_BY_NAME` ~50 ingredients FR (tomate 6-10, courge 9-1, fraise 4-7, ail 6-2…). |

#### Repositories — façade et organisation (A6)

`from app.data.repositories import IngredientRepo, RecipeRepo, ...` continue de fonctionner — le package re-exporte via `__init__.py`. Decoupage interne :

| Fichier | Repo / Helper |
|---|---|
| `_search.py` | `SearchFilters`, `SearchOptions`, `SearchPage`, `SortField` |
| `_mappers.py` | `_ing_to_domain`, `_ing_apply`, `_recipe_to_domain`, `_tag_to_domain`, `_entry_to_domain`, `_cost_to_domain`, `_price_to_domain` |
| `ingredient.py` | `IngredientRepo` (CRUD + `find_by_name` casefold pour B4 + `list_by_ids` pour B2 + `search_fts` rich) |
| `recipe.py` | `RecipeRepo` (CRUD + `list_by_ids` pour B2 + `find_by_ingredient_ids` pour F5 + `_replace_tags`) |
| `tag.py` | `TagRepo` (CRUD + `expire_all` post-delete) |
| `meal_plan.py` | `MealPlanRepo` |
| `weekly_cost.py` | `WeeklyCostRepo` (upsert) |
| `price_history.py` | `PriceHistoryRepo` (append-only + `latest_for_ingredient` + `list_known_stores`) |
| `pantry.py` | **`PantryRepo`** (CRUD + `aggregate_quantity_by_ingredient` pour shopping link, F1) |
| `cooking_log.py` | **`CookingLogRepo`** (CRUD + `count_in_window(days=30)`, C2) |

### `app/services/`

| Fichier | Contenu |
|---|---|
| `openfoodfacts.py` | `lookup_barcode(ean)`, `search_by_name(...)`, **`is_off_alive(timeout=3.0)`** (GET sur `/`, accepte 302 redirect — fix du HEAD initial qui recevait 405). |
| `ingredient_search.py` | `search_local`, `search_local_page`, `list_local_categories`, `fetch_from_openfoodfacts_and_cache`, `promote_to_personal_library`. |
| `nutrition_service.py` | Aggregation depuis IDs : `recipe_id` ou `iso_week`. |
| `shopping_service.py` | **F1**. `aggregate_shopping_list(s, iso_week)` regroupe par `category_l1`, **fix N+1 (B2) via `RecipeRepo.list_by_ids` + `IngredientRepo.list_by_ids` + `PantryRepo.aggregate_quantity_by_ingredient`** — ~3 queries au lieu de N+1. Stamp `in_pantry_g` sur chaque `ShoppingItem` pour la pre-coche "deja au frigo". `format_as_text(list) -> str`. |
| `meal_plan_service.py` | **F7 + C1**. `previous_iso_week`, `copy_week`, `copy_previous_week`. **C1** : `save_as_template(s, src_week, name)`, `apply_template(s, template_id, dst_week)`, `list_templates(s)`, `delete_template(s, id)`. Snapshot stocke en JSON dans `meal_plan_template.snapshot_json`. |
| `photo_service.py` | **F6**. `save_recipe_photo` (Pillow EXIF + thumbnail + JPEG 85), `delete_recipe_photo`, `absolute_photo_path` (avec **A2** : log warning quand fichier manquant, retourne None). |
| `pricing_history_service.py` | **Auto-derivation prix**. `recompute_current_price(s, ingredient_id)` : met a jour `ingredient.price_eur` + `price_quantity_g` depuis la plus recente entree de `ingredient_price_history` (ou NULL si historique vide). Appele par `IngredientViewModel.addPriceHistory` / `deletePriceHistory`. |

### `app/`

| Fichier | Contenu |
|---|---|
| `main.py` | Bootstrap : logging FIRST, QApplication, force `Basic` style, backup_on_startup, AppContext, registration Theme singleton, instanciation des **9 VMs** en context properties (incl. `pantryVM`), load Main.qml. **`_resolve_qml_dir`** gere `sys._MEIPASS` pour PyInstaller. |
| `logging_setup.py` | **D2**. `setup_logging(log_dir=None)` (RotatingFileHandler 5MB×5, console DEBUG si `PRANDIA_DEBUG=1`), `install_excepthook()`, `default_log_dir()`. |

### `app/ui/`

```
app/ui/
├── app_context.py              # AppContext : engine + session factory
├── viewmodels/                 # 9 Python QObject avec @QmlElement + @Slot
│   ├── ingredient_vm.py        # IngredientViewModel (+ price history slots, B4 collision, B1 importMany)
│   ├── recipe_vm.py            # RecipeListViewModel (+ B6 searchOnce) + RecipeEditorViewModel (A3 dirty tracking, C2 cooking log)
│   ├── calendar_vm.py          # CalendarViewModel (+ C1 templates, B6 searchOnce sur entries semaine courante)
│   ├── shopping_vm.py          # ShoppingViewModel (F1)
│   ├── tag_vm.py               # TagListViewModel (F4)
│   ├── backup_vm.py            # BackupViewModel (F3)
│   ├── network_vm.py           # NetworkStatusViewModel (F10)
│   └── pantry_vm.py            # PantryViewModel (F1, plan v2)
├── models/                     # 5 QAbstractListModel pontant Pydantic <-> QML
│   ├── ingredient_list_model.py    # + InSeasonNowRole (C3)
│   ├── recipe_list_model.py        # + PhotoUrlRole (file:// URL)
│   ├── meal_plan_model.py
│   ├── shopping_list_model.py      # + InPantryGRole + IsCoveredRole (F1) ; auto-seed inFridge depuis is_covered_by_pantry
│   └── pantry_list_model.py        # F1 (avec PantryRow denormalise + UrgencyBucketRole "soon"/"watch"/"stock")
└── qml/                        # 100 % du rendu UI
    ├── Theme.qml               # singleton design system
    ├── Main.qml                # ApplicationWindow + MenuBar + TabBar 5 onglets + StackLayout + status bar + Ctrl+K
    ├── components/             # 18 composants Theme-aware
    ├── pages/                  # 5 pages metier
    └── dialogs/                # 9 fenetres detachables / dialogs
```

#### ViewModels (`app/ui/viewmodels/`)

| Fichier | Classe | Role + slots cles |
|---|---|---|
| `ingredient_vm.py` | `IngredientViewModel` | Liste filtree, search*, save/delete. **U3** undo. **B4** collision via signal `name_collision_detected(existing_id, name)` (casefold pour Œ↔œ). **B1** `importMany([ids])`. **Price history** : `priceHistoryFor`, `addPriceHistory`, `deletePriceHistory`, `knownStores` + signal `current_price_recomputed(ingredient_id)`. |
| `recipe_vm.py` | `RecipeListViewModel` | CRUD recettes. Filtre tags. **F5** `findByIngredients`. **B6** `searchOnce(q, limit)` recettes par nom (casefold). Undo. |
| `recipe_vm.py` | `RecipeEditorViewModel` | Buffer d'edition + agregations. **F2** scaling. **F6** photos. **F4** tags. **A3 hasUnsavedChanges Property** + `unsaved_changed` signal + dirty tracking sur `update_meta`/`add_line`/`remove_line`/`update_line_qty`/`update_line_notes`. **B5** : `linesAsList` pre-trie par `(category_l1, ordinal)` pour rendre les section headers QML. **C2** : `cookingLogAsList`, `cookedTimesThisMonth`, `addCookingLog`, `deleteCookingLog`. Undo. |
| `calendar_vm.py` | `CalendarViewModel` | iso_week courant + entrees + agregats. **F7** `copyPreviousWeek`. **C1** `saveAsTemplate`, `applyTemplate`, `listTemplates`, `deleteTemplate`. **F9** `costHistoryRecent` + auto-archive. **B6** `searchOnce(q, limit)` sur les entries de la semaine. Undo. |
| `shopping_vm.py` | `ShoppingViewModel` | **F1**. iso_week independant. `setIsoWeek`, `shiftWeek`, `asText`, `copyToClipboard`. |
| `tag_vm.py` | `TagListViewModel` | **F4**. `listAll() -> [{id, name, colorHex}]`. |
| `backup_vm.py` | `BackupViewModel` | **F3**. `listBackups`, `restoreFromPath`, `backupDirectory`. |
| `network_vm.py` | `NetworkStatusViewModel` | **F10**. Optimistic online au boot, ping daemon thread non bloquant. |
| `pantry_vm.py` | **`PantryViewModel`** (F1) | Owns `PantryListModel`. Slots `addStock`/`updateStock`/`deleteStock`. Signals `stock_changed` (broadcast aux pages dependantes). Properties `soonExpiringCount`, `totalCount`. |

#### List models (`app/ui/models/`)

Pattern : dispatch dict + Property `Roles` (QVariantMap nom→id).

| Fichier | Classe | Roles principaux |
|---|---|---|
| `ingredient_list_model.py` | `IngredientListModel` | Standard + **`InSeasonNowRole`** (C3, calcule via `season_months` CSV vs mois courant). |
| `recipe_list_model.py` | `RecipeListModel` | Standard + `PhotoUrlRole` (file:// absolu, retourne `""` si fichier manquant — A2). |
| `meal_plan_model.py` | `MealPlanModel` | Standard + `DescriptionRole` pre-resolue. |
| `shopping_list_model.py` | `ShoppingListModel` | Standard + `InFridgeRole` mutable (auto-seed depuis `is_covered_by_pantry` F1) + `InPantryGRole` + `IsCoveredRole`. |
| **`pantry_list_model.py`** | **`PantryListModel`** (F1) | `stockId`, `ingredientId`, `name`, `quantityG`, `expiryIso`, `daysUntilExpiry`, `notes`, `categoryL1`, `pieceWeightG`, `source`, **`UrgencyBucketRole`** ("soon" ≤5j / "watch" ≤14j / "stock"). |

#### QML — composants partages (`app/ui/qml/components/`)

| Fichier | Role |
|---|---|
| `AppButton.qml` | 4 variantes : primary / secondary / ghost / danger. |
| `AppTabButton.qml` | Onglet stylise. |
| `AppTextField.qml` | Champ texte avec focus glow. |
| `AppComboBox.qml` | Liste deroulante (3 modes de delegate). |
| `AppSpinBox.qml` | SpinBox decimal. `emptyOnZero` rendu vide. |
| `AppCheckBox.qml` | Coche dessinee au Canvas. |
| `AppScrollBar.qml` | Fine, fade au survol. |
| `AppListItem.qml` | Delegue ListView avec barre selection. |
| `AppDialog.qml` | Dialog modal in-window. |
| **`AppConfirmDialog.qml`** (A3) | Reutilisable. 2 modes : `save` (3 boutons Annuler/Sauver/Abandonner pour modifs non sauvees) ou `destroy` (2 boutons Annuler/Confirmer pour suppression). Utilise par RecipesPage (A3), CalendarPage (C1 apply template), PantryPage (F1 supprimer stock). |
| `AppPopup.qml` | Popup leger non-modal pour autocomplete. |
| `AppMenu.qml` | Wrapper `Menu` + delegate stylise. |
| `FixedUnitField.qml` | Spinbox + cellule unite figee. |
| `QuantityField.qml` | Piece-aware. Unite "piece (Xg)" en tete si `pieceWeightG > 0`. |
| `IngredientSearch.qml` | Picker live + popup suggestions, debounce 200 ms. |
| `NutritionPanel.qml` | 4 chips colorees. |
| `MealSlot.qml` | Cellule du calendrier. **DropArea (U2)** + signal `ingredientDropped`. |
| `UndoToast.qml` | **U3**. Toast 5s avec bouton Annuler. |
| `DraggableIngredientChip.qml` | **U2**. Chip draggable. |
| **`DatePickerPopup.qml`** | Mini-calendrier custom (Qt.labs.calendar non dispo dans cette PySide6). Header `‹ Mai 2026 ›` + grille 6×7 + footer Aujourd'hui/Fermer. Semaine commence lundi. Clic ext. ferme. PageUp/Down navigue ±1 mois. Utilise par `PriceHistoryDialog`, `AddPantryStockDialog`, `CookingHistoryDialog`. |
| **`RecipePhotoBlock.qml`** (A7) | Extrait de RecipesPage : zone photo 300×200 + boutons Ajouter/Modifier/Retirer + FileDialog interne + placeholder "🍽 Aucune photo / Photo introuvable" (A2 fallback Image.Error). |
| **`RecipeTagsChips.qml`** (A7) | Extrait de RecipesPage : Flow de chips toggle pour les tags (F4). |

#### QML — pages (`app/ui/qml/pages/`)

| Fichier | Layout | VM consume |
|---|---|---|
| `IngredientsPage.qml` | SplitView. Recherche + filtre **🌱 De saison uniquement** (C3) + Importer + multi-select F5. Liste a gauche avec badges source/saison. Formulaire a droite : 16 champs metier. **Cellules Prix + Quantite de ref. en lecture seule** (icone 🔒) — auto-derivees de l'historique des prix. Bouton "📊 Historique" ouvre `PriceHistoryDialog`. Raccourcis Ctrl+N/S/Delete/F. UndoToast + collision dialog (B4) + recipe match dialog (F5). | `ingredientVM`, `recipeListVM` |
| `RecipesPage.qml` | SplitView. Liste recettes (vignettes 64×64 avec fallback A2). Editeur a droite : `RecipePhotoBlock` (A7) + `RecipeTagsChips` (A7) + meta + scaling spinner F2 + picker IngredientSearch + table de lignes **groupees par rayon B5** (section headers) + nutrition/cout panneaux + **bandeau journal C2** ("Cuisinee X× ce mois" + bouton "✓ Cuisinee aujourd'hui" + "Voir l'historique"). **A3** intercepte les changements de selection / bouton Nouveau via `unsavedConfirm` AppConfirmDialog quand `recipeEditorVM.hasUnsavedChanges`. Raccourcis Ctrl+N/S/Delete. ~934 lignes (1068 avant A7). | `recipeListVM` + `recipeEditorVM` + `tagVM` |
| `CalendarPage.qml` | Navigation prev/today/next + bouton "📋 Copier la semaine precedente" (F7) + **bouton "📁 Templates ▾" (C1) + "💾 Sauver semaine" (C1)** + toggle "🗂️ Drag-drop" U2 + grille 7×N (5 slots si snacks B3) + cout + mini-graph F9 + panneau lateral drag U2. Raccourcis Ctrl+Left/Right/T. | `calendarVM`, `ingredientVM` |
| `ShoppingPage.qml` | **F1**. Selecteur semaine + sections par categoryL1 + checkbox **"deja au frigo" auto-cochee** quand pantry stock ≥ requirement + footer total + "📋 Copier". | `shoppingVM` |
| **`PantryPage.qml`** (F1) | Header avec badge "X articles · ⚠️ Y a consommer rapidement". Liste avec sections derivees de `urgencyBucket` ("🔥 A consommer vite ≤5j" / "⏳ A surveiller ≤14j" / "🥫 En stock"). Pastille couleur par urgence + qte formatee + jours restants. Action ✕ (avec AppConfirmDialog destroy mode). Empty state. | `pantryVM`, `shoppingVM` (refresh apres add/delete) |

#### QML — dialogues / windows detachables (`app/ui/qml/dialogs/`)

Vraies fenetres systeme (`QtQuick.Window`) sauf dialogs in-window (`AppDialog`-based). 9 dialogues au total.

| Fichier | Trigger | Contenu |
|---|---|---|
| `ImportIngredientDialog.qml` | Bouton "Importer" sur IngredientsPage | **F8** : 2 onglets (CIQUAL Rich + OFF Simple). **B1** : checkbox sur chaque resultat + footer "✓ N selectionnes / Selectionner la page / + Importer (N)" — anime hauteur. |
| `AddCalendarEntryDialog.qml` | Clic sur un MealSlot | TabBar Recette/Ingredient + QuantityField piece-aware. |
| `RecipeMatchDialog.qml` | "Trouve-moi des recettes" sur IngredientsPage (F5) | Liste de recettes avec score bars colores. |
| `RestoreBackupDialog.qml` | Menu Fichier → Restaurer une sauvegarde | Liste backups + Restaurer. |
| `ShortcutsDialog.qml` | Menu Aide → Raccourcis (Ctrl+/) | **U1**. Cheat sheet — incl. Ctrl+5 (Frigo), **Ctrl+K** (recherche unifiee). |
| **`PriceHistoryDialog.qml`** | Bouton "📊 Historique" sur IngredientsPage | Form d'ajout (date + enseigne + quantite + prix + notes) + graphique Canvas (€/100g sur axe temporel + ligne moyenne + tooltip au survol) + tableau chronologique inverse + ✕ par ligne. Auto-recompute le prix de reference de l'ingredient apres add/delete. |
| **`AddPantryStockDialog.qml`** (F1) | Bouton "+ Ajouter au stock" sur PantryPage | Form : picker IngredientSearch + QuantityField + DatePickerPopup pour peremption + notes. |
| **`CookingHistoryDialog.qml`** (C2) | Bouton "Voir l'historique" sur RecipesPage | Form (date + ★ rating 0-5 + notes) + tableau chronologique inverse avec ✕ par ligne. |
| **`UnifiedSearchDialog.qml`** (B6) | Ctrl+K depuis n'importe ou | Popup centre. Champ debounce 200ms → 3 sections (🥕 Ingredients / 🍽 Recettes / 📅 Calendrier semaine courante). Navigation ↑↓ Entree Esc. Signal `itemActivated(kind, payload)` → bascule sur l'onglet pertinent + selectionne. |

## Schema de base de donnees

```sql
ingredient (
  id PK, name, source ('ciqual'|'openfoodfacts'|'manual'), source_ref,
  kcal_per_100g, proteins_g, carbs_g, sugars_g,
  fats_g, saturated_fats_g, fiber_g, salt_g,
  price_eur, price_quantity_g,             -- AUTO-DERIVES depuis ingredient_price_history
  in_personal_library  INTEGER NOT NULL DEFAULT 0,
  category_l1 TEXT, category_l2 TEXT,
  piece_weight_g REAL,
  season_months VARCHAR(50),               -- C3 — CSV "6,7,8,9"
  created_at, updated_at,
  UNIQUE (source, source_ref)
)
ingredient_fts (FTS5 virtual, content='ingredient', tokenize='unicode61 remove_diacritics 2')

recipe (
  id PK, name, instructions, default_portions,
  image_path,           -- chemin relatif vers ~/.prandia/recipe_photos/<id>.jpg
  created_at, updated_at
)

recipe_ingredient (
  recipe_id FK, ingredient_id FK, ordinal,
  quantity_g, notes,
  PK (recipe_id, ingredient_id, ordinal)
)

meal_plan_entry (
  id PK, iso_week, day_of_week (0..6), slot ('morning'|'snack_morning'|'noon'|'snack_afternoon'|'evening'),
  recipe_id FK NULL, ingredient_id FK NULL,
  quantity_g, portions, ordinal,
  CHECK ((recipe_id IS NOT NULL) <> (ingredient_id IS NOT NULL))   -- A5
)

-- F4
tag (id PK, name UNIQUE, color_hex)
recipe_tag (recipe_id FK, tag_id FK, PK)

-- F9
weekly_cost_snapshot (iso_week PK, total_eur, missing_count, captured_at)

-- Historique des prix (auto-derive le prix de reference de l'ingredient)
ingredient_price_history (
  id PK, ingredient_id FK CASCADE, price_eur, quantity_g,
  store, recorded_at, notes, created_at,
  INDEX (ingredient_id, recorded_at)
)

-- F1, plan v2
pantry_stock (
  id PK, ingredient_id FK CASCADE, quantity_g, expiry_date,
  notes, added_at, updated_at,
  INDEX (ingredient_id), INDEX (expiry_date)
)

-- C1, plan v2 — snapshot JSON, pas de FK aux entries
meal_plan_template (
  id PK, name UNIQUE, snapshot_json TEXT, created_at, updated_at
)

-- C2, plan v2
recipe_cooking_log (
  id PK, recipe_id FK CASCADE, cooked_at, rating (1-5 NULL), notes,
  INDEX (recipe_id, cooked_at)
)
```

**Migrations inline** (`db.py`, lancees par `init_schema()`) :
1. `_migrate_add_in_personal_library` (ALTER + UPDATE auto-promote manuel/OFF).
2. `_migrate_add_categories` (ALTER pour `category_l1`, `category_l2`).
3. `_migrate_add_piece_weight` (ALTER pour `piece_weight_g`).
4. `_migrate_add_meal_plan_entry_xor_check` (recreate table avec CHECK XOR pour les vieilles DBs ; idempotent — no-op si deja contraint).
5. `_migrate_add_season_months` (ALTER pour `season_months`).
6. `_seed_default_tags` (INSERT OR IGNORE des 10 tags).
7. `_seed_seasonality` (UPDATE WHERE NULL — respecte les overrides utilisateur).

Les autres tables (`tag`, `recipe_tag`, `weekly_cost_snapshot`, `ingredient_price_history`, `pantry_stock`, `meal_plan_template`, `recipe_cooking_log`) sont creees idempotemment via `Base.metadata.create_all(engine)` (pas de migration explicite necessaire).

## Bootstrap (`app/main.py`)

```python
setup_logging()                              # FIRST — capture les erreurs de bootstrap
install_excepthook()
QQuickStyle.setStyle("Basic")                # CRUCIAL : sinon FluentWinUI3 bloque les overrides
qt_app = QApplication(sys.argv)
backup_on_startup()                          # snapshot DB rotatif (non-fatal)
ctx = AppContext.from_default()              # engine + init_schema (migrations + seeds)

engine = QQmlApplicationEngine()
engine.addImportPath(str(_QML_DIR))
qmlRegisterSingletonType(theme_url, "App", 1, 0, "Theme")

# Instanciation Python des 9 viewmodels + exposition en context properties
ingredient_vm = IngredientViewModel(ctx)
recipe_list_vm = RecipeListViewModel(ctx)
recipe_editor_vm = RecipeEditorViewModel(ctx)
calendar_vm = CalendarViewModel(ctx)
shopping_vm = ShoppingViewModel(ctx)
tag_vm = TagListViewModel(ctx)
backup_vm = BackupViewModel()
network_vm = NetworkStatusViewModel()
pantry_vm = PantryViewModel(ctx)             # F1 plan v2
# ... setContextProperty pour chaque + logDirPath

engine.load(_QML_DIR / "Main.qml")
qt_app.exec()
```

**`_resolve_qml_dir`** : retourne `sys._MEIPASS / "app/ui/qml/"` quand `sys.frozen`, sinon `Path(__file__).parent / "ui/qml/"`.

## Flux de donnees principaux

### Liste de courses + auto-coche frigo (F1 + B2)

```
User ouvre l'onglet "Liste de courses"
  → ShoppingPage charge → shoppingVM.refresh()
  → shopping_service.aggregate_shopping_list(s, iso_week)
      → MealPlanRepo.list_by_week(iso_week)
      → recipe_ids = collect distinct → RecipeRepo.list_by_ids(...)   [B2: 1 query]
      → walk entries + recipe lines → bucket qty_by_ingredient
      → IngredientRepo.list_by_ids(qty_by_ingredient.keys())          [B2: 1 query]
      → PantryRepo.aggregate_quantity_by_ingredient()                 [F1: 1 query]
      → Pour chaque bucket : compute cost via pricing.ingredient_cost
        + stamp `in_pantry_g = pantry_totals.get(ing_id, 0)`
        + ShoppingItem.is_covered_by_pantry computed property
  → ShoppingListModel.set_items(items) — auto-seed `_in_fridge` depuis is_covered_by_pantry
  → ShoppingPage rend 3 ou 4 SELECTs au total au lieu de N+1
  → Les yaourts dont stock=480g et requis=200g sont coches automatiquement
```

### Drag & drop ingredient → calendrier (U2)

```
User clique "🗂️ Drag-drop" → side panel s'ouvre
  → Repeater de DraggableIngredientChip (cherche via ingredientVM.searchOnce ou items.Roles)
User drag chip vers MealSlot
  → DropArea.onDropped → drop.source.ingredientId + pieceWeightG
  → quantityG = pieceWeightG > 0 ? pieceWeightG : 100.0
  → calendarVM.addIngredient(day, slot, ingId, qty)
```

### Templates de semaine (C1)

```
User configure une semaine → bouton "💾 Sauver semaine"
  → AppDialog "Donne un nom..."
  → calendarVM.saveAsTemplate("Menu hiver")
      → meal_plan_service.save_as_template(s, iso_week, name)
        → MealPlanRepo.list_by_week(iso_week)
        → snapshot = json.dumps([_entry_to_snapshot_dict(e) for e in entries])
        → INSERT OR UPDATE meal_plan_template (idempotent par name UNIQUE)

User change de semaine → "📁 Templates ▾"
  → templatesPopup avec liste cliquable
  → confirm dialog si semaine non-vide
  → calendarVM.applyTemplate(template_id)
      → meal_plan_service.apply_template(s, template_id, target_iso_week)
        → snapshot = json.loads(...)
        → for d in snapshot : MealPlanRepo.add(_snapshot_to_entry(d, target_iso_week))
```

### Journal de cuisson (C2)

```
User edite Chili → bandeau "Cuisinee 0× ce mois" + boutons
  → "✓ Cuisinee aujourd'hui" → recipeEditorVM.addCookingLog({cookedAtIso=today, rating=0, notes=""})
  → page._refreshCookingStats() → "Cuisinee 1× ce mois"
  → cookingToast "✓ Cuisinee aujourd'hui — bon appetit !"

User clique "Voir l'historique" → CookingHistoryDialog
  → form complet (date + rating ★0-5 + notes)
  → tableau chronologique inverse, supprimable par ligne
```

### Saisonnalite (C3)

```
init_schema() au demarrage
  → _migrate_add_season_months : ALTER TABLE si colonne absente
  → _seed_seasonality : UPDATE WHERE season_months IS NULL → idempotent
                        respecte les overrides utilisateur

QML render IngredientsPage
  → IngredientListModel.data(idx, InSeasonNowRole)
      → datetime.now().month in parse(ing.season_months)
  → Si vrai : Rectangle "🌱 saison" avec couleur success
  → Si toggle "🌱 De saison uniquement" coche : visible: model.inSeasonNow === true
```

### Recherche unifiee Ctrl+K (B6)

```
Ctrl+K depuis n'importe quel onglet
  → unifiedSearch.openCentered()
  → focus sur le champ
User tape "tomat"
  → debounce 200 ms
  → root._runSearch() :
      → ingredientVM.searchOnce("tomat", "personal", 12)  [FTS5]
      → recipeListVM.searchOnce("tomat", 12)              [walk + casefold filter]
      → calendarVM.searchOnce("tomat", 12)                [walk current week entries]
  → flat list avec section headers
  → ↑↓ navigue, Entree → itemActivated(kind, payload)
  → Main.qml bascule sur l'onglet pertinent + selectionne
```

### Auto-derivation prix depuis historique

```
User ouvre PriceHistoryDialog (bouton "📊 Historique" sur IngredientsPage)
  → form date + enseigne + quantite + prix → "+ Ajouter"
  → ingredientVM.addPriceHistory(payload)
      → PriceHistoryRepo.add(entry)
      → pricing_history_service.recompute_current_price(s, ingredient_id)
          → entry = PriceHistoryRepo.latest_for_ingredient(id)  # par recorded_at DESC
          → ing.price_eur = entry.price_eur
          → ing.price_quantity_g = entry.quantity_g
          → IngredientRepo.update(ing)
      → s.commit()
      → vm.refresh() + emit current_price_recomputed(ingredient_id)

QML IngredientsPage
  → Connection on ingredientVM.current_price_recomputed
  → si page.selectedId == ingredient_id : refresh priceDisplay + priceQtyDisplay (read-only)

Suppression de la plus recente observation
  → recompute fait fallback sur la 2e plus recente
  → ou clear (NULL) si historique vide
```

## QML migration history

La migration QtWidgets → QML a ete realisee en 4 phases en mai 2026 puis suivie de **deux plans de developpement** :

**Plan v1 — 18 propositions (mai 2026)** : F1-F10 + U1-U3 + R1 + T1 + D1-D2.

**Plan v2 — 17 propositions (mai 2026, en cours puis livre)** : F1 chantier central Frigo/Cellier + A1-A7 robustesse/refactor + B1-B6 productivite + C1-C3 nouvelles fonctionnalites.

**Decisions revues en cours de migration** :
- *Theme via context property* → rejete : ne se propage pas dans MenuBar/Popup/Window. Bascule sur `qmlRegisterSingletonType` + `pragma Singleton`.
- *FluentWinUI3 par defaut* → rejete : interdit la customization. Force `Basic`.
- *Dialog in-window* → rejete pour Import/AddCalendar/PriceHistory/AddPantry/CookingHistory : limite l'utilisateur. Bascule sur vraies `Window` systeme.

## Plan v2 — Recapitulatif des livraisons (mai 2026)

### Phase 1 — Fondations rapides (livree)

| # | Proposition | Fichiers principaux |
|---|---|---|
| A1 | Validateurs Pydantic enrichis | `app/domain/models.py` (toutes les classes) |
| A2 | Image fallback (placeholder + Image.Error binding) | `app/services/photo_service.py` (log warning), `app/ui/models/recipe_list_model.py`, `RecipesPage.qml` + `RecipePhotoBlock.qml` |
| A5 | CHECK SQL XOR sur meal_plan_entry | `app/data/orm.py`, `app/data/db.py` (`_migrate_add_meal_plan_entry_xor_check`) |
| B2 | Fix N+1 dans shopping_service | `app/services/shopping_service.py`, `app/data/repositories/{ingredient,recipe}.py` (`list_by_ids`) |
| B4 | Validation unicite du nom (casefold pour Œ/œ) | `app/data/repositories/ingredient.py` (`find_by_name`), `app/ui/viewmodels/ingredient_vm.py` (signal `name_collision_detected`), `IngredientsPage.qml` (collisionDialog) |
| A6 | Splitting repositories.py → package | `app/data/repositories/{__init__,_search,_mappers,ingredient,recipe,tag,meal_plan,weekly_cost,price_history,pantry,cooking_log}.py` |

### Phase 2 — Frigo/Cellier + confort (livree)

| # | Proposition | Fichiers principaux |
|---|---|---|
| **F1** | **Onglet Frigo / Cellier** (chantier central) | `app/data/orm.py:PantryStockRow`, `app/data/repositories/pantry.py`, `app/ui/viewmodels/pantry_vm.py`, `app/ui/models/pantry_list_model.py`, `app/ui/qml/pages/PantryPage.qml`, `app/ui/qml/dialogs/AddPantryStockDialog.qml`, integration `shopping_service.aggregate_shopping_list` (auto-coche frigo). |
| B1 | Multi-import dans ImportIngredientDialog | `app/ui/viewmodels/ingredient_vm.py:importMany`, `ImportIngredientDialog.qml` (checkbox + bandeau N selectionnes) |
| A3 | AppConfirmDialog reutilisable + hasUnsavedChanges | `app/ui/qml/components/AppConfirmDialog.qml`, `app/ui/viewmodels/recipe_vm.py:RecipeEditorViewModel.hasUnsavedChanges`, RecipesPage.qml (interception load/new) |
| B3 | Slots calendrier flexibles (snacks 10h/16h) | `app/domain/models.py:MealSlot` enum (5 valeurs), `CalendarPage.qml` (showSnacks toggle + auto-render si entree existe), `Main.qml` (menu Affichage) |

### Phase 3 — Fonctionnalites plaisir + structure (livree)

| # | Proposition | Fichiers principaux |
|---|---|---|
| A7 | Refactor RecipesPage.qml en sous-composants | `app/ui/qml/components/RecipePhotoBlock.qml`, `RecipeTagsChips.qml` (page 1068 → 934 lignes) |
| A4 | Tests QML pytest-qt | fixture `qml_engine` dans `tests/conftest.py`, `tests/test_ui_qml.py` (10 tests : smoke loads + critical paths via QSignalSpy) |
| B5 | Tri auto des lignes par rayon | `app/ui/viewmodels/recipe_vm.py:linesAsList` (sort par `(category_l1, ordinal)`), `RecipesPage.qml` (section headers "▸ FRUITS, LEGUMES") |
| C1 | Templates de semaine NOMMES | `app/data/orm.py:MealPlanTemplateRow`, `app/services/meal_plan_service.py` (save/apply/list/delete), `CalendarPage.qml` (📁 Templates ▾ popup + 💾 Sauver semaine dialog) |
| C2 | Journal de cuisson | `app/domain/models.py:CookingLogEntry`, `app/data/orm.py:RecipeCookingLogRow`, `app/data/repositories/cooking_log.py`, slots VM, `RecipesPage.qml` bandeau + `CookingHistoryDialog.qml` |
| C3 | Saisonnalite | `app/data/orm.py:season_months`, `app/data/db.py:_migrate_add_season_months` + `_seed_seasonality`, `app/data/seeds/seasons.py` (~50 ingredients FR), `IngredientListModel.InSeasonNowRole`, badge + filtre cote `IngredientsPage.qml` |
| B6 | Recherche unifiee Ctrl+K | `RecipeListViewModel.searchOnce`, `CalendarViewModel.searchOnce`, `app/ui/qml/dialogs/UnifiedSearchDialog.qml`, Shortcut + handler dans `Main.qml` |

### Hors plan : historique des prix par ingredient (livre fin de session, avant plan v2)

| Composant | Detail |
|---|---|
| Domain | `PriceHistoryEntry` Pydantic avec `price > 0` validate. |
| ORM | `IngredientPriceHistoryRow` (FK CASCADE, INDEX `(ingredient_id, recorded_at)`). |
| Service | `pricing_history_service.recompute_current_price(s, ingredient_id)` — auto-met-a-jour `ingredient.price_eur` + `price_quantity_g` depuis la plus recente entree. |
| VM | `IngredientViewModel.priceHistoryFor`/`addPriceHistory`/`deletePriceHistory`/`knownStores` + signal `current_price_recomputed`. |
| UI | `PriceHistoryDialog.qml` (Window detachable avec form + graphique Canvas €/100g + tableau). `IngredientsPage.qml` : cellules Prix + Qty de ref. en lecture seule grisees (icone 🔒). |
| Bonus | `DatePickerPopup.qml` mini-calendrier reutilisable (utilise par PriceHistory + AddPantry + CookingHistory). |

## Decisions techniques notables

- **SQLite + FTS5 plutot qu'un index custom Python**.
- **Pydantic + SQLAlchemy en parallele plutot que SQLModel**.
- **httpx sync + thread pour les pings F10**. `is_off_alive` utilise GET (pas HEAD — l'OFF Search-a-licious renvoyait 405 sur HEAD).
- **Migrations inline plutot qu'Alembic** : suffit tant que pas de renames/drops complexes.
- **iso_week au lieu de start_date** : survit DST, indexe bien.
- **`in_personal_library` plutot que tables separees** : un flag, une table.
- **OFF Search-a-licious vs API legacy**.
- **QML plutot que QtWidgets** : design system declaratif, animations natives.
- **`piece_weight_g` plutot qu'une table `unit_per_ingredient`** : float nullable.
- **`QAbstractListModel` (composition)** plutot qu'heritage.
- **Decimal → str au boundary VM/QML**.
- **Roles via Property("QVariantMap")** (R1) plutot que Q_ENUM.
- **U2 : panneau lateral dans CalendarPage** plutot que cross-tab drag.
- **U3 : undo simple (1 niveau)** plutot qu'historique.
- **F9 : auto-archive a chaque refresh** plutot que bouton manuel.
- **F10 : optimistic online + GET au lieu de HEAD** : evite flash 'offline' au boot ; GET / accepte 302.
- **PyInstaller --onedir plutot que --onefile**.
- **A6 : façade `__init__.py`** preserve `from app.data.repositories import IngredientRepo` malgre le split en 11 fichiers — aucune cassure d'import.
- **A3 dirty tracking** sur 5 mutations buffered uniquement (meta + lines). Photos / tags auto-persistent et ne marquent pas dirty (pas de "save" possible derriere).
- **B4 casefold pour la collision** : SQLite `LOWER()` ne gere que l'ASCII. `str.casefold()` Python gere correctement Œ↔œ pour les noms francais.
- **C1 templates en JSON** plutot qu'en table relationnelle : un template = recipe d'une semaine, pas d'integrite referentielle a maintenir entre snapshots et entries reelles. Save/apply trivial.
- **C3 saisonnalite seedee idempotemment** : `WHERE season_months IS NULL` respecte les overrides utilisateur sur re-run de `init_schema`.
- **Auto-derivation prix** : `ingredient.price_eur` est un cache de la plus recente observation (par `recorded_at` — pas insertion). L'utilisateur ne peut plus editer le prix directement ; il enregistre des observations dans le dialog historique. Ajouter une observation retrospective (date passee) ne change pas le prix de reference si une plus recente existe.
- **F1 lien shopping ↔ pantry** via `is_covered_by_pantry` Property (Pydantic) sur `ShoppingItem`. Auto-coche cote QML via `ShoppingListModel._in_fridge` seede dans `set_items` depuis le champ.
- **B6 unified search** : 3 sections statiques avec slots dedies. Pas de model partage car 3 sources differentes — flat list cote QML pour la navigation clavier uniforme.
- **A7 refactor minimal viable** : seulement 2 sous-composants extraits (PhotoBlock, TagsChips) plutot que les 5 prevus, pour limiter le risque sur les bindings tendus de l'editeur. Page passee de 1068 a 934 lignes.

## Evolutions encore possibles (out of scope du plan v2)

| Feature | Couches impactees |
|---|---|
| Confirmation dialogs sur destructifs (U4) | composants QML (`AppConfirmDialog` est livre via A3). Application aux suppressions de recettes/ingredients : juste branchement. |
| Periodes calendrier custom (B8 du plan original) | `CalendarViewModel` accepte `(start_date, end_date)` au lieu d'`iso_week`. |
| Export PDF (recettes ou liste de courses) | nouveau service `pdf_export.py` + ReportLab. |
| OCR de tickets de caisse pour saisir les prix en lot | OCR (out of scope — pas de LLM dans les chemins critiques). |
| Categories OFF dans le filtre import | facets Search-a-licious. |
| CI/CD GitHub Actions auto-build .exe | `.github/workflows/build.yml`. |
| Auto-update au demarrage | `app/services/version_check.py`. |
| Migrations versionnees (Alembic) | `alembic.ini` + refactor `init_schema`. Bloquant si Postgres / multi-machines. |
| CLI typer `python -m app.cli` | `app/cli.py` avec `load-ciqual`, `reset-db`, etc. |
| GC du cache OFF | colonne `cached_at` + service `prune_old_off_cache`. |
| Loader CIQUAL en transaction | wrapper `with engine.begin()`. |
| Mobile companion | nouveau projet client avec API FastAPI. |
| Sync cloud | data/ backup vers Dropbox/Drive ou bascule Postgres. |
| Support macOS/Linux | actuellement Windows-only par design. |
| Edition de la saisonnalite via UI | aujourd'hui seedee + non editable cote formulaire. |
| Drag manuel des lignes de recette | B5 livre = tri auto par rayon (replace l'idee de drag). |
| Splitting RecipesPage complet en 5 composants | A7 livre 2/5 ; les 3 restants (MetaForm, LinesTable, NutritionPanel) demanderaient un refactor profond des bindings. |

## Conventions

- Code, commentaires, identifiants : **anglais**.
- Strings utilisateur (QML strings, README, doc) : **francais**.
- Fonctions pures pour la logique metier (testables sans Qt ni DB).
- Une page = un fichier sous `app/ui/qml/pages/`. Pas de god-window.
- Slots QML : `camelCase` (convention Qt). Methodes Python : `snake_case`. Les VMs gardent les deux APIs (slots = wrappers minces).
- Pas de cache complexe au debut. On recalcule.
- Theme tokens : tout passe par `Theme.colorXxx`, `Theme.spaceXxx`, etc. Aucune couleur en dur dans les composants ou pages.
- Tests : `pytest tests/` doit passer apres chaque chantier. Smoke QML : `rootObjects=1`, zero warning actionable. Lint `ruff check app tests` : zero erreur introduite (3 warnings residuels pre-existants : I001 dans `repositories/weekly_cost.py`, UP042 dans `domain/models.py`).
- **Validateurs Pydantic** : tout champ metier qui a une contrainte d'entreprise (prix > 0, name non-vide, etc.) doit avoir un `@field_validator` ou `Field(gt=...)` cote domain. Premiere ligne de defense — la couche UI peut faire confiance au domain.
- **Tests QML** : a chaque ajout d'un dialog ou page, ajouter un smoke load test dans `test_ui_qml.py`. Critical path test via `QSignalSpy` quand la VM expose un signal observable.
