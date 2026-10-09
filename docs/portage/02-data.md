# Spécification de portage — 02. Couche DONNÉES

Source : `app/data/` (db.py, orm.py, repositories/, seeds/) de l'app desktop
"Prandia" (Python 3.11+ / SQLAlchemy 2.x / SQLite).
Cible : Cloudflare Worker + D1 (SQLite managé) + front TypeScript.

Ce document est écrit à partir du **code réel** et vérifié contre le **schéma
effectivement présent** dans `prandia.db` (dump `sqlite_master`) ainsi
que contre un schéma **régénéré à neuf** par `init_schema()` dans le venv du
projet. Les fichiers `CLAUDE.md` / `architecture.md` du dépôt sont périmés et
n'ont pas été utilisés comme source (les écarts constatés sont signalés au § 9).

---

## 0. Inventaire des fichiers de la couche

| Fichier | Rôle |
|---|---|
| `app/data/db.py` | engine, PRAGMA, session factory, DDL FTS5, migrations inline, seeders, sauvegardes fichier |
| `app/data/orm.py` | 15 tables SQLAlchemy déclaratives |
| `app/data/repositories/__init__.py` | façade publique (ré-exports) |
| `app/data/repositories/_search.py` | `SortField`, `SearchFilters`, `SearchOptions`, `SearchPage` |
| `app/data/repositories/_mappers.py` | conversions ORM ↔ Pydantic |
| `app/data/repositories/{ingredient,recipe,tag,meal_plan,weekly_cost,price_history,pantry,cooking_log,imported_receipt,receipt_alias,lidl_plus_settings,category}.py` | 12 repositories |
| `app/data/seeds/ciqual_loader.py` | chargeur CIQUAL (.xls / .xlsx / .csv) |
| `app/data/seeds/seasons.py` | table de saisonnalité (57 entrées) |
| `app/data/seeds/ciqual.xls` | fichier ANSES fourni par l'utilisateur (présent dans le dépôt local) |

> **`app/data/repositories.py` (fichier plat, 18 627 octets) est du CODE MORT.**
> Le package `app/data/repositories/` porte le même nom et gagne à l'import
> Python (les packages priment sur les modules). Vérifié : un import de
> `app.data.repositories` échoue dans `repositories/category.py`, donc c'est bien
> le package qui est chargé. Le fichier plat est une version antérieure
> (pré-split A6) qui ne contient ni `CategoryRepo`, ni `PantryRepo`, ni les repos
> tickets/Lidl. **Ne pas le porter.**

### 0.1 État observé de la base de production (au 2026-08-01)

| Table | Lignes |
|---|---|
| `ingredient` | 4 177 (3 484 ciqual dont 21 en biblio perso ; 693 openfoodfacts dont 37 en biblio perso) |
| `ingredient_fts` | 4 177 |
| `recipe` / `recipe_ingredient` / `recipe_tag` | 6 / 56 / 5 |
| `tag` | 10 (les 10 tags par défaut) |
| `meal_plan_entry` / `meal_plan_template` | 2 / 1 |
| `pantry_stock` | 3 |
| `ingredient_price_history` | 8 |
| `recipe_cooking_log` | 0 |
| `imported_receipt` / `receipt_alias` | 1 / 1 |
| `category_definition` | 35 |
| `lidl_plus_settings` | 1 |
| `weekly_cost_snapshot` | 2 |

`PRAGMA user_version` = 0 (aucun versionnage de schéma : les migrations sont
détectées par introspection, cf. § 4).

---

## 1. Bootstrap moteur / sessions (db.py) et ce qui ne se porte pas

### 1.1 Emplacement de la base

```python
_DEFAULT_DB_FILENAME = "prandia.db"

def default_db_path() -> Path:
    override = os.environ.get("PRANDIA_DB_PATH")
    if override: return Path(override)
    return Path.cwd() / _DEFAULT_DB_FILENAME
```

URL par défaut : `sqlite:///<default_db_path().as_posix()>`.

### 1.2 PRAGMA appliqués à CHAQUE connexion

```python
engine = create_engine(url, future=True)

@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA foreign_keys = ON")
    if ":memory:" not in url:
        cur.execute("PRAGMA journal_mode = WAL")
    cur.close()
```

**Conséquence métier majeure** : `PRAGMA foreign_keys = ON` est ce qui rend
opérants tous les `ON DELETE CASCADE` / `ON DELETE RESTRICT` du schéma. Sans lui,
SQLite ignore les FK. Plusieurs comportements documentés dans les repositories
(« la suppression du tag droppe les `recipe_tag` », « supprimer une catégorie L1
supprime ses L2 ») en dépendent **entièrement**.

**Portage D1** : D1 applique les contraintes de clé étrangère par défaut ; il n'y
a pas de hook « à la connexion » et `PRAGMA journal_mode` n'a pas de sens (D1 est
managé). Le seul PRAGMA pertinent côté D1 est `PRAGMA defer_foreign_keys = on`
à l'intérieur d'une transaction, pour les imports en masse où l'ordre d'insertion
ne peut pas respecter les FK. **Ne pas porter** les deux PRAGMA d'origine.

### 1.3 Sessions

```python
def make_session_factory(engine):
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)

@contextmanager
def session_scope(factory):
    session = factory()
    try:
        yield session; session.commit()
    except Exception:
        session.rollback(); raise
    finally:
        session.close()
```

Toutes les mutations passent par ce scope (une transaction par action UI).
`AppContext.from_default()` (`app/ui/app_context.py`) fait
`make_engine()` → `init_schema(engine)` → `make_session_factory(engine)`.
**`init_schema()` est donc rejoué à chaque démarrage de l'app.**

**Portage** : D1 n'a pas de transactions interactives multi-requêtes. Le
`session_scope` se traduit soit par un `db.batch([...])` (atomique), soit par
une exécution séquentielle non atomique. Les repositories font
beaucoup d'aller-retours `flush()` puis relecture (ex. `RecipeRepo.create`
insère la recette, flush pour obtenir l'`id`, puis insère les lignes) : ce motif
« insert → récupérer l'id → insert dépendant » doit être réécrit avec
`INSERT ... RETURNING id` (supporté par D1) ou `last_row_id` du résultat.

### 1.4 Sauvegardes fichier — DESKTOP UNIQUEMENT

Bloc entier `backup_on_startup` / `_sqlite_backup` / `_rotate_backups` /
`list_backups` / `restore_from_backup`. Appelé depuis `app/main.py:67`
(`backup_on_startup()`), avant l'ouverture de la fenêtre.

- Répertoire : `PRANDIA_BACKUP_DIR` sinon `~/.prandia/backups/`.
- Nom de fichier : `db-%Y-%m-%d_%H%M%S.db` (constante `_BACKUP_TIMESTAMP_FORMAT`).
- Copie via l'API `sqlite3.Connection.backup()` (snapshot cohérent avec WAL), pas
  un `copy` brut.
- **Politique de rétention exacte** (`_rotate_backups`), `age_days = (now - ts).days`
  (division entière) :
  - `age_days <= 7` → conservé ;
  - `7 < age_days <= 180` → conservé **uniquement** si c'est le plus récent de son
    mois calendaire (`ts.strftime("%Y-%m")`, dernier gagnant car tri croissant) ;
  - `age_days > 180` → supprimé.
  - Un fichier `db-*.db` dont l'horodatage ne parse pas est **ignoré** (jamais
    supprimé). Résultat attendu : ~13 fichiers max.
- `restore_from_backup(backup_path)` prend d'abord une sauvegarde de sécurité
  `db-pre-restore-<ts>.db` (dans `db_path.parent` si ≠ cwd, sinon dans le dossier
  de backups), puis `shutil.copy2` par-dessus la base vive. Retourne le chemin de
  la sauvegarde de sécurité. L'appelant doit avoir fermé les connexions
  (l'app doit redémarrer).
- Toutes les erreurs de `backup_on_startup` sont loguées et **avalées** — un
  backup raté ne doit jamais empêcher le lancement.

**Équivalent web** : D1 Time Travel (restauration ponctuelle jusqu'à 30 jours,
gratuite et intégrée) couvre 95 % du besoin ; pour l'export explicite,
`wrangler d1 export` ou un Worker cron qui écrit un dump SQL dans R2 avec la même
politique de rétention (7 quotidiens + 6 mensuels). L'écran « restaurer une
sauvegarde » de l'app doit devenir un appel d'API admin, pas une copie de fichier.

---

## 2. Schéma SQL complet (15 tables + 1 table virtuelle)

Le DDL ci-dessous est le DDL **exact** émis par `Base.metadata.create_all()` sur
une base neuve (régénéré et capturé depuis `sqlite_master`). Il est reproduit
tel quel — y compris les particularités SQLAlchemy à corriger au portage,
signalées en note.

### 2.0 Notes transversales, valables pour TOUTES les tables

1. **Les `default=` SQLAlchemy sont côté Python, PAS dans le DDL.**
   Seul `in_personal_library` porte un vrai `server_default`. Toutes les autres
   colonnes « à défaut » (`recipe.instructions=''`, `recipe.default_portions=1`,
   `tag.color_hex='#9ca3af'`, `*.ordinal=0`, `receipt_alias.hit_count=0`,
   `imported_receipt.line_count=0`, `lidl_plus_settings.enabled=0`,
   `poll_interval_minutes=60`, `weekly_cost_snapshot.total_eur=0.00`,
   `missing_count=0`) sont déclarées **`NOT NULL` sans `DEFAULT`** dans le DDL.
   → **Au portage D1, ajouter explicitement les `DEFAULT` en SQL**, sinon tout
   `INSERT` qui omet la colonne échouera (l'ORM ne sera plus là pour remplir).
2. **`created_at` / `updated_at`** : `server_default=func.now()` → rendu
   `DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL`. En SQLite `CURRENT_TIMESTAMP`
   est **UTC**, format `'YYYY-MM-DD HH:MM:SS'` (sans fraction).
3. **`onupdate=func.now()` n'existe PAS en base** : c'est un défaut *client*
   SQLAlchemy, injecté dans l'`UPDATE`. Sur D1 il faudra soit poser
   `updated_at` explicitement dans chaque `UPDATE`, soit créer un trigger
   `AFTER UPDATE`. Sans cela, `updated_at` restera figé.
4. **Incohérence de fuseau et de format des dates** — à trancher au portage :
   - `CURRENT_TIMESTAMP` (défauts serveur) → UTC, `'2026-05-03 10:16:37'` ;
   - les datetimes posés par Python (`recorded_at`, `cooked_at`, `expiry_date`,
     `receipt_date`, `captured_at`, `last_fetched_at`) sont des `datetime` naïfs
     **heure locale**, sérialisés `'2026-05-02 00:00:00.000000'` (avec
     microsecondes).
   Exception notable : `WeeklyCostRepo.upsert` force
   `datetime.now(UTC).replace(tzinfo=None)` (donc UTC naïf) là où
   `CookingLogRepo.count_in_window` et `LidlPlusSettingsRepo.mark_fetched`
   utilisent `datetime.now()` (local). **Recommandation : tout normaliser en
   ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`) ou en epoch ms lors de la migration.**
5. **`NUMERIC(p,s)` n'est pas un décimal réel en SQLite** : les valeurs sont
   stockées en `REAL` (voire `INTEGER` quand la valeur est entière — vérifié :
   `price_eur` vaut `12` de type `integer` sur la ligne 1429). Le côté Python
   les remonte en `Decimal`. En TypeScript, prévoir soit des centimes entiers,
   soit un parsing string ; ne pas se fier au type SQL.
6. **Les booléens** sont des `0/1` (`BOOLEAN` sans contrainte CHECK,
   `INTEGER` pour `lidl_plus_settings.enabled`).
7. **`id INTEGER NOT NULL PRIMARY KEY`** = alias de `rowid`, auto-incrémenté.
   Compatible D1 tel quel. Pas d'`AUTOINCREMENT` (donc réutilisation possible
   d'ids libérés — sans importance ici).

---

### 2.1 `ingredient`

```sql
CREATE TABLE ingredient (
	id INTEGER NOT NULL,
	name VARCHAR(200) NOT NULL,
	source VARCHAR(20) NOT NULL,
	source_ref VARCHAR(50),
	brand VARCHAR(150),
	kcal_per_100g FLOAT,
	proteins_g FLOAT,
	carbs_g FLOAT,
	sugars_g FLOAT,
	fats_g FLOAT,
	saturated_fats_g FLOAT,
	fiber_g FLOAT,
	salt_g FLOAT,
	price_eur NUMERIC(10, 4),
	price_quantity_g FLOAT,
	piece_weight_g FLOAT,
	cooked_weight_per_100g_raw FLOAT,
	in_personal_library BOOLEAN DEFAULT '0' NOT NULL,
	category_l1 VARCHAR(150),
	category_l2 VARCHAR(150),
	season_months VARCHAR(50),
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_ingredient_source_ref ON ingredient (source, source_ref);
```

Sémantique (invariants portés par le modèle Pydantic `Ingredient`, pas par la base) :

- `source` ∈ `{'ciqual', 'openfoodfacts', 'manual', 'lidl'}` (enum `Source`).
  **`'lidl'` est une 4ᵉ valeur absente de architecture.md** : `source_ref` porte
  alors l'`art_id` produit renvoyé par l'API Lidl Plus, ce qui permet un
  rapprochement déterministe des tickets Lidl via `find_by_source_ref`.
- `source_ref` = code CIQUAL `alim_code` | code-barres EAN (OFF) | `art_id`
  (Lidl) | `NULL` (manual).
- **L'index unique `(source, source_ref)` autorise plusieurs `NULL`** (SQLite :
  les NULL sont distincts dans un index unique) → tous les `manual` cohabitent.
- Nutriments **pour 100 g** (convention CIQUAL). `NULL` = « inconnu », **distinct
  de 0**. Validateur Pydantic : `>= 0` ou `NULL`.
- `price_eur` : `NULL` ou **strictement > 0** ; `price_quantity_g`,
  `piece_weight_g`, `cooked_weight_per_100g_raw` : `NULL` ou **strictement > 0**.
  Aucune de ces règles n'est en base → **à réimplémenter côté Worker** (ou via
  des `CHECK`, ce que D1 accepte).
- `price_per_g` (propriété calculée, pas une colonne) = `price_eur / price_quantity_g`,
  `NULL` si l'un des deux est absent ou si `price_quantity_g == 0`.
- `piece_weight_g` : poids d'une « pièce » (1 œuf ≈ 60 g). Non-NULL → l'UI
  propose l'unité « pièce ». 9 lignes renseignées en prod.
- `cooked_weight_per_100g_raw` : g cuits obtenus à partir de 100 g cru (riz,
  pâtes). `NULL` = 1:1. Les macros restent en **cru**.
- `in_personal_library` : bibliothèque de travail de l'utilisateur. Les lignes
  CIQUAL/OFF sont semées à `0` et n'apparaissent pas dans l'onglet Ingrédients.
- `category_l1` / `category_l2` : **chaînes libres, pas des FK** vers
  `category_definition` (choix assumé, cf. § 2.14). Valeurs observées en prod
  pour `category_l1` : `NULL` (2 540), `Fruits et légumes` (654),
  `Produits laitiers & oeufs` (360), `Boissons` (328), `Epicerie` (255),
  `Surgelés` (32), `Snacks et confiseries` (5), `Boucherie` (3) — ce ne sont
  **pas** les libellés bruts CIQUAL : l'utilisateur les a renommés et le renommage
  a cascadé (cf. `CategoryRepo.rename`).
- `season_months` : CSV de mois `1..12`, ex. `"6,7,8,9,10"`. `NULL` = pas de
  donnée. 375 lignes renseignées en prod.
- `brand` : marque commerciale (auto-remplie depuis `brands` d'OFF). 179 lignes.

### 2.2 `tag`

```sql
CREATE TABLE tag (
	id INTEGER NOT NULL,
	name VARCHAR(100) NOT NULL,
	color_hex VARCHAR(9) NOT NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (name)
);
```
`color_hex` : `#RRGGBB` ou `#RRGGBBAA`, défaut applicatif `#9ca3af`. Aucune
validation. `name` unique (index implicite `sqlite_autoindex_tag_1`).

### 2.3 `recipe_tag` (M2M)

```sql
CREATE TABLE recipe_tag (
	recipe_id INTEGER NOT NULL,
	tag_id INTEGER NOT NULL,
	PRIMARY KEY (recipe_id, tag_id),
	FOREIGN KEY(recipe_id) REFERENCES recipe (id) ON DELETE CASCADE,
	FOREIGN KEY(tag_id) REFERENCES tag (id) ON DELETE CASCADE
);
```

### 2.4 `recipe`

```sql
CREATE TABLE recipe (
	id INTEGER NOT NULL,
	name VARCHAR(200) NOT NULL,
	instructions TEXT NOT NULL,          -- défaut applicatif ''
	default_portions INTEGER NOT NULL,   -- défaut applicatif 1, contrainte Pydantic >= 1
	image_path VARCHAR(500),
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id)
);
```
`image_path` = **chemin de fichier local** (spécifique desktop). Équivalent web :
clé d'objet R2 / URL, ou `NULL`.

### 2.5 `recipe_ingredient`

```sql
CREATE TABLE recipe_ingredient (
	recipe_id INTEGER NOT NULL,
	ingredient_id INTEGER NOT NULL,
	ordinal INTEGER NOT NULL,        -- défaut applicatif 0 ; fait partie de la PK
	quantity_g FLOAT NOT NULL,       -- contrainte Pydantic > 0
	notes VARCHAR(200),
	unit VARCHAR(16),
	PRIMARY KEY (recipe_id, ingredient_id, ordinal),
	FOREIGN KEY(recipe_id) REFERENCES recipe (id) ON DELETE CASCADE,
	FOREIGN KEY(ingredient_id) REFERENCES ingredient (id) ON DELETE RESTRICT
);
```

- **PK à 3 colonnes** : `(recipe_id, ingredient_id, ordinal)`. Le même ingrédient
  peut donc apparaître plusieurs fois dans une recette **à condition d'avoir un
  `ordinal` différent**. Comme `RecipeRepo._replace_lines` réattribue
  `ordinal = line.ordinal or idx`, deux lignes du même ingrédient avec
  `ordinal` explicite identique lèveraient une violation de PK.
  ⚠️ Piège : `line.ordinal or idx` traite `ordinal == 0` comme faux et retombe sur
  `idx`. Pour la première ligne (`idx == 0`) c'est neutre, mais une ligne à
  `ordinal=0` en 4ᵉ position sera réécrite en `ordinal=3`.
- `ON DELETE RESTRICT` sur `ingredient` : **on ne peut pas supprimer un ingrédient
  utilisé dans une recette** (l'`IngredientRepo.delete` lèvera une IntegrityError).
  C'est la seule FK non-CASCADE du schéma.
- `unit` : code d'unité saisi (`g`, `kg`, `ml`, `cl`, `dl`, `L`, `c_cafe`,
  `c_soupe`, `tasse`, `pincee`, `_piece`) — purement cosmétique, la **quantité
  stockée est toujours en grammes**. `NULL` = ligne antérieure à la migration,
  l'UI retombe sur son heuristique.

### 2.6 `meal_plan_entry`

```sql
CREATE TABLE meal_plan_entry (
	id INTEGER NOT NULL,
	iso_week VARCHAR(8) NOT NULL,
	day_of_week INTEGER NOT NULL,
	slot VARCHAR(10) NOT NULL,
	recipe_id INTEGER,
	ingredient_id INTEGER,
	quantity_g FLOAT,
	portions FLOAT,
	ordinal INTEGER NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT ck_meal_plan_entry_xor CHECK ((recipe_id IS NOT NULL AND ingredient_id IS NULL) OR (recipe_id IS NULL AND ingredient_id IS NOT NULL)),
	FOREIGN KEY(recipe_id) REFERENCES recipe (id) ON DELETE CASCADE,
	FOREIGN KEY(ingredient_id) REFERENCES ingredient (id) ON DELETE CASCADE
);
CREATE INDEX ix_meal_plan_week ON meal_plan_entry (iso_week, day_of_week, slot);
```

- `iso_week` : clé naturelle `'YYYY-Www'` (ex. `'2026-W18'`), validée par
  `IsoWeek` : longueur exacte 8, `v[4:6] == '-W'`, `2000 <= année <= 2100`,
  `1 <= semaine <= 53`.
- `day_of_week` : `0 = lundi` … `6 = dimanche` (validé `ge=0, le=6` côté Pydantic
  seulement).
- `slot` ∈ `{'morning', 'snack_morning', 'noon', 'snack_afternoon', 'evening'}`.
  ⚠️ **`VARCHAR(10)` est trop court pour `'snack_afternoon'` (15 car.) et
  `'snack_morning'` (13 car.)** — sans effet en SQLite (la longueur n'est pas
  appliquée), mais **à corriger** au portage si la cible applique les longueurs.
- Règles Pydantic supplémentaires **non représentées en base** :
  `portions` obligatoire quand `recipe_id` est posé ; `quantity_g` obligatoire
  quand `ingredient_id` est posé ; les deux strictement > 0 quand renseignés.
- `ordinal` : plusieurs éléments empilables dans une même case.

### 2.7 `meal_plan_template` (absente de architecture.md)

```sql
CREATE TABLE meal_plan_template (
	id INTEGER NOT NULL,
	name VARCHAR(100) NOT NULL,
	snapshot_json TEXT NOT NULL,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	UNIQUE (name)
);
```

Aucun repository : la table est manipulée directement par
`app/services/meal_plan_service.py` (`save_as_template`, `apply_template`,
`list_templates`, `delete_template`).

Forme **exacte** du JSON (`_entry_to_snapshot_dict`), un tableau d'objets, sans
`id` ni `iso_week` :

```json
[{"day_of_week": 0, "slot": "evening", "recipe_id": 1, "ingredient_id": null,
  "quantity_g": null, "portions": 1.0, "ordinal": 0}]
```

`apply_template` est **append-only** (n'efface pas la semaine cible), ignore
silencieusement les entrées malformées et retourne 0 si le JSON est corrompu.
`save_as_template` écrase le snapshot si le nom existe déjà.

### 2.8 `weekly_cost_snapshot`

```sql
CREATE TABLE weekly_cost_snapshot (
	iso_week VARCHAR(8) NOT NULL,
	total_eur NUMERIC(10, 2) NOT NULL,   -- défaut applicatif 0.00
	missing_count INTEGER NOT NULL,      -- défaut applicatif 0
	captured_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (iso_week)
);
```
Une ligne par semaine ISO, **écrasée** à chaque rafraîchissement (ce n'est pas un
historique d'archives mais l'état courant du plan). `missing_count` = nombre
d'items du plan sans prix connu.

### 2.9 `recipe_cooking_log`

```sql
CREATE TABLE recipe_cooking_log (
	id INTEGER NOT NULL,
	recipe_id INTEGER NOT NULL,
	cooked_at DATETIME NOT NULL,
	rating INTEGER,               -- 1..5, validé Pydantic uniquement
	notes VARCHAR(1000),
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(recipe_id) REFERENCES recipe (id) ON DELETE CASCADE
);
CREATE INDEX ix_cooking_log_recipe_date ON recipe_cooking_log (recipe_id, cooked_at);
CREATE INDEX ix_recipe_cooking_log_recipe_id ON recipe_cooking_log (recipe_id);  -- redondant
```
Le second index est **redondant** (préfixe du premier) : il vient du
`index=True` posé sur la colonne en plus de l'`Index(...)` explicite. Même
motif pour `pantry_stock`, `ingredient_price_history`, `receipt_alias`.
**À ne pas reproduire.**

### 2.10 `pantry_stock`

```sql
CREATE TABLE pantry_stock (
	id INTEGER NOT NULL,
	ingredient_id INTEGER NOT NULL,
	quantity_g FLOAT NOT NULL,       -- Pydantic > 0
	expiry_date DATETIME,
	notes VARCHAR(500),
	added_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(ingredient_id) REFERENCES ingredient (id) ON DELETE CASCADE
);
CREATE INDEX ix_pantry_stock_expiry ON pantry_stock (expiry_date);
CREATE INDEX ix_pantry_stock_ingredient ON pantry_stock (ingredient_id);
CREATE INDEX ix_pantry_stock_ingredient_id ON pantry_stock (ingredient_id);  -- redondant
```
**Plusieurs lignes par ingrédient sont attendues** (lots avec DLC différentes) ;
la somme se fait via `aggregate_quantity_by_ingredient()`.

### 2.11 `ingredient_price_history`

```sql
CREATE TABLE ingredient_price_history (
	id INTEGER NOT NULL,
	ingredient_id INTEGER NOT NULL,
	price_eur NUMERIC(10, 4) NOT NULL,   -- Pydantic > 0
	quantity_g FLOAT NOT NULL,           -- Pydantic > 0
	store VARCHAR(100),
	recorded_at DATETIME NOT NULL,
	notes VARCHAR(500),
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(ingredient_id) REFERENCES ingredient (id) ON DELETE CASCADE
);
CREATE INDEX ix_price_history_ingredient_date ON ingredient_price_history (ingredient_id, recorded_at);
CREATE INDEX ix_ingredient_price_history_ingredient_id ON ingredient_price_history (ingredient_id);  -- redondant
```
Journal **append-only** (pas d'`update` dans le repo : pour corriger, supprimer
puis rajouter). Le prix « de référence » reste sur `ingredient.price_eur` ; la
promotion d'une observation en référence est une action utilisateur explicite.
Propriété calculée `price_per_100g = price_eur * 100 / quantity_g`.

### 2.12 `imported_receipt` (absente de architecture.md)

```sql
CREATE TABLE imported_receipt (
	ticket_id VARCHAR(64) NOT NULL,
	store VARCHAR(20) NOT NULL,
	imported_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	receipt_date DATETIME,
	total_eur NUMERIC(10, 2),
	line_count INTEGER NOT NULL,     -- défaut applicatif 0
	PRIMARY KEY (ticket_id)
);
```
Anti-doublon des tickets de caisse importés. **La PK est l'identifiant du ticket
réel**, pas de l'import :
- Intermarché : code-barres numérique du pied de page du PDF (~24 chiffres) —
  exemple réel en base : `'202605021635010402310718'` ;
- Lidl Plus : `data-return-code` (HTML) ou `id` (réponse API) ;
- Carrefour : non déterminé (« TBD » dans le code).

`store` observé : `'intermarche'` (chaîne libre, aucune contrainte ; valeurs
attendues d'après le code : `intermarche`, `lidl`, `carrefour`).

### 2.13 `receipt_alias` (absente de architecture.md)

```sql
CREATE TABLE receipt_alias (
	id INTEGER NOT NULL,
	store VARCHAR(20) NOT NULL,
	source_key VARCHAR(200) NOT NULL,
	ingredient_id INTEGER NOT NULL,
	hit_count INTEGER NOT NULL,      -- défaut applicatif 0, mis à 1 à la création par le repo
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(ingredient_id) REFERENCES ingredient (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_receipt_alias_store_key ON receipt_alias (store, source_key);
CREATE INDEX ix_receipt_alias_ingredient_id ON receipt_alias (ingredient_id);  -- redondant avec l'usage
```
Apprentissage `(enseigne, libellé tronqué du ticket) → ingredient_id`. Ligne
réelle en base : `('intermarche', 'pat creme uht se 18%', 3927, hit_count=1)` —
on voit la **normalisation attendue de `source_key` : casefold + espaces
collapsés** (la normalisation elle-même est faite en amont, dans le service
matcher, pas dans le repo). Non utilisée pour Lidl (qui a un `art_id` stable).

### 2.14 `category_definition` (absente de architecture.md)

```sql
CREATE TABLE category_definition (
	id INTEGER NOT NULL,
	name VARCHAR(100) NOT NULL,
	parent_id INTEGER,
	ordinal INTEGER NOT NULL,        -- défaut applicatif 0
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(parent_id) REFERENCES category_definition (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ix_category_definition_unique_in_parent ON category_definition (parent_id, name);
```

- Hiérarchie sur 2 niveaux en pratique : `parent_id IS NULL` → L1, sinon L2.
  **Rien n'empêche techniquement un niveau 3+** (auto-FK non contrainte en
  profondeur) ; le code n'en produit jamais.
- ⚠️ **L'index unique `(parent_id, name)` ne contraint PAS les L1** : `parent_id`
  y est `NULL`, et SQLite considère les NULL comme distincts → deux catégories
  racines homonymes sont acceptées par la base. L'unicité des L1 n'est garantie
  que par le contrôle applicatif `CategoryRepo.find_by_name(name, None)`.
  **Sur D1, remplacer par un index unique sur expression :**
  `CREATE UNIQUE INDEX ... ON category_definition (COALESCE(parent_id, -1), name)`.
- Les ingrédients **ne référencent pas** cette table par FK : `category_l1` /
  `category_l2` sont des chaînes. Le lien est maintenu à la main
  (cf. `CategoryRepo.rename` / `.delete`).

### 2.15 `lidl_plus_settings` (absente de architecture.md)

```sql
CREATE TABLE lidl_plus_settings (
	id INTEGER NOT NULL,                  -- singleton, PK fixée à 1
	enabled INTEGER NOT NULL,             -- 0/1, défaut applicatif 0
	poll_interval_minutes INTEGER NOT NULL, -- défaut applicatif 60, plancher 5 imposé par le repo
	last_fetched_at DATETIME,
	last_error TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY (id)
);
```
**Aucun secret n'est stocké ici.** Les identifiants Lidl (email, mot de passe,
refresh token) vivent dans le Windows Credential Manager via `keyring`.
Équivalent web : Cloudflare Secrets / Secrets Store (jamais en D1), ou un flux
OAuth côté utilisateur.
`last_fetched_at` sert de paramètre `since` au prochain appel API.
Ligne réelle : `(1, enabled=0, poll_interval_minutes=5, NULL, NULL, ...)`.

---

## 3. Configuration FTS5

### 3.1 DDL exact (`_FTS5_STATEMENTS`, db.py:214-239)

Quatre instructions, exécutées dans cet ordre à chaque `init_schema()`. Elles
sont volontairement stockées en liste (et non concaténées) car un `split(';')`
naïf casserait les triggers `BEGIN … END`.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS ingredient_fts USING fts5(
    name,
    content='ingredient',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS ingredient_ai AFTER INSERT ON ingredient BEGIN
    INSERT INTO ingredient_fts(rowid, name) VALUES (new.id, new.name);
END;

CREATE TRIGGER IF NOT EXISTS ingredient_ad AFTER DELETE ON ingredient BEGIN
    INSERT INTO ingredient_fts(ingredient_fts, rowid, name) VALUES('delete', old.id, old.name);
END;

CREATE TRIGGER IF NOT EXISTS ingredient_au AFTER UPDATE ON ingredient BEGIN
    INSERT INTO ingredient_fts(ingredient_fts, rowid, name) VALUES('delete', old.id, old.name);
    INSERT INTO ingredient_fts(rowid, name) VALUES (new.id, new.name);
END;
```

Caractéristiques :
- **Une seule colonne indexée : `name`.** Ni `brand`, ni `category_*`.
- **Table à contenu externe** (`content='ingredient'`, `content_rowid='id'`) :
  l'index ne duplique pas le texte, il pointe sur `ingredient.id`. Les tables
  shadow créées automatiquement sont `ingredient_fts_data`, `ingredient_fts_idx`,
  `ingredient_fts_docsize`, `ingredient_fts_config`.
- **`tokenize='unicode61 remove_diacritics 2'`** : c'est ce qui rend la recherche
  insensible aux accents *et* à la casse — « tomate » trouve « Tomâte », « TOMATE ».
  Le mode `2` retire les diacritiques y compris sur les caractères composés
  (contrairement au mode `1`, historique et incomplet).
- Le trigger `AFTER UPDATE` se déclenche sur **toute** modification d'une ligne
  `ingredient` (pas seulement de `name`) : réindexation inutile mais inoffensive.

### 3.2 Ce qui manque et qui mordra à la migration

Le code **n'exécute jamais** `INSERT INTO ingredient_fts(ingredient_fts) VALUES('rebuild')`.
Sur le poste de dev ce n'est pas visible : la table virtuelle et les triggers sont
créés au tout premier `init_schema()`, avant qu'aucun ingrédient n'existe, donc
les 4 177 lignes ont toutes été indexées par le trigger `AFTER INSERT`
(vérifié : `count(ingredient_fts) == count(ingredient) == 4177`).

➡️ **Lors de la migration vers D1, si vous chargez `ingredient` en masse (COPY /
batch INSERT) avec les triggers absents ou désactivés, l'index FTS sera vide et
toute recherche retournera 0 résultat.** La séquence sûre est :
1. créer `ingredient` ;
2. insérer les données ;
3. créer `ingredient_fts` + les 3 triggers ;
4. exécuter `INSERT INTO ingredient_fts(ingredient_fts) VALUES('rebuild');`.

### 3.3 Portage vers D1

| Élément | Verdict |
|---|---|
| `CREATE VIRTUAL TABLE … USING fts5` | D1 est du SQLite ; FTS5 y est disponible. **À valider en premier** sur un environnement D1 réel : c'est le point de risque n°1 du portage données. |
| `content='…'` + `content_rowid='…'` | Fonctionnalité standard FTS5, passe si FTS5 passe. |
| `tokenize='unicode61 remove_diacritics 2'` | Tokenizer intégré, pas d'extension externe. Passe. |
| Triggers `AFTER INSERT/DELETE/UPDATE` | Standard SQLite, supportés par D1. |
| `MATCH` + `ORDER BY rank` | Standard FTS5. |

**Plan B si FTS5 s'avère indisponible ou instable sur D1** (à prévoir dans la
conception, pas après) :
- une colonne dénormalisée `name_normalized` (minuscules + diacritiques retirés
  côté Worker, `String.normalize('NFD').replace(/\p{Diacritic}/gu,'')`) + un index
  B-tree, et une recherche `name_normalized LIKE 'tok%'` par token (`AND` entre
  tokens). On perd le classement par pertinence : le repli de tri est
  `ORDER BY name` — ce qui correspond d'ailleurs déjà au comportement de
  `_search_page` quand la requête est vide ;
- ou un index externe (Vectorize/KV) — surdimensionné pour 4 000 lignes.

---

## 4. Migrations inline et seeders — ordre et état final

`init_schema(engine)` (db.py:242-262) fait, **dans cet ordre exact** :

```python
Base.metadata.create_all(engine)          # 0. toutes les tables + index
with engine.begin() as conn:
    for stmt in _FTS5_STATEMENTS: conn.execute(text(stmt))   # 1. FTS5 + triggers
    _migrate_add_in_personal_library(conn)                    # 2
    _migrate_add_categories(conn)                             # 3
    _migrate_add_piece_weight(conn)                           # 4
    _migrate_add_meal_plan_entry_xor_check(conn)              # 5
    _migrate_add_season_months(conn)                          # 6
    _migrate_add_recipe_ingredient_unit(conn)                 # 7
    _migrate_add_brand(conn)                                  # 8
    _migrate_add_cooked_weight_per_100g_raw(conn)             # 9
    _seed_default_tags(conn)                                  # 10
    _seed_seasonality(conn)                                   # 11
    _seed_categories_from_existing(conn)                      # 12
```

Le tout dans **une seule transaction** (`engine.begin()`). Il n'y a **pas** de
table de versions ni de `PRAGMA user_version` : l'idempotence repose sur
l'introspection (`PRAGMA table_info(...)`, `sqlite_master`, `INSERT OR IGNORE`,
`WHERE ... IS NULL`).

### Détail migration par migration

| # | Fonction | Test d'idempotence | Action |
|---|---|---|---|
| 2 | `_migrate_add_in_personal_library` | `'in_personal_library' in PRAGMA table_info(ingredient)` | `ALTER TABLE ingredient ADD COLUMN in_personal_library INTEGER NOT NULL DEFAULT 0` **puis** `UPDATE ingredient SET in_personal_library = 1 WHERE source IN ('manual','openfoodfacts')`. ⚠️ La promotion de masse **ne s'exécute que la toute première fois** (base pré-existante sans la colonne). Sur base neuve, `create_all` a déjà créé la colonne → aucune promotion, et les OFF importés arrivent à `False` sauf action explicite. |
| 3 | `_migrate_add_categories` | colonnes présentes | `ADD COLUMN category_l1 TEXT` / `category_l2 TEXT` (indépendamment l'une de l'autre) |
| 4 | `_migrate_add_piece_weight` | colonne présente | `ADD COLUMN piece_weight_g REAL` |
| 5 | `_migrate_add_meal_plan_entry_xor_check` | la table existe **et** son `sql` contient `'ck_meal_plan_entry_xor'` **ou** `'recipe_id IS NOT NULL'` | rename-rebuild-copy (voir ci-dessous) |
| 6 | `_migrate_add_season_months` | colonne présente | `ADD COLUMN season_months VARCHAR(50)` |
| 7 | `_migrate_add_recipe_ingredient_unit` | colonne présente | `ALTER TABLE recipe_ingredient ADD COLUMN unit TEXT` |
| 8 | `_migrate_add_brand` | colonne présente | `ALTER TABLE ingredient ADD COLUMN brand TEXT` |
| 9 | `_migrate_add_cooked_weight_per_100g_raw` | colonne présente | `ALTER TABLE ingredient ADD COLUMN cooked_weight_per_100g_raw REAL` |

**Conséquence visible** : sur une base *migrée* (celle de prod), les colonnes
ajoutées sont en **fin de table** et avec des types différents de la version
neuve (`in_personal_library INTEGER` au lieu de `BOOLEAN`, `category_l1 TEXT` au
lieu de `VARCHAR(150)`, `piece_weight_g REAL` au lieu de `FLOAT`, `unit TEXT` au
lieu de `VARCHAR(16)`). Sans effet fonctionnel en SQLite (affinité identique),
mais **la migration des données doit se faire par nom de colonne, jamais par
position**.

#### Migration 5 en détail (rename-rebuild-copy)

SQLite ne sait pas faire `ALTER TABLE ADD CONSTRAINT`. La procédure :

```sql
ALTER TABLE meal_plan_entry RENAME TO _meal_plan_entry_old;
CREATE TABLE meal_plan_entry (
  id INTEGER NOT NULL PRIMARY KEY,
  iso_week VARCHAR(8) NOT NULL,
  day_of_week INTEGER NOT NULL,
  slot VARCHAR(10) NOT NULL,
  recipe_id INTEGER,
  ingredient_id INTEGER,
  quantity_g FLOAT,
  portions FLOAT,
  ordinal INTEGER NOT NULL,
  CONSTRAINT ck_meal_plan_entry_xor CHECK (
    (recipe_id IS NOT NULL AND ingredient_id IS NULL) OR
    (recipe_id IS NULL AND ingredient_id IS NOT NULL)),
  FOREIGN KEY(recipe_id) REFERENCES recipe(id) ON DELETE CASCADE,
  FOREIGN KEY(ingredient_id) REFERENCES ingredient(id) ON DELETE CASCADE
);
-- comptage des lignes invalides (log WARNING uniquement)
INSERT INTO meal_plan_entry
  SELECT * FROM _meal_plan_entry_old
  WHERE (recipe_id IS NOT NULL AND ingredient_id IS NULL)
     OR (recipe_id IS NULL AND ingredient_id IS NOT NULL);
DROP TABLE _meal_plan_entry_old;
CREATE INDEX IF NOT EXISTS ix_meal_plan_week
  ON meal_plan_entry(iso_week, day_of_week, slot);
```

⚠️ **Les lignes violant le XOR sont silencieusement perdues** (seulement loguées).
⚠️ Le `INSERT … SELECT *` dépend de l'ordre des colonnes de l'ancienne table.

### Détail seeder par seeder

**10. `_seed_default_tags`** — liste `_DEFAULT_TAGS`, insérée avec
`INSERT OR IGNORE INTO tag (name, color_hex) VALUES (:n, :c)` (idempotence par
l'unicité de `name`). **Retirer un tag de la liste ne le supprime PAS** des bases
existantes ; en ajouter un le fait apparaître au prochain lancement.

| ordre | name | color_hex |
|---|---|---|
| 1 | `entrée` | `#fbbf24` |
| 2 | `plat principal` | `#3b82f6` |
| 3 | `dessert` | `#ec4899` |
| 4 | `petit-déjeuner` | `#fb923c` |
| 5 | `batch-cooking` | `#14b8a6` |
| 6 | `végétarien` | `#22c55e` |
| 7 | `végan` | `#16a34a` |
| 8 | `sans gluten` | `#a855f7` |
| 9 | `rapide` | `#ef4444` |
| 10 | `du placard` | `#78716c` |

**11. `_seed_seasonality`** — pour chaque couple `(prefix, csv)` de
`SEASONS_BY_NAME` (57 entrées, cf. § 6.2) :

```sql
UPDATE ingredient SET season_months = :csv
WHERE season_months IS NULL
  AND lower(name) LIKE lower(:pat)     -- :pat = prefix || '%'
```

Idempotent (n'écrase jamais une valeur existante, donc respecte les
personnalisations). **Deux limites réelles, mesurées sur la base de prod :**

- 🐛 **`lower()` de SQLite est ASCII-only.** Le motif `'épinard%'` reste
  `'épinard%'` et le nom CIQUAL `'Épinard, cru'` reste `'Épinard, cru'` :
  `'É' ≠ 'é'` → **0 correspondance**. Vérifié : 6 lignes `Épinard%` existent en
  base, **aucune** n'a de `season_months`. Tous les motifs commençant par une
  lettre accentuée sont concernés (`épinard`). Les accents **au milieu** du mot
  fonctionnent (`pêche` → 9 lignes, `céleri` → 8, `clémentine` → 1) car la
  première lettre est ASCII et le reste est identique des deux côtés.
- Le match est un **préfixe** : `'cèpe'` ne trouve rien car CIQUAL nomme
  l'aliment `'Champignon, cèpe, cru'`.
- L'ordre d'itération du dict compte : le premier motif qui matche gagne (les
  suivants voient `season_months IS NOT NULL`). Le cas `pomme` / `pomme de terre`
  tombe juste par chance (§ 6.2).

Résultat en prod : 375 lignes `ingredient` avec `season_months` non NULL.

**12. `_seed_categories_from_existing`** — pré-remplit `category_definition` à
partir des valeurs distinctes déjà présentes dans `ingredient` :

1. garde-fou : `SELECT name FROM sqlite_master WHERE type='table' AND name='category_definition'` ; si absent, retour immédiat ;
2. `SELECT DISTINCT category_l1 FROM ingredient WHERE category_l1 IS NOT NULL AND category_l1 != ''` → pour chacun, si aucune ligne `parent_id IS NULL AND name = :n`, `INSERT INTO category_definition (name, parent_id, ordinal) VALUES (:n, NULL, 0)` ;
3. `SELECT DISTINCT category_l1, category_l2 FROM ingredient WHERE les deux non NULL et non vides` → résolution de l'id du L1, puis insertion du L2 sous ce parent s'il n'existe pas.

**Tous les `ordinal` sont semés à 0** : le tri de `list_l1()` /`list_l2()` étant
`ORDER BY ordinal, name`, l'affichage initial est donc alphabétique. Le
réordonnancement manuel écrit ensuite des ordinaux distincts.

### État final du schéma après `init_schema()` sur base neuve

Exactement le DDL du § 2 : 15 tables réelles + `ingredient_fts` (+ ses 4 tables
shadow), 3 triggers, 12 index nommés (dont 4 redondants) + 6 auto-index
d'unicité (`tag.name`, `meal_plan_template.name`, `imported_receipt.ticket_id`,
`weekly_cost_snapshot.iso_week`, PK composites de `recipe_ingredient` et
`recipe_tag`), 10 lignes dans
`tag`, `category_definition` vide (aucun ingrédient donc aucune catégorie à
dériver), tout le reste vide. **Le catalogue CIQUAL n'est PAS chargé
automatiquement** (cf. § 6.4).

---

## 5. Repositories — inventaire exhaustif

Convention commune : constructeur `__init__(self, session: Session)`, attribut
`self.s`. Les repos font `flush()` (pas `commit()`) — le commit appartient au
`session_scope` appelant. Les conversions ORM→Pydantic passent par `_mappers.py`.

### 5.1 `IngredientRepo` (`ingredient.py`)

| Méthode | Requête / logique |
|---|---|
| `get(ingredient_id) -> Ingredient \| None` | `session.get` par PK |
| `list_by_ids(ids) -> dict[int, Ingredient]` | `SELECT … WHERE id IN (…)`. **Retourne `{}` sans émettre de SQL si la liste est vide.** Anti-N+1 pour la liste de courses. |
| `list_all(limit=None) -> list[Ingredient]` | `ORDER BY name` (+ `LIMIT`) |
| `list_personal(limit=None)` | `WHERE in_personal_library IS TRUE ORDER BY name` — pilote l'onglet Ingrédients |
| `find_by_source_ref(source, source_ref)` | `WHERE source = ? AND source_ref = ?`, `scalar_one_or_none` (lève si >1, ce que l'index unique empêche) |
| `find_by_name(name, source=Source.MANUAL)` | ⚠️ **Filtrage en Python, pas en SQL** : `SELECT … WHERE source = ?` puis boucle avec `str.casefold()`. Motif explicite : le `LOWER()` de SQLite est ASCII-only et raterait « Œufs » vs « œufs ». Retourne `None` si le nom normalisé (strip + casefold) est vide. **En TS, `String.prototype.toLocaleLowerCase()` + normalisation NFD fait l'affaire et peut redevenir du SQL.** |
| `create(ing) -> Ingredient` | `INSERT` via `_ing_apply`, `flush`, relecture |
| `update(ing) -> Ingredient` | `ValueError` si `ing.id is None` ; `LookupError` si introuvable |
| `upsert_by_source_ref(ing)` | si `source_ref is None` → `create` ; sinon `find_by_source_ref` → `create` ou `update` avec l'id existant. **Ne préserve rien tout seul** : c'est l'appelant (loader CIQUAL) qui protège `in_personal_library`. |
| `delete(ingredient_id)` | `DELETE` silencieux si absent. Cascades : `pantry_stock`, `ingredient_price_history`, `receipt_alias`, `meal_plan_entry` supprimés ; `recipe_ingredient` en **RESTRICT** → échec si l'ingrédient est utilisé dans une recette. |
| `search_fts(...)` | cf. § 5.2 |
| `list_categories_l1(source=None) -> list[str]` | `SELECT DISTINCT category_l1 WHERE category_l1 IS NOT NULL ORDER BY category_l1` (+ filtre source). Les chaînes vides sont retirées côté Python. |
| `mark_in_personal_library(id, value=True)` | bascule le drapeau, retourne l'ingrédient ou `None` |

`_ing_apply` (mappers) écrit **20 champs** : `name, source(.value), source_ref,
brand, cooked_weight_per_100g_raw, kcal_per_100g, proteins_g, carbs_g, sugars_g,
fats_g, saturated_fats_g, fiber_g, salt_g, price_eur, price_quantity_g,
piece_weight_g, in_personal_library, category_l1, category_l2, season_months`.
`created_at` / `updated_at` ne sont **jamais** écrits par l'application.

### 5.2 `search_fts` — spécification détaillée

#### Contrats de données (`_search.py`)

```python
SortField = Literal["rank", "name", "kcal", "proteins", "carbs", "fats"]

@dataclass(frozen=True)
class SearchFilters:
    min_kcal: float | None = None       # borne INCLUSIVE
    max_kcal: float | None = None       # borne INCLUSIVE
    min_proteins: float | None = None
    max_proteins: float | None = None
    min_carbs: float | None = None
    max_carbs: float | None = None
    min_fats: float | None = None
    max_fats: float | None = None
    category_l1: str | None = None      # égalité stricte

@dataclass(frozen=True)
class SearchOptions:
    query: str = ""
    scope: str = "all"                # "all" | "personal"
    source: Source | None = None
    filters: SearchFilters = SearchFilters()
    sort_by: SortField = "rank"
    sort_desc: bool = False
    page: int = 1
    page_size: int = 25

@dataclass(frozen=True)
class SearchPage:
    matches: list[Ingredient]
    total_count: int
    page: int
    page_size: int
    @property
    def page_count(self) -> int:
        if self.page_size <= 0 or self.total_count <= 0: return 1
        return (self.total_count + self.page_size - 1) // self.page_size
```

#### Deux formes d'appel

```python
search_fts(query=None, limit=20, *, scope="all", source=None, opts=None)
```
- **Legacy** (pickers recettes/calendrier) : `opts=None` → construit
  `SearchOptions(query=query or "", scope=scope, source=source, page=1, page_size=limit)`
  et **retourne `page.matches`, une `list[Ingredient]`**.
- **Riche** (dialogue d'import) : `opts` fourni → **retourne un `SearchPage`**.

Le type de retour est donc polymorphe (`list | SearchPage`). En TypeScript,
exposer **une seule** fonction qui retourne toujours la page.

#### Construction de la requête (`_search_page`)

```
q = opts.query.strip()
where   = []          # clauses AND
params  = {}
joins   = ""
order_by = "i.name"   # défaut
```

1. **Si `q` est non vide** :
   ```python
   tokens = [f'"{t}"*' for t in q.split() if t]
   if not tokens:  return SearchPage([], 0, opts.page, opts.page_size)
   params["q"] = " ".join(tokens)
   joins = "JOIN ingredient_fts f ON f.rowid = i.id"
   where.append("ingredient_fts MATCH :q")
   order_by = "rank"
   ```
   - découpage sur les **espaces** ; chaque token est **entre guillemets doubles**
     puis suffixé `*` → recherche par **préfixe** ;
   - plusieurs tokens joints par une espace = **`AND` implicite** de FTS5
     (`"toma"* "cer"*` = les deux préfixes doivent être présents) ;
   - 🐛 **un guillemet double dans la requête casse la syntaxe FTS5** : saisir
     `to"mate` produit `"to"mate"*` → erreur SQL non rattrapée. À corriger en TS
     (doubler les `"` : `t.replace(/"/g, '""')`), en supprimant aussi les
     caractères de contrôle FTS5.
2. `scope == "personal"` → `AND i.in_personal_library = 1`.
3. `source is not None` → `AND i.source = :source` (valeur = `source.value`).
4. Filtres numériques, tous **inclusifs**, ajoutés seulement si non-`None` :
   `i.kcal_per_100g >= :min_kcal`, `<= :max_kcal`, idem `proteins_g`, `carbs_g`,
   `fats_g`. ⚠️ **Un ingrédient dont la macro est `NULL` est exclu dès qu'un
   filtre porte dessus** (comparaison `NULL >= x` → NULL → faux). Le catalogue
   CIQUAL contient beaucoup de `NULL` : c'est un comportement à assumer ou à
   corriger explicitement.
5. `filters.category_l1` **non vide** (test de véracité, donc `""` = pas de
   filtre) → `AND i.category_l1 = :cat_l1`.
6. **Tri** — si `sort_by != "rank"` :
   ```python
   col = {"name":"i.name","kcal":"i.kcal_per_100g","proteins":"i.proteins_g",
          "carbs":"i.carbs_g","fats":"i.fats_g"}.get(sort_by, "i.name")
   direction = "DESC" if sort_desc else "ASC"
   order_by = f"({col} IS NULL), {col} {direction}, i.name ASC"
   ```
   → **les NULL sont toujours poussés en fin**, quel que soit le sens, et
   `i.name ASC` sert de départage stable.
   ⚠️ Choisir un tri explicite **écrase la pertinence FTS** même si une requête
   texte est présente. `sort_desc` est **ignoré** pour `sort_by == "rank"`.
   ⚠️ `"rank"` **sans requête texte** laisse `order_by = "i.name"` (pas d'erreur).
7. `where_sql = " WHERE " + " AND ".join(where)` si non vide.
8. **Comptage** :
   ```sql
   SELECT COUNT(*) FROM ingredient i {joins}{where_sql}
   ```
   Si `total_count == 0` → `SearchPage([], 0, opts.page, opts.page_size)`.
9. **Page d'ids** :
   ```python
   page = max(1, opts.page); page_size = max(1, opts.page_size)
   offset = (page - 1) * page_size
   ```
   ```sql
   SELECT i.id FROM ingredient i {joins}{where_sql}
   ORDER BY {order_by} LIMIT :limit OFFSET :offset
   ```
10. **Hydratation** : `SELECT … WHERE id IN (ids)` puis **réordonnancement en
    Python** selon l'ordre des ids retournés (le `IN` ne préserve pas l'ordre).

Note d'incohérence mineure : les retours anticipés (tokens vides, total 0)
renvoient `opts.page` / `opts.page_size` **non bornés**, alors que le chemin
nominal renvoie les valeurs bornées à ≥ 1.

**Équivalent D1 direct** : la requête est déjà du SQL brut paramétré ; elle se
transpose telle quelle avec `db.prepare(sql).bind(...)`. Attention : D1 ne
supporte pas les paramètres nommés `:x` — il faut convertir en `?` positionnels
en respectant l'ordre de construction des clauses.

### 5.3 `RecipeRepo` (`recipe.py`)

Chargement eager systématique via
`selectinload(RecipeRow.lines).selectinload(RecipeIngredientRow.ingredient)` +
`selectinload(RecipeRow.tags)` — soit, en SQL brut, 3 requêtes : recette(s),
lignes + ingrédients, tags.

| Méthode | Logique |
|---|---|
| `get(recipe_id) -> Recipe \| None` | recette + lignes (triées par `ordinal` via la relation) + tags (triés par `TagRow.name`) |
| `list_by_ids(ids) -> dict[int, Recipe]` | idem en masse ; `{}` sans SQL si vide |
| `list_all(*, tag_ids=None) -> list[Recipe]` | `ORDER BY recipe.name`. Si `tag_ids` non vide : `JOIN recipe_tag ON recipe_id … WHERE tag_id IN (…)` + `DISTINCT` → **sémantique OU** (au moins un des tags), pas ET. |
| `create(recipe) -> Recipe` | `INSERT recipe` → `flush` (obtient l'id) → `_replace_lines` → `_replace_tags` → `flush` → relecture complète |
| `update(recipe) -> Recipe` | `ValueError` si pas d'id, `LookupError` si absent ; réécrit `name`, `instructions`, `default_portions`, `image_path`, puis remplace lignes et tags |
| `set_tags(recipe_id, tag_ids)` | remplace le jeu de tags atomiquement ; `LookupError` si recette absente |
| `delete(recipe_id)` | `DELETE` silencieux si absent ; cascade sur `recipe_ingredient`, `recipe_tag`, `recipe_cooking_log`, `meal_plan_entry` |
| `find_by_ingredient_ids(ids, min_match=0.5)` | cf. ci-dessous |
| `find_by_ingredient_ids_categorized(ids, max_missing=3)` | cf. ci-dessous |

`_replace_lines` : **stratégie « clear + réinsertion »** (`row.lines.clear()` +
`flush()` puis append). Lève `ValueError` si une ligne référence un ingrédient
sans id. `ordinal = line.ordinal or idx` (piège du `0` décrit au § 2.5).

`_replace_tags` : assignation de `row.tags` (l'ORM calcule le diff sur
`recipe_tag`). Liste vide → **suppression de tous les liens**.

#### `find_by_ingredient_ids(ingredient_ids, min_match=0.5)`

Retourne `list[tuple[Recipe, score, match_count, total_count]]`.

- `[]` si `ingredient_ids` est vide.
- Charge **toutes** les recettes (`list_all()`) et calcule en Python (assumé
  dans le code : « < 200 recettes »).
- Pour chaque recette : `recipe_ing_ids` = ids distincts de ses lignes ;
  recettes **sans ingrédient ignorées** ; `score = |recipe ∩ provided| / |recipe|`.
- Filtre `score >= min_match`.
- Tri : `sort(key=lambda t: (score, match_count), reverse=True)` → score
  décroissant, puis nombre d'ingrédients en commun décroissant.

#### `find_by_ingredient_ids_categorized(ingredient_ids, max_missing=3)`

Retourne `{"ready": [...], "missing": [...], "shopping": [...]}`
(et `{"ready":[], "missing":[], "shopping":[]}` si l'entrée est vide).

- **`ready`** : recettes dont `missing_ids` est vide (`recipe ⊆ provided`).
  Tuple `(recipe, score, match, total, [], [])`.
  Tri : `(-total_count, recipe.name.lower())` → **les recettes les plus
  garnies d'abord**, puis alphabétique.
- **`missing`** : `1 <= len(missing_ids) <= max_missing`.
  Tuple `(recipe, score, match, total, sorted(missing_ids), missing_names)` où
  `missing_names` est la liste **triée alphabétiquement** des noms manquants.
  Tri : `(len(missing_ids), -total_count, recipe.name.lower())` → le moins de
  manquants d'abord.
- **`shopping`** : suggestions d'achat. **Seules les recettes à EXACTEMENT 1
  ingrédient manquant** alimentent le compteur (`unlock_by_missing_id`).
  Tuple `(ingredient_id, ingredient_name, unlock_count)`, tri
  `(-unlock_count, name.lower())`, **tronqué aux 5 premiers**.
  Le nom vient d'un index global construit au fil de la boucle ; repli
  `f"id {iid}"`.
- `score` est calculé mais vaut toujours 1.0 dans `ready`.

### 5.4 `TagRepo` (`tag.py`)

`list_all()` (`ORDER BY name`), `get(id)`, `find_by_name(name)` (**égalité
stricte, sensible à la casse**), `create(tag)`, `update(tag)` (`ValueError` sans
id, `LookupError` si absent), `delete(tag_id)`.

`delete` : suppression dure ; les `recipe_tag` partent en cascade **grâce au
PRAGMA foreign_keys**. Puis `self.s.expire_all()` — invalidation de l'identity
map SQLAlchemy pour que les `Recipe` déjà chargées ne montrent plus le tag.
**Sans objet en web** (pas de cache d'identité).

### 5.5 `MealPlanRepo` (`meal_plan.py`)

| Méthode | Logique |
|---|---|
| `list_by_week(iso_week)` | `WHERE iso_week = ? ORDER BY day_of_week, slot, ordinal`. ⚠️ **`slot` est trié alphabétiquement sur la chaîne**, pas chronologiquement : l'ordre SQL est `evening, morning, noon, snack_afternoon, snack_morning`. L'ordre chronologique (`morning → snack_morning → noon → snack_afternoon → evening`) est reconstitué **par l'UI**. À porter comme tel ou à corriger par un `CASE`. |
| `add(entry)` | `INSERT` des 8 champs, `flush`, retour hydraté |
| `remove(entry_id)` | `DELETE` silencieux si absent |

Pas de `update` : modifier une entrée = supprimer + rajouter.

### 5.6 `WeeklyCostRepo` (`weekly_cost.py`)

| Méthode | Logique |
|---|---|
| `upsert(snapshot)` | `get` par `iso_week` ; si absent → `INSERT` ; sinon met à jour `total_eur`, `missing_count` **et force** `captured_at = datetime.now(UTC).replace(tzinfo=None)` (le `onupdate` ne se déclencherait pas si les valeurs sont inchangées) |
| `get(iso_week)` | par PK |
| `list_recent(weeks=12)` | `ORDER BY iso_week DESC LIMIT :weeks` puis **`reverse()` en Python** → renvoyé **du plus ancien au plus récent** pour le tracé du graphe. Le tri lexicographique de `'YYYY-Www'` équivaut au tri chronologique (format zéro-padé). |

### 5.7 `PriceHistoryRepo` (`price_history.py`)

| Méthode | Logique |
|---|---|
| `list_for_ingredient(id)` | `ORDER BY recorded_at ASC, id ASC` — déjà prêt pour le graphe |
| `get(entry_id)` | par PK |
| `add(entry)` | `INSERT` (append-only ; **aucun `update`**) |
| `delete(entry_id) -> bool` | `False` si absent |
| `list_known_stores() -> list[str]` | `SELECT DISTINCT store WHERE store IS NOT NULL AND store != '' ORDER BY store ASC` — alimente l'autocomplétion enseigne |
| `latest_for_ingredient(id)` | `ORDER BY recorded_at DESC, id DESC LIMIT 1` |

### 5.8 `PantryRepo` (`pantry.py`)

| Méthode | Logique |
|---|---|
| `list_all()` | `ORDER BY (expiry_date IS NULL), expiry_date ASC, id ASC` → **NULL en dernier**, DLC les plus proches en premier |
| `get(stock_id)` | par PK |
| `list_for_ingredient(id)` | même tri (sans le `id ASC`) |
| `add(stock)` | `INSERT` de `ingredient_id, quantity_g, expiry_date, notes` |
| `update(stock)` | **met à jour uniquement `quantity_g`, `expiry_date`, `notes`** — `ingredient_id` n'est jamais modifié. `ValueError` sans id, `LookupError` si absent |
| `delete(stock_id) -> bool` | `False` si absent |
| `aggregate_quantity_by_ingredient() -> dict[int, float]` | `SELECT ingredient_id, SUM(quantity_g) GROUP BY ingredient_id` ; `float(total or 0)` |
| `expiring_before(deadline)` | `WHERE expiry_date IS NOT NULL AND expiry_date <= :deadline ORDER BY expiry_date ASC` |

Seuils d'affichage (documentés dans le modèle `PantryStock`, appliqués côté UI) :
« À consommer vite » ≤ 5 jours, « À surveiller » ≤ 14 jours, « En stock » le
reste, groupé par `ingredient.category_l1`.

### 5.9 `CookingLogRepo` (`cooking_log.py`)

| Méthode | Logique |
|---|---|
| `list_for_recipe(recipe_id)` | `ORDER BY cooked_at DESC, id DESC` — le plus récent en premier |
| `add(entry)` | `INSERT recipe_id, cooked_at, rating, notes` |
| `delete(entry_id) -> bool` | `False` si absent |
| `count_in_window(recipe_id, days=30) -> int` | `deadline = datetime.now() - timedelta(days=days)` (**heure locale**) puis `SELECT COUNT(id) WHERE recipe_id = ? AND cooked_at >= :deadline` |

### 5.10 `ImportedReceiptRepo` (`imported_receipt.py`)

⚠️ **Ce repo retourne des lignes ORM brutes (`ImportedReceiptRow`), pas des
modèles de domaine** — il n'existe aucun modèle Pydantic pour cette table.

| Méthode | Logique |
|---|---|
| `get(ticket_id) -> ImportedReceiptRow \| None` | `session.get` par PK |
| `exists(ticket_id) -> bool` | `get(...) is not None` |
| `add(ticket_id, store, receipt_date, total_eur, line_count)` | `INSERT`. **Aucune protection contre le doublon** : réinsérer un `ticket_id` existant lève une violation de PK. L'appelant doit passer par `exists()`. |
| `list_recent(limit=20)` | `ORDER BY imported_at DESC LIMIT :limit` |

### 5.11 `ReceiptAliasRepo` (`receipt_alias.py`)

Retourne aussi des `ReceiptAliasRow` bruts.

| Méthode | Logique |
|---|---|
| `find(store, source_key)` | `WHERE store = ? AND source_key = ?` (`scalar_one_or_none`) |
| `upsert(store, source_key, ingredient_id)` | **3 branches** : absent → création avec `hit_count = 1` ; existant **même** `ingredient_id` → `hit_count += 1` (avec repli `(row.hit_count or 0)`) ; existant **autre** `ingredient_id` → réaffectation et **`hit_count` remis à 1**. |
| `delete_for_ingredient(ingredient_id) -> int` | charge les lignes puis les supprime une à une ; retourne le nombre supprimé (utile pour « oublier » un mapping sans supprimer l'ingrédient — la cascade DB gère déjà le cas suppression) |

La normalisation de `source_key` (casefold + espaces collapsés) est faite **en
amont**, dans le service de rapprochement, pas ici.

### 5.12 `LidlPlusSettingsRepo` (`lidl_plus_settings.py`)

Singleton `PK = 1`. `_row()` fait un **upsert paresseux** : si la ligne 1
n'existe pas, elle est créée avec `enabled=0, poll_interval_minutes=60` puis
`flush()`. Toutes les autres méthodes passent par `_row()`.

```python
@dataclass
class LidlPlusSettings:
    enabled: bool = False
    poll_interval_minutes: int = 60
    last_fetched_at: datetime | None = None
    last_error: str | None = None
```

| Méthode | Logique |
|---|---|
| `get() -> LidlPlusSettings` | snapshot (avec `bool(row.enabled)`) |
| `set_enabled(value: bool)` | écrit `1`/`0` |
| `set_poll_interval(minutes: int)` | **`max(5, int(minutes))`** — plancher dur à 5 minutes (anti-DDOS) |
| `mark_fetched(at=None)` | `last_fetched_at = at or datetime.now()` (**heure locale**) **et remet `last_error = None`** |
| `mark_error(message: str)` | `last_error = message[:500]` (**troncature à 500 caractères**) |

⚠️ Aucune de ces méthodes n'appelle `flush()` — elles s'appuient sur l'autoflush
puis le commit du `session_scope`.

### 5.13 `CategoryRepo` (`category.py`)

```python
@dataclass
class CategoryNode:
    id: int; name: str; parent_id: int | None; ordinal: int
    children: list[CategoryNode]
```

| Méthode | Logique |
|---|---|
| `list_l1()` | `WHERE parent_id IS NULL ORDER BY ordinal, name` ; `children` toujours `[]` |
| `list_l2(parent_id)` | `WHERE parent_id = ? ORDER BY ordinal, name` |
| `tree()` | **une seule requête** (`ORDER BY ordinal, name`), regroupement en Python par `parent_id` ; renvoie les L1 avec leurs `children` L2 remplis. (Le docstring dit « 2 queries » — c'est 1.) |
| `find_by_name(name, parent_id)` | égalité stricte, avec `IS NULL` si `parent_id is None` |
| `add(name, parent_id=None) -> CategoryNode` | strip du nom ; `ValueError` si vide ; `ValueError` si un homonyme existe au même niveau ; `ordinal = max(ordinaux des frères, défaut -1) + 1` (donc **ajout en fin**) ; sur `IntegrityError` → `self.s.rollback()` puis `ValueError` |
| `rename(category_id, new_name) -> CategoryNode \| None` | strip ; `ValueError` si vide ; `None` si id inconnu ; no-op si identique ; `ValueError` si homonyme au même niveau ; **puis cascade** : `UPDATE ingredient SET category_l1 = :new WHERE category_l1 = :old` si L1, sinon la même chose sur `category_l2` ; enfin renomme la ligne |
| `delete(category_id) -> bool` | `False` si absent. **L1** : `UPDATE ingredient SET category_l1 = NULL, category_l2 = NULL WHERE category_l1 = :name` ; **L2** : `UPDATE ingredient SET category_l2 = NULL WHERE category_l2 = :name`. Puis `DELETE` de la ligne — les enfants partent par la **FK auto-référencée ON DELETE CASCADE**. |
| `set_ordinal(category_id, ordinal) -> bool` | `max(0, int(ordinal))` ; `False` si absent |

⚠️ **Le cascade de `rename` / `delete` matche le nom GLOBALEMENT**, sans se
limiter au parent : renommer la L2 « Verts » sous « Légumes » renomme aussi le
`category_l2` des ingrédients rangés sous « Verts » d'un **autre** L1. Effet de
bord assumé/non traité dans le code — à décider explicitement au portage.

⚠️ `_to_node(row, *, with_children)` **ignore son paramètre** `with_children` et
renvoie toujours `children=[]` ; seul `tree()` peuple les enfants.

⚠️ Le `self.s.rollback()` de `add()` annule **toute la transaction en cours**,
pas seulement l'insertion — un lot de créations partiellement appliqué serait
entièrement perdu.

---

## 6. Seeds

### 6.1 `ciqual_loader.py`

Point d'entrée : `load_csv(path: Path) -> int` (nom historique ; accepte .xls,
.xlsx ou .csv). Le module est aussi exécutable : `python -m app.data.seeds.ciqual_loader [chemin]`.

#### Découverte du fichier

```python
def default_csv_path() -> Path:
    base = Path(__file__).parent            # app/data/seeds/
    for ext in ("xls", "xlsx", "csv"):
        if (base / f"ciqual.{ext}").exists(): return base / f"ciqual.{ext}"
    return base / "ciqual.csv"
```
Ordre d'essai : `.xls` → `.xlsx` → `.csv`. Le dépôt contient `app/data/seeds/ciqual.xls`.

#### Lecteurs

| Extension | Implémentation |
|---|---|
| `.csv` | `_read_csv` : essaie les encodages `utf-8-sig`, `utf-8`, `latin-1` dans l'ordre ; `csv.Sniffer().sniff(sample, delimiters=";,")` sur les 2048 premiers octets ; `csv.DictReader`. `RuntimeError` si aucun encodage ne passe. |
| `.xls` | `_read_xls` : `xlrd` (**`xlrd<2.0` requis** — la 2.x a retiré le support .xls) ; **feuille d'index 0** ; ligne 0 = en-têtes ; retourne des dicts `zip(headers, row_values)` ; retour vide si `nrows < 2`. |
| `.xlsx` | `_read_xlsx` : `openpyxl`, `read_only=True, data_only=True`, **première feuille** (`wb.sheetnames[0]`), première ligne = en-têtes (`None` → `""`). |

Extension inconnue → `RuntimeError`.

#### Normalisation des en-têtes (`_norm`)

```python
def _norm(s: str) -> str:
    s = s.strip().lower().translate(_FOLD_MAP)   # 1. trim, minuscules, pliage d'accents
    s = re.sub(r"[/\n\t]", " ", s)               # 2. '/', '\n', '\t' -> espace
    s = re.sub(r"\s+", " ", s)                   # 3. espaces multiples collapsés
    return s
```
`_FOLD_MAP` plie explicitement : `à á â ä ã → a`, `é è ê ë → e`, `í ì î ï → i`,
`ó ò ô ö õ → o`, `ú ù û ü → u`, `ý ÿ → y`, `ç → c`. **Uniquement des minuscules**
(le `.lower()` intervient avant, donc les majuscules ASCII sont couvertes ; une
majuscule accentuée en début d'en-tête ne le serait pas — sans conséquence
connue sur les fichiers CIQUAL).

En TypeScript, l'équivalent robuste est
`s.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[/\n\t]/g,' ').replace(/\s+/g,' ')`.

#### Résolution des colonnes (`_resolve_columns`)

Construit `{_norm(header): header}` puis, pour chaque clé logique, prend le
**premier** en-tête dont la forme normalisée figure dans la liste de candidats
(eux-mêmes normalisés). ⚠️ « premier » = premier dans l'ordre d'itération du dict
des en-têtes, pas dans l'ordre de la liste de candidats — l'ordre de priorité des
candidats n'est donc **pas** garanti. Valeur `None` si aucun candidat ne matche.

Table complète `_COLUMN_CANDIDATES` (les candidats sont écrits déjà pliés) :

| clé logique | candidats |
|---|---|
| `code` | `alim_code`, `code` |
| `name` | `alim_nom_fr`, `nom`, `name` |
| `kcal` | `energie, reglement ue n 1169 2011 (kcal 100 g)`, `energie, reglement ue n° 1169 2011 (kcal 100 g)`, `energie (kcal 100 g)`, `energie, n x facteur jones, avec fibres (kcal 100 g)`, `kcal 100g` |
| `proteins` | `proteines, n x facteur de jones (g 100 g)`, `proteines (g 100 g)` |
| `carbs` | `glucides (g 100 g)`, `glucides` |
| `sugars` | `sucres (g 100 g)`, `sucres` |
| `fats` | `lipides (g 100 g)`, `lipides` |
| `saturated_fats` | `ag satures (g 100 g)`, `acides gras satures (g 100 g)` |
| `fiber` | `fibres alimentaires (g 100 g)`, `fibres (g 100 g)` |
| `salt` | `sel chlorure de sodium (g 100 g)`, `sel (g 100 g)` |
| `category_l1` | `alim_grp_nom_fr` |
| `category_l2` | `alim_ssgrp_nom_fr` |

Si `code` **ou** `name` est introuvable → `RuntimeError` explicite listant les
10 premiers en-têtes vus. Toutes les autres colonnes absentes → valeur `None`.

**Non lues** : `alim_ssssgrp_nom_fr` (3ᵉ niveau CIQUAL), eau, cendres, alcool,
vitamines, minéraux, tous les codes de groupe numériques. Le portage ne perd rien
s'il conserve le même sous-ensemble.

#### Parsing des cellules (`_parse_float`)

Ordre exact des tests :

| Entrée | Sortie |
|---|---|
| `None` | `None` |
| `int` / `float` | `float(raw)` — **y compris `0.0`** (un 0 est significatif : l'eau fait 0 kcal ; le code note explicitement qu'on ne peut pas distinguer « vide » d'un 0 en .xls et qu'on garde le 0) |
| `""` ou `"-"` (après strip) | `None` |
| `"traces"` / `"trace"` (insensible à la casse) | **`0.0`** |
| chaîne commençant par `"<"` (ex. `"< 0.1"`) | **`0.0`** (conservateur, pour ne pas gonfler les totaux) |
| autre chaîne | `,`→`.`, suppression des espaces et des espaces insécables `\xa0`, puis `float(...)` ; en cas d'échec → `None` + log `DEBUG` |

**Jamais d'exception levée.**

#### Boucle d'upsert

```python
engine = make_engine(); init_schema(engine)      # (le loader initialise le schéma lui-même)
rows = list(_read_any(path))                     # TOUT est chargé en mémoire
headers = list(rows[0].keys()); cols = _resolve_columns(headers)
with session_scope(factory) as session:
    repo = IngredientRepo(session)
    for row in rows:
        code = str(row.get(cols["code"]) or "").strip()
        name = str(row.get(cols["name"]) or "").strip()
        if not code or not name: continue        # ligne ignorée
        if code.endswith(".0"): code = code[:-2] # '20055.0' -> '20055'
        ...
        existing = repo.find_by_source_ref(Source.CIQUAL, code)
        if existing is not None and existing.in_personal_library:
            ing = ing.model_copy(update={"in_personal_library": True})
        repo.upsert_by_source_ref(ing)
        count += 1
```

Points clés :
- fichier absent → log `WARNING` et retour `0` (pas d'exception) ; fichier vide
  → log `WARNING` et retour `0` ;
- lignes sans code **ou** sans nom : **ignorées silencieusement** ;
- normalisation du `alim_code` : les lecteurs xls remontent les nombres en float,
  d'où le retrait du suffixe `.0` ;
- `category_l1` / `category_l2` : `str(...).strip()`, converties en `None` si
  vides (`cat_l1 or None`) ;
- **`in_personal_library` est posé à `False`**, sauf si la ligne existe déjà avec
  le drapeau à `True` → alors préservé. **C'est la seule protection** ; un
  re-seed écrase en revanche systématiquement nom, macros et catégories, y
  compris les corrections manuelles de l'utilisateur sur une ligne CIQUAL ;
- `brand`, `price_eur`, `price_quantity_g`, `piece_weight_g`,
  `cooked_weight_per_100g_raw`, `season_months` ne sont **jamais** écrits par le
  loader → **ils sont donc remis à `None` à chaque re-seed** (via `_ing_apply`,
  qui écrit *tous* les champs du modèle). ⚠️ **Perte de données silencieuse** sur
  un re-seed : un prix ou un poids de pièce saisi sur un ingrédient CIQUAL
  disparaît. `season_months` est ensuite reposé par `_seed_seasonality` au
  prochain `init_schema()`, mais pas le reste. **Point à corriger au portage.**
- **une seule transaction pour les ~3 500 lignes** ; retour = nombre de lignes
  traitées.

**Portage** : ni `xlrd` ni `openpyxl` n'existent dans un Worker. Le chargement
CIQUAL doit devenir une étape **hors ligne** : convertir le .xls en JSON/NDJSON
une fois pour toutes, puis générer un fichier SQL d'`INSERT` chargé via
`wrangler d1 execute --file`. Le sous-lot pertinent est
`(alim_code, alim_nom_fr, alim_grp_nom_fr, alim_ssgrp_nom_fr, 8 macros)`.
Alternative : reconstruire les ~4 177 lignes actuelles directement depuis la base
existante (`SELECT` + génération d'`INSERT`), ce qui préserve du même coup les
prix, marques, saisonnalités et drapeaux déjà saisis.

### 6.2 `seasons.py`

Un unique dict `SEASONS_BY_NAME: dict[str, str]` — **56 entrées**, clé = préfixe
de nom en minuscules, valeur = CSV de mois `1..12`. Consommé exclusivement par
`_seed_seasonality`. Contenu intégral :

| Groupe | Entrées (préfixe → mois) |
|---|---|
| Légumes (28) | `ail`→6,7,8,9,10,11,12,1,2 · `artichaut`→5,6,7,8,9,10 · `asperge`→4,5,6 · `aubergine`→7,8,9,10 · `betterave`→6,7,8,9,10,11,12 · `blette`→6,7,8,9,10,11 · `brocoli`→9,10,11,12,1,2,3 · `carotte`→1..12 · `céleri`→8,9,10,11,12,1,2 · `chou`→9,10,11,12,1,2,3,4 · `concombre`→5,6,7,8,9 · `courge`→9,10,11,12 · `courgette`→5,6,7,8,9,10 · `endive`→10,11,12,1,2,3,4 · `épinard`→3,4,5,6,9,10,11 · `fenouil`→5,6,7,8,9,10,11 · `haricot vert`→6,7,8,9 · `navet`→9,10,11,12,1,2,3,4 · `oignon`→1..12 · `panais`→10,11,12,1,2,3 · `petit pois`→5,6,7 · `poireau`→9,10,11,12,1,2,3,4,5 · `poivron`→6,7,8,9,10 · `pomme de terre`→1..12 · `potiron`→9,10,11,12,1 · `radis`→3,4,5,6,7,8,9,10 · `salade`→4,5,6,7,8,9,10 · `tomate`→6,7,8,9,10 |
| Fruits (20) | `abricot`→6,7,8 · `cerise`→5,6,7 · `citron`→11,12,1,2,3,4 · `clémentine`→11,12,1 · `fraise`→4,5,6,7 · `framboise`→6,7,8,9 · `kiwi`→11,12,1,2,3 · `mangue`→12,1,2,3 · `melon`→6,7,8,9 · `mirabelle`→8,9 · `myrtille`→7,8,9 · `nectarine`→6,7,8,9 · `orange`→11,12,1,2,3,4 · `pamplemousse`→11,12,1,2,3,4 · `pêche`→6,7,8,9 · `poire`→8,9,10,11,12,1 · `pomme`→8,9,10,11,12,1,2,3,4 · `prune`→7,8,9 · `raisin`→8,9,10 · `rhubarbe`→4,5,6,7 |
| Champignons (3) | `champignon de Paris`→1..12 · `cèpe`→9,10,11 · `girolle`→6,7,8,9,10 |
| Aromates frais (5) | `basilic`→5,6,7,8,9 · `ciboulette`→4,5,6,7,8,9 · `menthe`→5,6,7,8,9,10 · `persil`→1..12 · `thym`→1..12 |

(« 1..12 » = la chaîne littérale `"1,2,3,4,5,6,7,8,9,10,11,12"`.)

⚠️ **L'ordre d'insertion du dict est significatif** : le seeder n'écrit que si
`season_months IS NULL`, donc le premier motif qui matche gagne définitivement.
Cas critique : `pomme de terre` (section Légumes, déclaré en premier) est traité
**avant** `pomme` (section Fruits) → les pommes de terre reçoivent bien
`1..12` et non `8,9,10,11,12,1,2,3,4`. Vérifié en base. Ce comportement correct
est **fortuit et fragile** : au portage, trier explicitement les motifs du plus
long au plus court plutôt que de dépendre de l'ordre de déclaration.

⚠️ Le préfixe `champignon de Paris` avec un `P` majuscule fonctionne car le
`lower()` est appliqué des deux côtés (lettres ASCII uniquement).

Notes de conception (issues des docstrings) : mois 1 = janvier ; disponibilité
française locale (contexte Côte-d'Or), serre et import volontairement ignorés
sauf `mangue` (saison hivernale d'import) ; sources Greenpeace France + ADEME ;
valeur éditable par l'utilisateur et jamais réécrite ensuite.

### 6.3 `app/data/seeds/__init__.py`

Vide.

### 6.4 ⚠️ Le catalogue CIQUAL n'est PAS chargé automatiquement

Contrairement à ce qu'affirme `CLAUDE.md` (« seeds CIQUAL on first launch »),
`load_csv` n'est appelé **nulle part** dans le code applicatif — vérifié par
recherche globale : les seules occurrences sont dans `ciqual_loader.py` lui-même.
Ni `app/main.py`, ni `AppContext.from_default()`, ni `run.bat` ne le déclenchent.
Le peuplement du catalogue est donc **une action manuelle** :
`python -m app.data.seeds.ciqual_loader`.

---

## 7. Vue d'ensemble du graphe de dépendances (pour l'ordre de migration)

```
ingredient  ◄── recipe_ingredient (RESTRICT) ──► recipe
            ◄── meal_plan_entry (CASCADE)    ──► recipe
            ◄── pantry_stock (CASCADE)
            ◄── ingredient_price_history (CASCADE)
            ◄── receipt_alias (CASCADE)
recipe      ◄── recipe_tag (CASCADE) ──► tag
            ◄── recipe_cooking_log (CASCADE)
category_definition ──► category_definition (auto, CASCADE)
imported_receipt / meal_plan_template / weekly_cost_snapshot / lidl_plus_settings : isolées
ingredient  ──(triggers)──► ingredient_fts
```

Ordre d'insertion sûr : `ingredient`, `recipe`, `tag` → `recipe_ingredient`,
`recipe_tag`, `meal_plan_entry`, `pantry_stock`, `ingredient_price_history`,
`recipe_cooking_log`, `receipt_alias` → `category_definition` (L1 avant L2) →
tables isolées → `rebuild` FTS.

---

## 8. Synthèse des points de portage délicats

| # | Sujet | Détail | Proposition web |
|---|---|---|---|
| 1 | **FTS5 sur D1** | Cœur de la recherche d'ingrédients (4 177 lignes). Table à contenu externe + 3 triggers + tokenizer `unicode61 remove_diacritics 2`. | Valider FTS5 sur D1 **avant tout le reste**. Plan B : colonne `name_normalized` + `LIKE 'tok%'` (tri par `name`, perte du `rank`). |
| 2 | **Reconstruction de l'index FTS** | Aucun `'rebuild'` dans le code ; l'index n'est peuplé que par les triggers. | Après l'import de masse, exécuter `INSERT INTO ingredient_fts(ingredient_fts) VALUES('rebuild')`. |
| 3 | **Défauts de colonnes absents du DDL** | Une douzaine de colonnes `NOT NULL` sans `DEFAULT` (l'ORM les remplissait). | Ajouter les `DEFAULT` en SQL dans les migrations D1 (liste au § 2.0.1). |
| 4 | **`updated_at` n'est pas géré par la base** | `onupdate=func.now()` est côté client SQLAlchemy. | Poser `updated_at` dans chaque `UPDATE`, ou trigger `AFTER UPDATE`. |
| 5 | **Fuseaux et formats de dates mélangés** | `CURRENT_TIMESTAMP` = UTC sans microsecondes ; `datetime.now()` = local avec microsecondes ; `WeeklyCostRepo` = UTC naïf. | Normaliser en ISO-8601 UTC (ou epoch ms) **au moment de la migration des données**, pas après. |
| 6 | **`Decimal` → REAL/INTEGER** | `NUMERIC(10,4)` stocke des flottants (valeur `12` de type `integer` observée). | Centimes entiers, ou `TEXT` décimal + parsing contrôlé côté Worker. |
| 7 | **Toutes les règles métier sont dans Pydantic, pas en base** | `> 0`, `>= 0`, plages, `portions` obligatoire si recette, `rating` 1-5, `day_of_week` 0-6, format ISO-week. Seul le XOR `meal_plan_entry` est un vrai `CHECK`. | Réimplémenter la validation (Zod) au niveau du Worker, et/ou ajouter les `CHECK` correspondants en D1. |
| 8 | **`ON DELETE RESTRICT` sur `recipe_ingredient.ingredient_id`** | Un ingrédient utilisé dans une recette ne peut pas être supprimé (erreur d'intégrité remontée à l'UI). | Comportement à conserver ; prévoir un message d'erreur explicite côté API. |
| 9 | **Unicité des catégories L1 non contrainte** | `UNIQUE(parent_id, name)` avec `parent_id NULL` n'empêche pas les doublons racine. | `UNIQUE (COALESCE(parent_id, -1), name)`. |
| 10 | **Cascade de renommage/suppression de catégories, globale** | Match sur le seul nom, sans tenir compte du parent. | Décider explicitement : soit scoper au parent, soit basculer `category_l1/l2` en vraies FK. |
| 11 | **Index redondants** | 4 index dupliqués (`index=True` + `Index(...)`). | Ne pas les recréer. |
| 12 | **`VARCHAR(10)` trop court pour `slot`** | `'snack_afternoon'` fait 15 caractères. | `TEXT` + `CHECK (slot IN (...))`. |
| 13 | **Tri de `slot` alphabétique en base** | `list_by_week` renvoie `evening, morning, noon, snack_afternoon, snack_morning` ; l'ordre chronologique est reconstruit par l'UI. | Trier avec un `CASE` explicite côté API, plus robuste. |
| 14 | **Sauvegardes fichier + restauration** | API `sqlite3.backup`, rotation 7 j + 6 mois, `shutil.copy2`, chemins `~/.prandia/`. | D1 Time Travel + export cron vers R2. Retirer l'écran de restauration ou le brancher sur l'API D1. |
| 15 | **Lecture .xls / .xlsx** | `xlrd<2.0` / `openpyxl`, système de fichiers local. | Conversion hors ligne en SQL/NDJSON, chargé via `wrangler d1 execute --file`. Ou export direct depuis la base actuelle. |
| 16 | **Secrets Lidl** | Hors base, dans le Windows Credential Manager (`keyring`). | Cloudflare Secrets / Secrets Store ; jamais en D1. |
| 17 | **`ORDER BY` avec ids `IN (...)`** | L'ordre est reconstitué en Python après hydratation. | Idem en TS, ou une seule requête avec `JOIN` et `ORDER BY` conservé. |
| 18 | **Paramètres nommés** | Le SQL brut de `_search_page` utilise `:nom`. | D1 n'accepte que des `?` positionnels : convertir en gardant l'ordre de construction des clauses. |
| 19 | **Transaction unique de `init_schema()`** | 8 migrations + 3 seeders + 4 DDL FTS dans un seul `engine.begin()`. | D1 : un fichier de migration par étape ; le rejeu à chaque démarrage doit disparaître au profit de `wrangler d1 migrations`. |
| 20 | **Code mort** | `app/data/repositories.py` (fichier plat) masqué par le package homonyme. | Ne pas porter. |

---

## 9. Ambiguïtés, incohérences et bugs relevés

1. **Bug confirmé — accents en tête de motif dans `_seed_seasonality`.**
   `lower()` de SQLite est ASCII-only : `'épinard%'` ne matche aucun des 6
   `'Épinard%'` de la base. Mesuré. À corriger avec un pliage applicatif.
2. **Perte de données au re-seed CIQUAL.** `_ing_apply` écrit tous les champs du
   modèle ; le loader ne renseigne ni `brand`, ni les prix, ni `piece_weight_g`,
   ni `cooked_weight_per_100g_raw`, ni `season_months` → un re-seed les remet à
   `NULL`. Seul `in_personal_library` est explicitement protégé. Contredit
   frontalement le docstring « sans clobber ».
3. **Injection de syntaxe FTS5** via un `"` dans la requête utilisateur
   (`to"mate` → erreur SQL non rattrapée). Pas une injection SQL (le paramètre
   est lié), mais une erreur 500 déclenchable par une saisie normale.
4. **`ordinal = line.ordinal or idx`** : un `ordinal` explicitement à 0 en
   position non-nulle est écrasé par l'index de boucle. Intention ambiguë.
5. **`_migrate_add_in_personal_library`** promeut les lignes `manual` et
   `openfoodfacts` **uniquement** lors de l'ajout de la colonne. Sur une base
   neuve, la promotion n'a jamais lieu — cohérent avec la doc mais asymétrique.
6. **Ordre de résolution des colonnes CIQUAL** : `_resolve_columns` itère sur les
   en-têtes du fichier, pas sur la liste ordonnée de candidats. Si un fichier
   contient deux colonnes énergie candidates, laquelle gagne dépend de l'ordre
   des colonnes du fichier. Comportement non spécifié.
7. **Le seeder de saisonnalité dépend de l'ordre de déclaration du dict.**
   Le cas `pomme` / `pomme de terre` produit le bon résultat uniquement parce que
   `pomme de terre` est déclaré plus haut dans le fichier. Fragile.
8. **`_to_node(..., with_children=...)` ignore son paramètre.** Paramètre mort.
9. **`CategoryRepo.add` fait `self.s.rollback()`** sur `IntegrityError`, annulant
   toute la transaction en cours, pas seulement l'insertion fautive.
10. **`CategoryRepo.tree()` fait 1 requête**, son docstring en annonce 2.
11. **Cascade de catégories non scopée au parent** (§ 5.13) — effet de bord
    inter-branches.
12. **`SearchPage` non borné dans les retours anticipés** (`opts.page` brut au
    lieu de `max(1, opts.page)`), incohérence mineure de contrat.
13. **Filtres macro et `NULL`** : filtrer sur `min_proteins` exclut
    silencieusement tous les ingrédients dont la protéine est inconnue. Choix non
    documenté dans le code — à trancher pour la webapp.
14. **`ImportedReceiptRepo.add` ne protège pas du doublon de PK** ; le contrat
    « appeler `exists()` d'abord » est implicite.
15. **`LidlPlusSettingsRepo` n'appelle jamais `flush()`** dans ses setters —
    dépend de l'autoflush SQLAlchemy. Sans équivalent en accès SQL direct : il
    faudra de vrais `UPDATE`.
16. **`imported_receipt.store` / `receipt_alias.store`** sont des chaînes libres
    sans contrainte. Valeurs constatées / attendues : `intermarche`, `lidl`,
    `carrefour` (« TBD » pour le format d'identifiant Carrefour).
17. **`recipe.image_path`** est un chemin du système de fichiers local — la
    sémantique doit changer (clé R2 / URL) et les valeurs existantes sont
    probablement inexploitables telles quelles.
18. **`CLAUDE.md` / `architecture.md` périmés** : ils ne mentionnent ni
    `category_definition`, ni `imported_receipt`, ni `receipt_alias`, ni
    `lidl_plus_settings`, ni `meal_plan_template`, ni `pantry_stock`, ni
    `recipe_cooking_log`, ni `ingredient_price_history`, ni `weekly_cost_snapshot`,
    ni la source `'lidl'`, ni les colonnes `brand`, `season_months`,
    `cooked_weight_per_100g_raw`, `recipe_ingredient.unit`, et affirment à tort
    que CIQUAL est semé au premier lancement.
