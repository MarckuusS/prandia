# 03 — Services cœur : spécification de portage

Inventaire fidèle, établi à la lecture du **code réel** (aucune reprise de `CLAUDE.md` /
`architecture.md`, qui sont périmés). Périmètre :

| Fichier source (chemins absolus) |
|---|
| `<racine-du-depot>/app\services\openfoodfacts.py` |
| `…\app\services\ingredient_search.py` |
| `…\app\services\nutrition_service.py` |
| `…\app\services\shopping_service.py` |
| `…\app\services\meal_plan_service.py` |
| `…\app\services\pricing_history_service.py` |

Modules lus en support (pour les formules et les requêtes exactes) :
`app\domain\models.py`, `app\domain\nutrition.py`, `app\domain\pricing.py`,
`app\domain\shopping.py`, `app\domain\units.py`,
`app\data\repositories\{__init__,_search,_mappers,ingredient,recipe,meal_plan,pantry,price_history,category}.py`,
`app\data\db.py`, `app\data\orm.py`, `app\ui\app_context.py`,
`app\ui\viewmodels\{shopping_vm,calendar_vm,network_vm,ingredient_vm}.py`,
`tests\test_{openfoodfacts,shopping_service,meal_plan_service,meal_plan_templates,ingredient_search}.py`.

> **Piège de packaging à connaître** : il existe **deux** entités nommées `repositories` :
> `app\data\repositories.py` (fichier, ~508 lignes) **et** `app\data\repositories\` (package).
> Python résout `app.data.repositories` **vers le package** (vérifié par import réel :
> la trace d'erreur pointe sur `app\data\repositories\category.py`).
> **`app\data\repositories.py` est donc du code mort** : il ne contient ni `PantryRepo`,
> ni `PriceHistoryRepo`, ni `list_by_ids`, ni `find_by_name`. Ne pas s'y référer.

---

## 0. Conventions transverses

### 0.1 Transaction / session

Tous les services reçoivent une `Session` SQLAlchemy en premier argument et **ne committent
jamais** eux-mêmes (sauf `flush()` interne des repos). Le commit est fait par l'appelant.
Côté UI, `AppContext.session()` (`app\ui\app_context.py`) délègue à
`db.session_scope()` qui fait : `yield session` → `session.commit()` en sortie normale,
`session.rollback()` sur exception, `session.close()` en `finally`.

Conséquence : **le contexte `with ctx.session() as s:` commit automatiquement en sortie**.
Les `s.commit()` explicites dans certains viewmodels sont donc redondants (mais inoffensifs).

**Portage web** : un handler Worker = une unité de travail. D1 n'a pas de transactions
interactives multi-requêtes ; utiliser `db.batch([...])` pour l'atomicité des écritures
groupées, ou accepter la non-atomicité là où le code Python la garantissait
(copie de semaine, application de template, import de ticket).

### 0.2 Types

- **Argent** : `decimal.Decimal` partout côté Python. Aucune arithmétique flottante sur les
  euros. **Portage** : ne pas utiliser `number` JS. Utiliser des **centimes entiers**
  (`bigint`/`number` entier) ou une lib décimale, et reproduire les arrondis décrits en §4.3.
- **Poids** : `float` en grammes partout (stockage et calcul).
- **Enums** : `Source` = `'ciqual' | 'openfoodfacts' | 'manual' | 'lidl'` (le membre `LIDL`
  existe bel et bien dans `app\domain\models.py` — `source_ref` y stocke l'`art_id` Lidl).
  `MealSlot` = `'morning' | 'snack_morning' | 'noon' | 'snack_afternoon' | 'evening'`.
- **Semaine ISO** : chaîne `'YYYY-Www'` exactement 8 caractères, `v[4:6] == '-W'`,
  année 2000..2100, semaine 01..53 (validateur `IsoWeek`).

---

## 1. `openfoodfacts.py` — client OpenFoodFacts

### 1.1 Constantes exactes

```python
_BASE_URL        = "https://world.openfoodfacts.org"
_SEARCH_BASE_URL = "https://search.openfoodfacts.org"
_HEALTH_HOST     = "https://search.openfoodfacts.org/"
_USER_AGENT      = "prandia/0.1.0 (+https://github.com/MarckuusS/prandia)"
_TIMEOUT         = httpx.Timeout(10.0, connect=5.0)   # connect 5 s, read/write/pool 10 s

_PRODUCT_FIELDS = "code,product_name,product_name_fr,brands,nutriments"
```

`_make_client(base_url=_BASE_URL)` construit un `httpx.Client` avec :
- `base_url` = l'un des deux hôtes,
- `timeout` = `_TIMEOUT`,
- `headers = {"User-Agent": _USER_AGENT, "Accept": "application/json"}`.

Aucun `follow_redirects` explicite → valeur httpx par défaut (**False**) pour ce client.

### 1.2 `OpenFoodFactsError(RuntimeError)`

Exception métier unique du module. Message **en français, destiné à l'utilisateur**, produit
par `_friendly_http_error(exc)` :

| Condition | Message exact |
|---|---|
| `HTTPStatusError` code ∈ {502, 503, 504} | `"OpenFoodFacts est temporairement indisponible (HTTP {code}). Réessaie dans quelques minutes."` |
| `HTTPStatusError` code == 429 | `"Trop de requêtes vers OpenFoodFacts (HTTP 429). Attends une minute avant de réessayer."` |
| autre `HTTPStatusError` | `"OpenFoodFacts a renvoyé une erreur HTTP {code}."` |
| `TimeoutException` | `"OpenFoodFacts ne répond pas (timeout). Vérifie ta connexion."` |
| `ConnectError` | `"Impossible de joindre OpenFoodFacts. Vérifie ta connexion internet."` |
| autre `HTTPError` | `"Erreur réseau OpenFoodFacts : {exc}"` |

### 1.3 `is_off_alive(timeout: float = 3.0) -> bool`

- Requête : **`GET https://search.openfoodfacts.org/`** (avec le slash final).
- Client dédié : `httpx.Client(timeout=3.0, follow_redirects=False)`, en-tête
  `User-Agent: prandia/0.1.0 (+https://github.com/MarckuusS/prandia)` uniquement
  (**pas** de `Accept`).
- Retourne `True` ssi `200 <= status_code < 400`.
- Capture `TimeoutException`, `HTTPError`, `OSError` → `False`. Ne lève jamais.
- **Motif documenté dans le code** : `HEAD` est refusé par Search-a-licious
  (`405 Method Not Allowed` sur `/` et `/health`) ; `GET /` renvoie une **302** avec corps
  vide, d'où la plage 2xx/3xx et le non-suivi des redirections (un seul aller-retour).
- Consommateur : `NetworkStatusViewModel` (`app\ui\viewmodels\network_vm.py`) — ping toutes
  les **5 min** (`_DEFAULT_INTERVAL_MS = 300000`), premier ping à **+2 s** du démarrage
  (`_INITIAL_DELAY_MS = 2000`), exécuté dans un `threading.Thread(daemon=True, name="off-ping")`,
  garde `_inflight` pour ne pas empiler les pings, état initial optimiste `online = True`.

### 1.4 `_f(value) -> float | None`

Conversion float « best effort » :
```
None ou "" → None ; sinon float(value) ; TypeError/ValueError → None
```
Note : `0` et `0.0` passent (car `0 == ""` est `False` en Python) et donnent `0.0`.

### 1.5 `_product_to_ingredient(product: dict) -> Ingredient | None`

Mapping **champ par champ** d'un hit OFF (que ce soit `/api/v2/product` ou `/search`) :

| Champ JSON OFF | Champ `Ingredient` | Règle |
|---|---|---|
| `code` | `source_ref` | `str(code)`. **Si absent/falsy → retourne `None`** (produit ignoré) |
| `product_name_fr` → `product_name` → `generic_name_fr` → `generic_name` | `name` | Premier non-vide dans cet ordre, puis `.strip()`. **Si aucun → retourne `None`** |
| `brands` | `brand` | Si **liste** non vide → `str(brands[0]).strip() or None`. Si **str** non vide → `brands.split(",")[0].strip() or None`. Sinon `None`. *(`brands` est une chaîne CSV sur `/api/v2/product`, une liste sur `/search`)* |
| — | `source` | Constante `Source.OPENFOODFACTS` |
| `nutriments["energy-kcal_100g"]` | `kcal_per_100g` | `_f(...)` |
| `nutriments["energy_100g"]` (fallback) | `kcal_per_100g` | Seulement si `energy-kcal_100g` a donné `None` **et** `energy_100g is not None` : `round(kJ / 4.184, 1)` |
| `nutriments["proteins_100g"]` | `proteins_g` | `_f` |
| `nutriments["carbohydrates_100g"]` | `carbs_g` | `_f` |
| `nutriments["sugars_100g"]` | `sugars_g` | `_f` |
| `nutriments["fat_100g"]` | `fats_g` | `_f` |
| `nutriments["saturated-fat_100g"]` | `saturated_fats_g` | `_f` |
| `nutriments["fiber_100g"]` | `fiber_g` | `_f` |
| `nutriments["salt_100g"]` | `salt_g` | `_f` |

`nutriments` absent → `{}` (aucun crash). Tous les autres champs de `Ingredient`
(`price_eur`, `piece_weight_g`, `category_l1/l2`, `in_personal_library`,
`cooked_weight_per_100g_raw`, `season_months`…) restent aux **valeurs par défaut**
(`None` / `False`).

**Attention (incohérence relevée)** : `_PRODUCT_FIELDS` ne demande **pas** `generic_name` /
`generic_name_fr`, alors que le mapping les lit. Ce fallback est donc **mort** en pratique
tant que le paramètre `fields` est envoyé. À porter tel quel (ou à corriger sciemment en
ajoutant les champs à la liste).

### 1.6 `lookup_barcode(ean, *, client=None) -> Ingredient | None`

Algorithme :
1. `ean = ean.strip()`. Si `not ean.isdigit()` → **`ValueError(f"barcode must be digits only, got {ean!r}")`**
   (levée avant tout réseau ; ce n'est pas une `OpenFoodFactsError`).
2. Requête : **`GET https://world.openfoodfacts.org/api/v2/product/{ean}`**
   avec query string `?fields=code,product_name,product_name_fr,brands,nutriments`.
3. `status_code == 404` → retourne `None` (pas d'exception).
4. Sinon `raise_for_status()` puis `resp.json()`.
5. Toute `httpx.HTTPError` → `OpenFoodFactsError(_friendly_http_error(exc))` (chaînée `from exc`).
6. `finally` : ferme le client **seulement s'il a été créé en interne** (`client=None` en entrée).
7. Si `data.get("status") != 1` → `None` (convention OFF : `1` = trouvé, `0` = introuvable).
8. Sinon `_product_to_ingredient(data.get("product") or {})`.

**Effet de bord** : aucun. La persistance est à la charge de l'appelant
(`IngredientRepo.upsert_by_source_ref`).

### 1.7 `_OFF_SORT_MAP` — table complète

```python
_OFF_SORT_MAP: dict[str, str | None] = {
    "name_asc":      "product_name",
    "name_desc":     "-product_name",
    "kcal_asc":      None,
    "kcal_desc":     None,
    "proteins_asc":  None,
    "proteins_desc": None,
    "carbs_asc":     None,
    "carbs_desc":    None,
    "fats_asc":      None,
    "fats_desc":     None,
}

OFF_UNSUPPORTED_SORTS = {code for code, mapped in _OFF_SORT_MAP.items() if mapped is None}
# == {"kcal_asc","kcal_desc","proteins_asc","proteins_desc",
#     "carbs_asc","carbs_desc","fats_asc","fats_desc"}
```

Le préfixe `-` côté API = ordre décroissant. **Search-a-licious refuse les champs
`nutriments.*` comme clé de tri (HTTP 400 « must be a valid field name »)** ; seuls
`product_name`, `popularity_key`, `unique_scans_n`, `completeness`, `last_modified_t`
sont acceptés (commentaire du code). D'où le mapping vers `None` : on n'envoie alors
**aucun** `sort_by` (tri par pertinence, défaut API), et l'UI (dialogue d'import) affiche
un avertissement + trie la page côté client. `OFF_UNSUPPORTED_SORTS` est exporté et
consommé par `app\ui\widgets\import_dialog.py`.

### 1.8 `_build_lucene_query(text_query, filters) -> str`

Construit la requête Lucene envoyée en paramètre `q`.

```
parts = []
si text_query.strip() non vide : parts.append(text_query.strip())

# 4 plages numériques, dans CET ordre :
("nutriments.energy-kcal_100g",   filters["min_kcal"],     filters["max_kcal"])
("nutriments.proteins_100g",      filters["min_proteins"], filters["max_proteins"])
("nutriments.carbohydrates_100g", filters["min_carbs"],    filters["max_carbs"])
("nutriments.fat_100g",           filters["min_fats"],     filters["max_fats"])

pour chaque (field, lo, hi) :
    si lo is None et hi is None : continue
    lo_str = str(lo) si lo non None sinon "*"
    hi_str = str(hi) si hi non None sinon "*"
    parts.append(f"{field}:[{lo_str} TO {hi_str}]")

cat = filters["category_tag"]
si cat (truthy) : parts.append(f'categories_tags:"{cat}"')

return " AND ".join(parts) si parts else "*:*"
```

Points précis :
- `filters` est un **dict simple** (`None` accepté → `{}`), pas une dataclass.
- Les bornes sont **inclusives** (syntaxe Lucene `[lo TO hi]`).
- `str(lo)` sur un float Python → `"5.0"`, `"30.0"` (le test vérifie littéralement
  `nutriments.proteins_100g:[5.0 TO 30.0]`). **Le portage TS doit reproduire ce formatage**
  (`5` en JS donnerait `"5"` — sémantiquement équivalent pour l'API, mais différent).
- La catégorie est **entourée de guillemets Lucene** pour tolérer le `:` du tag
  (`categories_tags:"fr:yaourts"`).
- Aucune échappement des caractères Lucene réservés dans `text_query` : la saisie
  utilisateur passe **brute**. Un `(`, `"` ou `AND` tapé par l'utilisateur peut casser la
  requête → **ambiguïté / fragilité à noter**.
- Exemples produits (docstring) :
  - `"tomate"`
  - `"tomate AND nutriments.proteins_100g:[10 TO *]"`
  - `"yaourt AND nutriments.proteins_100g:[5 TO 30] AND categories_tags:\"fr:yaourts\""`

### 1.9 `search_by_name(query, *, page=1, page_size=25, sort_by=None, filters=None, client=None) -> tuple[list[Ingredient], int]`

Algorithme :
1. `q_text = query.strip()`.
2. **Court-circuit** : `if not q_text and not filters: return [], 0` — aucun appel réseau.
   ⚠ Le test `not filters` est une **évaluation de vérité** : un dict **vide** `{}` court-circuite,
   un dict **non vide dont toutes les valeurs sont `None`** ne court-circuite **pas**
   (cf. le bug §7.2).
3. `lucene_q = _build_lucene_query(q_text, filters)`.
4. Paramètres de query string (ordre d'insertion du dict Python, conservé par httpx) :

| Paramètre | Valeur |
|---|---|
| `q` | `lucene_q` |
| `page` | `max(1, page)` |
| `page_size` | `max(1, page_size)` |
| `fields` | `"code,product_name,product_name_fr,brands,nutriments"` |
| `langs` | `"fr,en"` (constante, toujours envoyée) |
| `sort_by` | **présent uniquement** si `sort_by` est fourni **et** `_OFF_SORT_MAP.get(sort_by)` est non-`None` |

   Un `sort_by` inconnu de la table (`.get()` → `None`) est traité comme non supporté :
   paramètre omis, silencieusement.
5. Requête : **`GET https://search.openfoodfacts.org/search`** (client basé sur
   `_SEARCH_BASE_URL`), en-têtes `User-Agent` + `Accept: application/json`.
6. `raise_for_status()` puis `.json()` ; toute `httpx.HTTPError` → `OpenFoodFactsError(...)`.
7. `finally` : fermeture du client seulement s'il a été créé en interne.
8. Réponse attendue : `{"hits": [...], "count": N}`.
   - Parcours de `data.get("hits") or []` → `_product_to_ingredient` → on **écarte** les
     `None` (produits sans `code` ou sans nom).
   - `total = int(data.get("count") or 0)` — nombre total de résultats **toutes pages
     confondues** (sert à la pagination UI).
9. Retourne `(matches, total)`.

**Effet de bord** : aucun (pas de persistance ici).

### 1.10 Spécificités `httpx` → portage Cloudflare Worker

| Élément httpx | Équivalent Worker (`fetch`) |
|---|---|
| `httpx.Client(base_url=…)` + chemins relatifs (`/search`, `/api/v2/product/{ean}`) | Concaténer explicitement l'origine et le chemin ; il n'y a pas de `base_url` dans `fetch` |
| `params={...}` | `new URLSearchParams({...})`. **Attention à l'encodage** : httpx sérialise via `urlencode` (sémantique `quote_plus` : espace → `+`, `:` → `%3A`, `[`/`]` → `%5B`/`%5D`, `"` → `%22`, `,` → `%2C`). `URLSearchParams` encode l'espace en `+` également → compatible. `encodeURIComponent` donnerait `%20` (accepté aussi par l'API, mais ce n'est pas byte-identique) |
| `headers={"User-Agent": …, "Accept": …}` | ⚠ **Cloudflare Workers écrase/force `User-Agent`** sur les requêtes sortantes dans certains environnements. Vérifier que l'UA custom passe bien ; sinon OFF applique un rate-limit plus agressif. Prévoir un fallback (paramétrer l'UA via var d'env) |
| `httpx.Timeout(10.0, connect=5.0)` | Pas de timeout natif dans `fetch` : utiliser `AbortSignal.timeout(10_000)` (le Worker n'expose pas de timeout de connexion séparé — un seul budget de 10 s est une approximation acceptable) |
| `resp.raise_for_status()` | Tester `if (!res.ok) throw …` — mais **attention** : `lookup_barcode` traite `404` **avant** `raise_for_status`, et `is_off_alive` accepte 3xx |
| `follow_redirects=False` sur le health check | `fetch(url, { redirect: "manual" })` |
| `httpx.MockTransport` (tests) | Remplacer par un mock de `fetch` (`msw`, `undici` MockAgent, ou injection d'un `fetcher`) |
| Client injectable via `client=` (paramètre keyword-only sur les 2 fonctions publiques) | Conserver le pattern : injecter un `fetchImpl` pour la testabilité |
| `httpx.HTTPError` / `TimeoutException` / `ConnectError` | `fetch` lève `TypeError` sur erreur réseau et `DOMException{name:"TimeoutError"}` sur abort → adapter `_friendly_http_error` sur ces discriminants |

**Autres points de portage** :
- Le module est entièrement **synchrone** ; en TS il devient `async`. Les appelants
  (`ingredient_search`) doivent devenir `async` en cascade.
- Aucun cache HTTP n'est utilisé. Dans un Worker on peut ajouter `cf: { cacheTtl: … }`
  ou le Cache API pour réduire le rate-limit OFF (amélioration, pas une reproduction).
- `round(kj / 4.184, 1)` : Python utilise l'**arrondi banquier** (half-to-even) sur les
  floats. `Math.round(x*10)/10` en JS fait du half-up. Écart possible d'un dixième de kcal
  sur les cas pile-poil ; à décider explicitement.

---

## 2. `ingredient_search.py` — recherche d'ingrédients unifiée

Module d'orchestration : FTS5 local d'abord, OFF **jamais** appelé depuis la frappe clavier.

### 2.1 `SearchResult` (dataclass frozen)

```python
matches: list[Ingredient]
looks_like_barcode: bool
query: str
@property is_empty -> bool   # len(matches) == 0
```

### 2.2 `_looks_like_barcode(q) -> bool`

```
s = q.strip() ; return s.isdigit() and len(s) in (8, 12, 13)
```
(EAN-8, UPC-A 12, EAN-13). **Portage** : `/^\d{8}$|^\d{12}$|^\d{13}$/` — mais attention,
`str.isdigit()` en Python accepte aussi les chiffres Unicode non-ASCII (ex. `'٣'` arabe,
exposants). Utiliser une regex ASCII stricte est un durcissement acceptable.

### 2.3 `search_local(session, query, limit=20, *, scope='all', source=None) -> SearchResult`

- `q = query.strip()` ; si vide → `matches = []` (aucune requête SQL émise).
- Sinon `IngredientRepo(session).search_fts(q, limit=limit, scope=scope, source=source)`.
- Retourne `SearchResult(matches, _looks_like_barcode(q), q)`.
- **Aucun effet de bord, aucun réseau.**
- Défaut `scope='all'` ici, mais la docstring du module précise :
  onglet Ingrédients → `'personal'`, pickers Recettes/Calendrier → `'all'`.
  *(⚠ Le `CLAUDE.md` affirme l'inverse pour les pickers — il est périmé ; le
  code QML `IngredientSearch.qml` et les VMs sont la référence, hors périmètre ici.)*

**SQL réellement émis** (`IngredientRepo._search_page`, chemin « legacy » →
`SearchOptions(query=q, scope=scope, source=source, page=1, page_size=limit)`) :

```sql
-- 1) COUNT
SELECT COUNT(*) FROM ingredient i
  JOIN ingredient_fts f ON f.rowid = i.id           -- seulement si q non vide
  WHERE ingredient_fts MATCH :q                     -- seulement si q non vide
    [AND i.in_personal_library = 1]                 -- scope == 'personal'
    [AND i.source = :source]
    [AND i.kcal_per_100g >= :min_kcal] … etc.
    [AND i.category_l1 = :cat_l1]

-- 2) IDs de la page (si COUNT > 0)
SELECT i.id FROM ingredient i {joins}{where}
  ORDER BY {order_by} LIMIT :limit OFFSET :offset

-- 3) Hydratation
SELECT … FROM ingredient WHERE id IN (:ids)   -- puis ré-ordonnancement Python
```

- Tokenisation FTS : `tokens = [f'"{t}"*' for t in q.split() if t]` puis `" ".join(tokens)`.
  Chaque mot est **mis entre guillemets** (neutralise les opérateurs FTS5) et suffixé de `*`
  (recherche par préfixe). Requête FTS finale pour « tom cer » : `"tom"* "cer"*`
  (AND implicite en FTS5).
- Si `q` non vide mais `tokens` vide (impossible en pratique) → page vide.
- `order_by` = `"rank"` (score FTS5) quand `q` non vide ; sinon `"i.name"`.
  Si `sort_by != 'rank'` : `order_by = "({col} IS NULL), {col} {ASC|DESC}, i.name ASC"`
  (les NULL en dernier), avec `col` ∈
  `{"name":"i.name","kcal":"i.kcal_per_100g","proteins":"i.proteins_g","carbs":"i.carbs_g","fats":"i.fats_g"}`
  (défaut `i.name` si inconnu).
- `page = max(1, opts.page)`, `page_size = max(1, opts.page_size)`, `offset = (page-1)*page_size`.

**Table FTS5 (`app\data\db.py`)** — indispensable au portage :
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS ingredient_fts USING fts5(
    name, content='ingredient', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);
-- + triggers ingredient_ai / ingredient_ad / ingredient_au (INSERT / DELETE / UPDATE)
```
`remove_diacritics 2` → « tomate » matche « Tomâte » / « TOMATE ».
**Portage D1** : Cloudflare D1 **supporte FTS5** (SQLite complet) ; les triggers passent tels
quels. Alternative si FTS5 indisponible : colonne `name_normalized` (minuscules +
`NFD`/suppression des diacritiques) + `LIKE 'prefix%'` — moins bon sur le classement `rank`.

### 2.4 `search_local_page(session, opts: SearchOptions) -> SearchPage`

Simple délégation : `IngredientRepo(session).search_fts(opts=opts)`.
Requête vide autorisée (« montre-moi toutes les lignes CIQUAL de cette catégorie »).

`SearchOptions` (dataclass frozen, `app\data\repositories\_search.py`) :
```python
query: str = ""
scope: str = "all"                # "all" | "personal"
source: Source | None = None
filters: SearchFilters = SearchFilters()
sort_by: SortField = "rank"       # "rank"|"name"|"kcal"|"proteins"|"carbs"|"fats"
sort_desc: bool = False
page: int = 1
page_size: int = 25
```
`SearchFilters` : `min_kcal, max_kcal, min_proteins, max_proteins, min_carbs, max_carbs,
min_fats, max_fats, category_l1` — tous `None` par défaut, bornes **inclusives**.

`SearchPage` : `matches, total_count, page, page_size` +
`page_count = 1 si page_size<=0 ou total_count<=0 sinon (total_count + page_size - 1) // page_size`.

### 2.5 `list_local_categories(session, source=None) -> list[str]`

`IngredientRepo.list_categories_l1(source)` :
```sql
SELECT DISTINCT category_l1 FROM ingredient
 WHERE category_l1 IS NOT NULL [AND source = :source]
 ORDER BY category_l1
```
Filtrage Python final `if c` (élimine la chaîne vide).

### 2.6 `fetch_from_openfoodfacts_and_cache(...)`

```python
def fetch_from_openfoodfacts_and_cache(
    session, query_or_barcode, *,
    add_to_personal_library: bool = False,
    page: int = 1, page_size: int = 25,
    sort_by: str | None = None,
    filters: SearchFilters | None = None,
) -> tuple[list[Ingredient], int]
```

Algorithme :
1. `q = query_or_barcode.strip()`.
2. **Court-circuit** : `if not q and filters is None: return [], 0`.
   (⚠ test différent de celui de `search_by_name` — cf. §7.2.)
3. `repo = IngredientRepo(session)`.
4. **Branche code-barres** — si `_looks_like_barcode(q)` :
   - `openfoodfacts.lookup_barcode(q)` (client interne, aucune injection).
   - `fetched = [ing] if ing is not None else []` ; `total = len(fetched)` (0 ou 1).
   - `page`, `page_size`, `sort_by`, `filters` sont **ignorés**.
5. **Branche texte** — sinon :
   - Traduction `SearchFilters` (domaine) → dict API :
     ```
     min_kcal, max_kcal, min_proteins, max_proteins,
     min_carbs, max_carbs, min_fats, max_fats,
     category_tag = filters.category_l1      # ⚠ renommage : category_l1 → category_tag
     ```
     `api_filters = None` si `filters is None`.
     **Remarque forte** : `filters.category_l1` contient chez nous un libellé CIQUAL
     (« fruits, legumes »), alors que l'API OFF attend un **tag** de la forme `fr:legumes`.
     Le commentaire du code le sait (`# OFF expects "fr:legumes" etc.`) mais **aucune
     conversion n'est faite** → ambiguïté / probable non-fonctionnalité. Voir §7.3.
   - `openfoodfacts.search_by_name(q, page=…, page_size=…, sort_by=…, filters=api_filters)`.
6. **Persistance (effet de bord)** : pour chaque `ing` de `fetched` :
   - si `add_to_personal_library` : `ing = ing.model_copy(update={"in_personal_library": True})` ;
   - `cached.append(repo.upsert_by_source_ref(ing))`.
7. Retourne `(cached, total)` — les objets rendus sont ceux **relus après écriture**
   (ils ont donc un `id`).

`upsert_by_source_ref` (`app\data\repositories\ingredient.py`) :
- `source_ref is None` → `create()` pur (crée un doublon à chaque appel).
- Sinon `find_by_source_ref(source, source_ref)` :
  `SELECT … WHERE source = :source AND source_ref = :ref` (`scalar_one_or_none` →
  **lève si plusieurs lignes**).
  - Absent → `create()`.
  - Présent → `update(ing.model_copy(update={"id": existing.id}))` → `_ing_apply` **écrase
    TOUTES les colonnes** avec les valeurs du modèle entrant, y compris
    `in_personal_library`, `price_eur`, `piece_weight_g`, `category_l1/l2`, `season_months`,
    `brand`, `cooked_weight_per_100g_raw`.
    ⚠ **Conséquence majeure** : re-fetcher un produit OFF déjà en bibliothèque personnelle
    avec `add_to_personal_library=False` **repasse `in_personal_library` à `False`** et
    **efface le prix, le poids-pièce et les catégories saisis par l'utilisateur**
    (les `Ingredient` construits par `_product_to_ingredient` ont ces champs à `None`/`False`).
    Comportement observé dans le code, à décider de reproduire ou corriger au portage.
    *(Le loader CIQUAL, lui, protège explicitement `in_personal_library` — pas ce chemin-ci.)*

**Erreurs** : `OpenFoodFactsError` remonte telle quelle jusqu'à l'appelant (les VMs la
capturent et émettent `error_emitted`). `ValueError` de `lookup_barcode` ne peut pas
survenir ici (le garde `_looks_like_barcode` implique `isdigit()`).

### 2.7 `promote_to_personal_library(session, ingredient_id) -> Ingredient | None`

`IngredientRepo.mark_in_personal_library(id, True)` :
`session.get(IngredientRow, id)` → `None` si absent ; sinon
`row.in_personal_library = True` + `flush()` → renvoie l'ingrédient mappé.
Effet de bord : 1 UPDATE.

### 2.8 `resolve_ingredient_name(session, name, *, max_candidates=5) -> list[Ingredient]`

Utilisé par l'importateur de recettes par URL pour rattacher une ligne texte
(« tomates cerises ») à un ingrédient local. **Ne touche jamais le réseau.**

Algorithme exact :
1. `q = (name or "").strip()` ; vide → `[]`.
2. `seen_ids: set[int]`, `pool: list[tuple[Ingredient, float]]` (ingrédient, bonus de score).
3. **Étape 1 — match exact, insensible à la casse** :
   - `exact = repo.find_by_name(q, source=Source.MANUAL)`
   - Si `exact is None` : boucle sur `(Source.CIQUAL, Source.OPENFOODFACTS)` :
     premier `cand` non-`None` **avec `cand.in_personal_library`** et `cand.id` non-`None`
     → `pool.append((cand, 0.10))`, `seen_ids.add`, **`break`**.
     ⚠ Le `break` est dans le `if` → il n'y a `break` que sur succès ; si le candidat CIQUAL
     existe mais n'est pas en bibliothèque perso, la boucle continue vers OFF.
   - Si `exact` trouvé **et** `exact.in_personal_library` **et** `exact.id` non-`None`
     → `pool.append((exact, 0.10))`.
     ⚠ Si `exact` existe mais n'est **pas** en bibliothèque perso, on n'essaie **pas** les
     autres sources (branche `elif`) — asymétrie à noter.
   - `find_by_name` : `SELECT … WHERE source = :source` puis **comparaison Python**
     `row.name.strip().casefold() == q.strip().casefold()`. Motif documenté : le `LOWER()`
     de SQLite est ASCII-only et raterait « Œufs » vs « œufs ».
     **Portage** : en TS, `String.prototype.toLocaleLowerCase()` (ou `Intl.Collator`
     avec `sensitivity:'base'`) ; en SQL D1, prévoir une colonne normalisée.
     ⚠ Coût : charge **toutes** les lignes de la source en mémoire (des dizaines de
     milliers pour CIQUAL). À remplacer par un index normalisé au portage.
4. **Étape 2 — FTS préfixe, bibliothèque perso** :
   `repo.search_fts(q, limit=max_candidates * 2, scope="personal")` → chaque ingrédient
   non déjà vu entre dans le pool avec bonus **0.10**.
5. **Étape 3 — extension** : si `len(pool) < max_candidates`,
   `repo.search_fts(q, limit=max_candidates * 2, scope="all")` → bonus **0.0**.
6. `pool` vide → `[]`.
7. **Re-classement rapidfuzz** :
   ```python
   from rapidfuzz import fuzz          # ImportError → renvoie pool[:max_candidates] tel quel
   sim   = fuzz.token_set_ratio(q.lower(), ing.name.lower()) / 100.0
   score = sim + boost
   trié par score décroissant ; on garde les max_candidates premiers
   ```
   `token_set_ratio` : similarité sur ensembles de tokens (insensible à l'ordre des mots et
   aux répétitions), score 0..100.
   **Portage** : pas d'équivalent standard en JS — utiliser `fastest-levenshtein`,
   `fuse.js` ou réimplémenter `token_set_ratio` (union/intersection de tokens + ratio de
   Levenshtein normalisé). **Signaler que le classement ne sera pas identique au bit près.**
8. Le tri Python est **stable** : à score égal, l'ordre d'insertion dans `pool`
   (exact → perso → tous) est conservé.

---

## 3. `nutrition_service.py` — agrégation nutritionnelle

Fine couche d'orchestration ; **toute** l'arithmétique est dans `app\domain\nutrition.py`.

### 3.1 Formules du domaine (référence normative)

`NutritionTotal` = 8 champs `float`, tous à `0.0` par défaut :
`kcal, proteins_g, carbs_g, sugars_g, fats_g, saturated_fats_g, fiber_g, salt_g`.
- `__add__` : addition champ à champ.
- `divided_by(n)` : division champ à champ ; **lève `ValueError("portions must be > 0")` si `n <= 0`**.

`_macros_for(ingredient, quantity_g)` :
```
factor = quantity_g / 100.0
pour chaque macro m : résultat.m = (ingredient.m or 0.0) * factor
```
⚠ `(v or 0.0)` : `None` **et** `0.0` donnent tous deux `0.0` (l'« inconnu » compte comme 0
dans l'agrégat, alors que le modèle distingue les deux). Comportement à reproduire.
Les macros de l'ingrédient sont **par 100 g** (convention CIQUAL).

`aggregate_lines(lines)` = somme de `_macros_for(line.ingredient, line.quantity_g)`.
`aggregate_recipe(recipe)` = `(total, total.divided_by(recipe.default_portions))`.
`ingredient_macros(ingredient, quantity_g)` = alias public de `_macros_for`.

### 3.2 `aggregate_recipe(session, recipe_id) -> (NutritionTotal, NutritionTotal)`

- `RecipeRepo(session).get(recipe_id)` → `SELECT recipe WHERE id = :id` +
  `selectinload(lines→ingredient)` + `selectinload(tags)`.
- `None` → **`LookupError(f"Recipe {recipe_id} not found")`**.
- Retourne `(total, per_portion)` via `domain.nutrition.aggregate_recipe`.
- ⚠ `divided_by` lève si `default_portions <= 0` — impossible en pratique
  (`Field(default=1, ge=1)`).

### 3.3 `_scale(total, factor) -> NutritionTotal` (privé)

Multiplie les 8 champs par `factor`.

### 3.4 `aggregate_entries(session, entries: list[MealPlanEntry]) -> NutritionTotal`

```
total = NutritionTotal()
si entries vide → total (aucune requête)

pour chaque entry :
  si entry.recipe_id is not None :
      recipe = RecipeRepo.get(entry.recipe_id)      # 1 SELECT (+selectinload) PAR ENTRÉE
      si None → continue                            # orpheline, ignorée
      recipe_total = aggregate_lines(recipe.lines)
      factor = (entry.portions or 1.0) / max(recipe.default_portions, 1)
      total = total + _scale(recipe_total, factor)
  sinon si entry.ingredient_id is not None :
      ing = IngredientRepo.get(entry.ingredient_id)  # 1 SELECT PAR ENTRÉE
      si None → continue
      total = total + ingredient_macros(ing, entry.quantity_g or 0)
```

Détails :
- `entry.portions or 1.0` : `None` **et** `0.0` → `1.0` (mais le validateur Pydantic
  interdit déjà `portions <= 0`).
- `max(recipe.default_portions, 1)` : garde-fou contre une division par zéro.
- `entry.quantity_g or 0` → `0` si `None`.
- **Aucune dégradation silencieuse n'est signalée** : les entrées orphelines sont
  simplement sautées, sans compteur.
- ⚠ **N+1 assumé** : contrairement à `shopping_service`, ce service ne fait **pas** de
  chargement par lots. 14 entrées → jusqu'à 14 `SELECT` + leurs `selectinload`.
  **Portage** : batcher (`WHERE id IN (...)`) — les allers-retours D1 coûtent bien plus cher
  que SQLite local.

### 3.5 `aggregate_day(session, iso_week, day_of_week) -> NutritionTotal`

`MealPlanRepo.list_by_week(iso_week)` puis filtrage Python
`e.day_of_week == day_of_week`, puis `aggregate_entries`.
(La semaine entière est chargée même pour un seul jour.)

### 3.6 `aggregate_week(session, iso_week) -> NutritionTotal`

`MealPlanRepo.list_by_week(iso_week)` → `aggregate_entries`.

**SQL de `list_by_week`** :
```sql
SELECT … FROM meal_plan_entry
 WHERE iso_week = :iso_week
 ORDER BY day_of_week, slot, ordinal
```
⚠ `ORDER BY slot` trie sur la **chaîne** (`'evening' < 'morning' < 'noon' < 'snack_afternoon' < 'snack_morning'`),
**pas** dans l'ordre chronologique. L'ordre chronologique
(matin → collation matin → midi → collation après-midi → soir) est reconstitué **côté QML**.
À reproduire explicitement dans le front web.

---

## 4. `shopping_service.py` — liste de courses

### 4.1 `aggregate_shopping_list(s: Session, iso_week: str) -> ShoppingList`

**Étape 1 — entrées de la semaine**
`MealPlanRepo(s).list_by_week(iso_week)` → 1 `SELECT` (cf. §3.6).

**Étape 2 — pré-chargement des recettes**
```python
recipe_ids   = {e.recipe_id for e in entries if e.recipe_id is not None}
recipes_by_id = RecipeRepo(s).list_by_ids(recipe_ids)   # {} si vide, aucun SQL
```
SQL : `SELECT … FROM recipe WHERE id IN (:ids)` + `selectinload(lines→ingredient)` +
`selectinload(tags)` (soit 1 SELECT principal + 2–3 SELECT de `selectinload`).

**Étape 3 — agrégation des quantités par ingrédient** (`qty_by_ing: dict[int, float]`)
```python
pour chaque entry :
  si entry.recipe_id is not None :
      recipe = recipes_by_id.get(entry.recipe_id)
      si None : continue                             # référence orpheline, ignorée
      default = max(recipe.default_portions, 1)
      ratio   = (entry.portions or 1.0) / default
      pour chaque line de recipe.lines :
          si line.ingredient.id is None : continue
          qty_by_ing[line.ingredient.id] += line.quantity_g * ratio
  sinon si entry.ingredient_id is not None :
      qty_by_ing[entry.ingredient_id] += (entry.quantity_g or 0.0)
```
Exemple de référence (test) : recette `default_portions=4`, ligne 200 g, entrée
`portions=2.0` → `200 × 2/4 = 100 g`. Un même ingrédient présent dans une recette **et**
en entrée brute est bien **cumulé** (200 g + 100 g = 300 g).

**Étape 4 — pré-chargement des ingrédients**
`IngredientRepo(s).list_by_ids(qty_by_ing.keys())` → `SELECT … WHERE id IN (:ids)`
(dict vide et aucun SQL si aucun id).

**Étape 4 bis — stock du frigo (jointure « pantry »)**
`PantryRepo(s).aggregate_quantity_by_ingredient()` → **une seule** requête :
```sql
SELECT ingredient_id, SUM(quantity_g) FROM pantry_stock GROUP BY ingredient_id
```
Résultat : `{ingredient_id: float(total or 0)}`. La table `pantry_stock` autorise
**plusieurs lots** par ingrédient (dates de péremption différentes) — d'où le `SUM`.

**Étape 5 — hydratation + coûts**
```python
items = [] ; total = Decimal("0.00") ; missing_count = 0
pour (ing_id, total_g) de qty_by_ing.items() :          # ordre d'insertion
    ing = ingredients_by_id.get(ing_id)
    si None : continue                                  # ingrédient supprimé entre-temps
    cost = pricing.ingredient_cost(ing, total_g)        # Decimal | None
    si cost is None : missing_count += 1
    sinon            : total += cost
    items.append(ShoppingItem(
        ingredient_id = ing_id,
        name          = ing.name,
        source        = ing.source.value,
        quantity_g    = total_g,
        piece_weight_g= ing.piece_weight_g,
        category_l1   = ing.category_l1,
        cost_eur      = cost,
        in_pantry_g   = pantry_totals.get(ing_id, 0.0),
    ))
```

**Tri final (stable)** — c'est le « regroupement par rayon » :
```python
items.sort(key=lambda i: (
    i.category_l1 is None,        # False (0) avant True (1) → catégorisés d'abord
    (i.category_l1 or "").lower(),
    i.name.lower(),
))
```
Ordre attendu (test) pour `fruits, legumes` / `viandes` / `None` :
`Aubergine, Carotte, Boeuf, Sel`.
⚠ `.lower()` (pas `casefold()`), tri **par points de code** : les accents ne sont pas
normalisés (« Élise » après « Zoé »). **Portage** : `localeCompare('fr')` donnerait un ordre
*différent* (et plus juste) — décision explicite à prendre.

**Retour**
```python
ShoppingList(
    iso_week            = iso_week,
    items               = items,
    total_eur           = total.quantize(Decimal("0.01")),
    missing_price_count = missing_count,
)
```

**Comptage de requêtes** : le test `test_aggregate_uses_constant_query_count` verrouille
**≤ 8 SELECT** quel que soit le nombre d'entrées (borne généreuse : entrées + recettes en
lot + `selectinload` + ingrédients en lot + pantry).

**Dégradation silencieuse** (jamais d'exception) :
- recette supprimée → entrée ignorée ;
- ingrédient supprimé → item ignoré ;
- ligne de recette sans `ingredient.id` → ignorée ;
- ingrédient sans prix → `cost_eur = None`, incrémente `missing_price_count`, **exclu du total**.

### 4.2 Modèles de sortie (`app\domain\shopping.py`)

`ShoppingItem` (frozen) :
`ingredient_id: int`, `name: str`, `source: str`, `quantity_g: float (ge=0)`,
`piece_weight_g: float|None`, `category_l1: str|None`, `cost_eur: Decimal|None`,
`in_pantry_g: float = 0.0`.
Propriétés dérivées :
- `has_price` = `cost_eur is not None`
- `is_covered_by_pantry` = `in_pantry_g >= quantity_g and quantity_g > 0`
- `piece_count` = `None` si `piece_weight_g` falsy, sinon `quantity_g / piece_weight_g`

`ShoppingList` (frozen) : `iso_week`, `items`, `total_eur = Decimal("0.00")`,
`missing_price_count = 0`, `item_count = len(items)`.

**Case « déjà au frigo »** : `ShoppingListModel.set_items` (UI) initialise
`_in_fridge[id] = item.is_covered_by_pantry`. **État purement local, non persisté**,
réinitialisé à chaque `refresh()`. Le slot `setInFridge(ingredient_id, bool)` ne fait que
muter le modèle en mémoire. **Portage** : soit reproduire (état éphémère côté client),
soit persister (amélioration, à décider).

### 4.3 Calcul des coûts (`app\domain\pricing.py`)

```python
CENT = Decimal("0.01")

# Ingredient.price_per_g (propriété, app/domain/models.py)
si price_eur is None ou not price_quantity_g : → None
sinon : price_eur / Decimal(str(price_quantity_g))     # division Decimal, précision contexte (28)

def ingredient_cost(ingredient, quantity_g) -> Decimal | None:
    ppg = ingredient.price_per_g
    si ppg is None : return None
    return (ppg * Decimal(str(quantity_g))).quantize(CENT, rounding=ROUND_HALF_UP)
```
Exemple de référence (test) : 1,20 € / 1000 g × 500 g = **0,60 €**.

⚠ `not price_quantity_g` : `0.0` **et** `None` donnent `None` (le validateur interdit
déjà `<= 0`).
⚠ Arrondi : **chaque ligne** est arrondie `ROUND_HALF_UP` à 2 décimales, **puis** sommée.
Le `total.quantize(Decimal("0.01"))` final n'a **pas** de `rounding=` explicite → il utilise
le défaut du contexte décimal, **`ROUND_HALF_EVEN`**. Sans effet en pratique (somme de
valeurs déjà à 2 décimales), mais à noter pour une reproduction exacte.
`Decimal(str(x))` : conversion **via la représentation décimale** du float (évite le bruit
binaire de `Decimal(0.1)`).

Fonctions voisines du même module (utilisées ailleurs, listées pour complétude) :
`_line_cost(line)`, `recipe_cost(recipe) -> (Decimal, list[RecipeLine sans prix])`,
`recipe_cost_per_portion(recipe)` = `(total / Decimal(default_portions)).quantize(CENT, ROUND_HALF_UP)`.

### 4.4 `format_as_text(shopping_list) -> str` — format de sortie exact

Sortie destinée au presse-papiers (`ShoppingViewModel.copyToClipboard`).

**Cas vide** (`items == []`) — retour immédiat :
```
Liste de courses — {iso_week}\n\n(aucun ingrédient)\n
```
(le tiret est un **cadratin U+2014** « — »).

**Cas général** :
```
out = ["Liste de courses — {iso_week}", ""]
current_category = "__sentinel__"
pour chaque item (dans l'ordre déjà trié par aggregate_shopping_list) :
    cat = item.category_l1 or "Non catégorisé"
    si cat != current_category :
        out.append(f"== {cat.capitalize()} ==")
        current_category = cat
    out.append(_format_item_line(item))
out.append("")
out.append("─" * 30)                     # U+2500 BOX DRAWINGS LIGHT HORIZONTAL, 30 fois
si missing_price_count > 0 :
    out.append(f"Total : {total} € · {missing_price_count} ingrédient(s) sans prix")
sinon :
    out.append(f"Total : {total} €")
return "\n".join(out) + "\n"
```
- Séparateur du milieu : « ` · ` » = espace + **point médian U+00B7** + espace.
- `total` = `f"{shopping_list.total_eur:.2f}".replace(".", ",")` → `"4,20"`.
- ⚠ `cat.capitalize()` met la 1re lettre en majuscule **et le reste en minuscules** :
  `"fruits, legumes"` → `"Fruits, legumes"` ; `"VIANDES"` → `"Viandes"`.
  En JS, `s[0].toUpperCase() + s.slice(1)` **ne suffit pas** — il faut
  `s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()`.
- Le regroupement repose **entièrement** sur le tri préalable : si la liste n'est pas triée,
  une même catégorie peut apparaître plusieurs fois (comparaison au seul prédécesseur).

**`_format_item_line(item)`** :
```python
name = item.name[:40].ljust(40)                       # tronqué à 40, complété à 40 par des espaces
qty  = _format_quantity(item.quantity_g, item.piece_weight_g)
cost = f"  ({item.cost_eur:.2f} €)".replace(".", ",") si item.has_price sinon ""
return f"☐ {name} {qty}{cost}"                        # ☐ = U+2610 BALLOT BOX
```
Structure : `"☐ "` + nom (40 col.) + `" "` + quantité + éventuellement `"  (X,XX €)"`.

**`_format_quantity(quantity_g, piece_weight_g)`** :
```python
si quantity_g >= 1000 :
    kg   = quantity_g / 1000
    base = f"{kg:.3f}".rstrip("0").rstrip(".").replace(".", ",") + " kg"
sinon :
    base = f"{quantity_g:.0f} g"  si quantity_g >= 10
           f"{quantity_g:.1f} g"  sinon

si piece_weight_g et piece_weight_g > 0 :
    pieces     = quantity_g / piece_weight_g
    pieces_str = f"{pieces:.1f}".rstrip("0").rstrip(".").replace(".", ",")
    return f"{base} · ≈ {pieces_str} pièce" + ("s" si pieces > 1 sinon "")
return base
```
Exemples vérifiés à la main :
| Entrée | Sortie |
|---|---|
| 1500 g | `1,5 kg` |
| 2000 g | `2 kg` |
| 1234 g | `1,234 kg` |
| 500 g | `500 g` |
| 5.5 g | `5.5 g` ⚠ **point**, pas virgule (le `.replace` n'est pas appliqué sur cette branche) |
| 180 g, pièce 60 g | `180 g · ≈ 3 pièces` |
| 60 g, pièce 60 g | `60 g · ≈ 1 pièce` (singulier, car `pieces > 1` est faux) |
| 62 g, pièce 60 g | `62 g · ≈ 1 pièces` ⚠ **incohérence** : affiche « 1 » (arrondi) mais pluralise (1,033 > 1) |
- `f"{q:.0f}"` utilise l'arrondi **half-to-even** de Python (`f"{0.5:.0f}"` → `"0"`).
  En JS, `toFixed(0)` fait du half-away-from-zero → écarts sur les `.5` pile.
- Symboles : `·` = U+00B7, `≈` = U+2248, `☐` = U+2610, `─` = U+2500, `—` = U+2014.

### 4.5 Portage web

- Aucun accès disque / thread / Qt : ce service est **100 % portable**.
- Seul point desktop : `ShoppingViewModel.copyToClipboard()` utilise
  `QGuiApplication.clipboard()` → remplacer par `navigator.clipboard.writeText()`
  (et prévoir le fallback `document.execCommand('copy')` / partage Web Share API sur mobile).
- Le texte étant destiné à un affichage à chasse fixe (colonne de 40 caractères), prévoir
  `font-family: monospace` / `white-space: pre` dans la vue web.

---

## 5. `meal_plan_service.py` — semaines ISO, copie, templates

### 5.1 `MealPlanTemplate` (dataclass frozen)

```python
id: int
name: str
entry_count: int
created_at: datetime | None
updated_at: datetime | None
```

### 5.2 `previous_iso_week(iso_week: str) -> str`

```python
IsoWeek(value=iso_week)                       # validation du format, lève ValidationError sinon
year  = int(iso_week[:4])
week  = int(iso_week[6:])
monday      = datetime.fromisocalendar(year, week, 1)   # lundi de la semaine
prev_monday = monday - timedelta(weeks=1)
return IsoWeek.from_date(prev_monday).value             # f"{iso.year:04d}-W{iso.week:02d}"
```
- Franchit correctement les bornes d'année : `'2026-W01'` → `'2025-W52'` ou `'2025-W53'`
  selon que 2025 compte 52 ou 53 semaines (le test accepte les deux).
- ⚠ `datetime.fromisocalendar(year, 53, 1)` **lève `ValueError`** si l'année n'a pas 53
  semaines. Non capturé.
- **Portage JS** : `Date` n'a pas d'API ISO-week native. Implémenter :
  *lundi de la semaine ISO* = `jeudi = new Date(Date.UTC(year,0,4))`, reculer au lundi de
  cette semaine, puis ajouter `(week-1)*7` jours ; et `from_date` via l'algorithme ISO 8601
  standard (semaine contenant le jeudi). **Toujours travailler en UTC** pour éviter les
  décalages DST (le code Python utilise des `datetime` naïfs, sans fuseau).

### 5.3 `copy_week(s, src_iso_week, dst_iso_week) -> int`

```python
si src_iso_week == dst_iso_week : return 0            # garde-fou anti-doublement
src_entries = MealPlanRepo(s).list_by_week(src_iso_week)
pour chaque entry :
    new_entry = entry.model_copy(update={"id": None, "iso_week": dst_iso_week})
    MealPlanRepo(s).add(new_entry)
    count += 1
return count
```
Sémantique documentée et testée :
- **AJOUT** (append), pas de purge de `dst` au préalable → deux appels successifs
  dupliquent les entrées ; c'est à l'UI de confirmer quand `dst` est non vide
  (`CalendarViewModel.currentWeekEntryCount`).
- `(day_of_week, slot)` conservés → les entrées atterrissent dans les **mêmes cases**.
- `ordinal` conservé (une case peut empiler plusieurs items).
- `recipe_id` / `ingredient_id` / `quantity_g` / `portions` conservés à l'identique
  (test : `portions=2.5`, `quantity_g=120.5` inchangés).
- Les copies sont de **nouvelles lignes** (`id` frais, `created_at` frais) ; la semaine
  source n'est pas modifiée ; supprimer une copie n'affecte pas la source.
- Aucune validation du format de `dst_iso_week` ici (contrairement à `apply_template`).
- **Ne commit pas** (le contexte de session s'en charge).

`MealPlanRepo.add` : `INSERT INTO meal_plan_entry (iso_week, day_of_week, slot, recipe_id,
ingredient_id, quantity_g, portions, ordinal)` + `flush()`, retourne l'entrée relue.

### 5.4 `copy_previous_week(s, current_iso_week) -> int`

`copy_week(s, previous_iso_week(current_iso_week), current_iso_week)`. Retourne 0 si la
semaine précédente est vide.

### 5.5 Snapshot des templates — **format JSON exact**

Table `meal_plan_template` (`app\data\orm.py`) :

| Colonne | Type | Contraintes |
|---|---|---|
| `id` | INTEGER | PK |
| `name` | VARCHAR(100) | NOT NULL, **UNIQUE** |
| `snapshot_json` | TEXT | NOT NULL |
| `created_at` | DATETIME | `server_default = now()` |
| `updated_at` | DATETIME | `server_default = now()`, `onupdate = now()` |

`_entry_to_snapshot_dict(entry)` — **7 clés, toujours présentes, dans cet ordre** :
```json
{
  "day_of_week":   0,
  "slot":          "noon",
  "recipe_id":     12,
  "ingredient_id": null,
  "quantity_g":    null,
  "portions":      2.0,
  "ordinal":       0
}
```
- `slot` = `entry.slot.value` (la chaîne, pas le nom d'enum).
- Ni `id` ni `iso_week` : ils dépendent de la semaine cible.
- Sérialisation par `json.dumps(list)` **sans arguments** → séparateurs par défaut
  `", "` / `": "`, `ensure_ascii=True`.
- Le snapshot est un **tableau JSON** (`[]` pour une semaine vide).
- La docstring de l'ORM montre un exemple **partiel** (clés omises) ; le code réel écrit
  **toujours les 7 clés**, y compris les `null`. C'est le code qui fait foi.

`_snapshot_to_entry(d, target_iso_week)` — lecture **tolérante** :
```python
MealPlanEntry(
    iso_week      = target_iso_week,
    day_of_week   = int(d["day_of_week"]),      # KeyError si absent → entrée sautée
    slot          = MealSlot(d["slot"]),        # ValueError si valeur inconnue → sautée
    recipe_id     = d.get("recipe_id"),
    ingredient_id = d.get("ingredient_id"),
    quantity_g    = d.get("quantity_g"),
    portions      = d.get("portions"),
    ordinal       = int(d.get("ordinal", 0)),
)
```
Les validateurs Pydantic de `MealPlanEntry` s'appliquent : XOR strict
`recipe_id` / `ingredient_id`, `portions` obligatoire si recette, `quantity_g` obligatoire
si ingrédient, `0 <= day_of_week <= 6`, `quantity_g`/`portions` strictement positifs si
renseignés.

### 5.6 `save_as_template(s, source_iso_week, name) -> MealPlanTemplate`

```python
name = (name or "").strip()
si name vide : raise ValueError("Le nom du template ne peut pas être vide.")
entries  = MealPlanRepo(s).list_by_week(source_iso_week)
snapshot = json.dumps([_entry_to_snapshot_dict(e) for e in entries])

existing = SELECT * FROM meal_plan_template WHERE name = :name  (scalar_one_or_none)
si existing : existing.snapshot_json = snapshot ; row = existing     # UPSERT par NOM
sinon       : row = MealPlanTemplateRow(name=name, snapshot_json=snapshot) ; s.add(row)
s.flush()
log.info("Saved meal plan template %r with %d entries", name, len(entries))
return MealPlanTemplate(row.id, row.name, len(entries), row.created_at, row.updated_at)
```
- Idempotent sur le nom : « enregistrer à nouveau » écrase le snapshot sans violer l'index
  UNIQUE (test : 2 sauvegardes = 1 seule ligne, `entry_count` mis à jour).
- Semaine vide acceptée → snapshot `"[]"`, `entry_count = 0`.
- ⚠ `onupdate=func.now()` sur `updated_at` ne se déclenche **que si une colonne change**.
  Ré-enregistrer un snapshot **identique** ne met pas `updated_at` à jour.
- ⚠ Aucune validation du format de `source_iso_week` (une semaine bidon donne un template vide).
- **Ne commit pas.**

### 5.7 `apply_template(s, template_id, target_iso_week) -> int`

```python
IsoWeek(value=target_iso_week)                   # validation ; lève si invalide
row = s.get(MealPlanTemplateRow, template_id)
si row is None : return 0
essayer snapshot = json.loads(row.snapshot_json)
  sur JSONDecodeError : log.error("Corrupt template snapshot %d : %s", …) ; return 0
pour chaque d de snapshot :
    essayer : repo.add(_snapshot_to_entry(d, target_iso_week)) ; count += 1
    sur Exception : log.warning("Skipping malformed template entry %r : %s", d, exc)
return count
```
- **Ajout pur** (append), comme `copy_week` : les entrées existantes de la semaine cible
  restent. Deux applications empilent (test : 2 × 2 = 4 entrées).
- Chaque entrée malformée est sautée **individuellement** (`except Exception` large) ;
  les entrées valides du même snapshot sont bien insérées.
- ⚠ Une entrée sautée a déjà pu déclencher un `flush()` partiel via les entrées
  précédentes — pas de rollback partiel. Sans conséquence ici puisque tout est en ajout.
- **Ne commit pas.**

### 5.8 `list_templates(s) -> list[MealPlanTemplate]`

```sql
SELECT * FROM meal_plan_template ORDER BY name
```
`entry_count = len(json.loads(snapshot_json))`, `0` en cas de `JSONDecodeError`.
⚠ `ORDER BY name` en SQLite = collation **BINARY** (points de code) : « Menu été » est
classé **après** « Menu hiver » (`é` = U+00E9 > `h` = U+0068). Le test valide seulement la
cohérence avec le `sorted()` Python — même sémantique. **Portage** : `ORDER BY name` en D1
donne le même ordre binaire ; un tri `localeCompare('fr')` côté client donnerait un ordre
**différent**.

### 5.9 `delete_template(s, template_id) -> bool`

`s.get(...)` → `False` si absent ; sinon `s.delete(row)` + `flush()` → `True`.

### 5.10 Points de portage

- Aucune dépendance Qt / disque / thread : **portable tel quel**.
- Reproduire la sémantique **append** (et donc l'écran de confirmation côté UI quand la
  semaine cible n'est pas vide).
- `copy_week` et `apply_template` font N inserts : sur D1, les regrouper en
  `db.batch([...])` pour l'atomicité et la performance (une seule aller-retour).
- Le snapshot JSON référence des **`recipe_id` / `ingredient_id` bruts** : appliquer un
  template après suppression d'une recette crée une entrée orpheline — silencieusement
  ignorée en aval (`nutrition_service`, `shopping_service`). Comportement à conserver ou à
  durcir (nettoyage des snapshots), à décider.

---

## 6. `pricing_history_service.py` — prix courant dérivé de l'historique

### 6.1 Modèle de conception (documenté dans l'en-tête du module)

`ingredient.price_eur` / `ingredient.price_quantity_g` sont un **cache dénormalisé** de la
**dernière observation** de `ingredient_price_history`. L'utilisateur ne saisit plus le prix
directement sur le formulaire ingrédient : il enregistre des observations (date, enseigne,
prix, quantité) et le prix courant suit la plus récente. Le recalcul est fait **exactement
une fois** par ajout/suppression d'observation (invalidation de cache), plutôt que par un
sous-select à chaque lecture (les calculs de coût de recette et l'agrégation de courses
lisent `price_eur` massivement).

Les lignes dont le prix avait été saisi manuellement **avant** cette fonctionnalité ne sont
**pas** touchées tant que l'utilisateur n'ajoute pas sa première observation
(valeur « héritée » conservée) — conséquence directe du fait que la fonction n'est appelée
que sur add/delete d'observation.

### 6.2 `recompute_current_price(s, ingredient_id) -> Ingredient | None`

```python
si ingredient_id <= 0 : return None                       # garde-fou
ing = IngredientRepo(s).get(ingredient_id)
si ing is None : return None

latest = PriceHistoryRepo(s).latest_for_ingredient(ingredient_id)
si latest is not None :
    ing.price_eur        = latest.price_eur       # Decimal
    ing.price_quantity_g = latest.quantity_g      # float
    log.debug("Recomputed current price for ingredient %d from history entry %d "
              "(recorded %s) : %s €/%g g", …)
sinon :
    ing.price_eur        = None
    ing.price_quantity_g = None
    log.debug("Cleared current price for ingredient %d (no history)", …)

return IngredientRepo(s).update(ing)
```

**Requête « dernière observation »** :
```sql
SELECT * FROM ingredient_price_history
 WHERE ingredient_id = :id
 ORDER BY recorded_at DESC, id DESC
 LIMIT 1
```
Le tri secondaire `id DESC` départage deux observations à la **même date** : la plus
récemment saisie gagne.

**Effets de bord** :
- 1 `SELECT ingredient`, 1 `SELECT ingredient_price_history … LIMIT 1`, 1 `UPDATE ingredient`
  (via `IngredientRepo.update` → `_ing_apply` + `flush()`).
- ⚠ `_ing_apply` réécrit **toutes** les colonnes de l'ingrédient depuis le modèle en
  mémoire (name, source, source_ref, brand, cooked_weight_per_100g_raw, les 8 macros,
  price_eur, price_quantity_g, piece_weight_g, in_personal_library, category_l1/l2,
  season_months). Ce n'est pas un `UPDATE … SET price_eur = ?` ciblé.
  **Portage** : préférer un `UPDATE ingredient SET price_eur = ?, price_quantity_g = ?
  WHERE id = ?` — plus sûr en concurrence.
- **Ne commit pas** : la docstring le dit explicitement (« Callers are responsible for
  committing the session »).
- **Ne lève jamais** (hors erreur SQL).
- Note technique : l'affectation `ing.price_eur = None` **contourne** le validateur Pydantic
  `_price_strictly_positive` (le modèle n'active pas `validate_assignment`). C'est
  intentionnel et sans danger ici.

### 6.3 Appelants (contexte)

- `IngredientViewModel.addPriceEntry` : `PriceHistoryRepo.add(entry)` →
  `recompute_current_price(s, entry.ingredient_id)` → `s.commit()` → `refresh()` +
  signal `current_price_recomputed`.
- `IngredientViewModel.deletePriceEntry` : lit l'entrée pour récupérer `ingredient_id`,
  `PriceHistoryRepo.delete(entry_id)`, puis recalcul + commit.
- `ReceiptImportViewModel.commit…` (import de ticket de caisse) : pour chaque ligne
  rapprochée, crée une `PriceHistoryEntry` (`notes = f"Import ticket — {raw_name}"`,
  `recorded_at` = date du ticket) puis appelle `recompute_current_price`.
  *(Détail complet du parcours ticket : hors périmètre de ce document.)*

### 6.4 `PriceHistoryEntry` (rappel, `app\domain\models.py`)

`id`, `ingredient_id: int`, `price_eur: Decimal (gt=0)`, `quantity_g: float (gt=0)`,
`store: str|None`, `recorded_at: datetime`, `notes: str|None`, `created_at`.
Propriété `price_per_100g = price_eur * Decimal("100") / Decimal(str(quantity_g))`
(**sans quantize** — précision décimale complète).

Autres méthodes du repo (pour complétude) :
- `list_for_ingredient` : `ORDER BY recorded_at ASC, id ASC` (prêt pour le graphique).
- `list_known_stores` : `SELECT DISTINCT store WHERE store IS NOT NULL AND store != '' ORDER BY store`.
- Journal **append-only** : `add` + `delete`, pas d'`update` (pour corriger, supprimer puis
  ré-ajouter).

---

## 7. Ambiguïtés, incohérences et bugs relevés

Signalés tels quels, **sans les corriger** — au portage il faudra trancher explicitement.

### 7.1 `_PRODUCT_FIELDS` vs `generic_name`
`_product_to_ingredient` lit `generic_name_fr` / `generic_name` en dernier recours, mais ces
champs ne sont **pas** demandés dans `fields`. Le fallback est donc inatteignable.

### 7.2 Deux court-circuits « requête vide » incohérents
- `openfoodfacts.search_by_name` : `if not q_text and not filters` (vérité booléenne).
- `ingredient_search.fetch_from_openfoodfacts_and_cache` : `if not q and filters is None`.

Conséquence : appeler `fetch_from_openfoodfacts_and_cache(s, "", filters=SearchFilters())`
(tous les champs à `None`) construit `api_filters` = dict de 9 clés valant `None` →
**dict non vide, donc truthy** → `search_by_name` ne court-circuite pas →
`_build_lucene_query("", {...})` renvoie **`"*:*"`** → **on pagine dans l'intégralité du
dataset OFF**, exactement ce que le commentaire du code dit vouloir éviter.
**Recommandation de portage** : normaliser en supprimant les clés `None` avant l'appel, ou
tester « au moins un filtre effectif ».

### 7.3 `category_l1` (libellé CIQUAL) envoyé comme `categories_tags` OFF
`filters.category_l1` contient un libellé français CIQUAL (« fruits, legumes »,
« viandes… »). Il est passé tel quel comme `category_tag` puis injecté dans
`categories_tags:"fruits, legumes"`. L'API OFF attend un **tag canonique** (`fr:legumes`).
Le commentaire du code le mentionne mais **aucune table de correspondance n'existe**.
→ Filtre catégorie probablement non fonctionnel sur l'onglet OFF. À vérifier / mapper.

### 7.4 `upsert_by_source_ref` écrase les données utilisateur
Voir §2.6. Re-fetcher un produit OFF déjà présent remet `in_personal_library` à `False`
et efface `price_eur`, `price_quantity_g`, `piece_weight_g`, `category_l1/l2`,
`season_months`, `cooked_weight_per_100g_raw`. Le loader CIQUAL protège explicitement
`in_personal_library` ; **ce chemin-ci ne le fait pas**.

### 7.5 Pluriel/arrondi des pièces (`_format_quantity`)
`≈ 1 pièces` pour 62 g avec une pièce de 60 g (affichage arrondi à « 1 », pluriel décidé sur
la valeur non arrondie). Voir tableau §4.4.

### 7.6 Séparateur décimal des petites quantités
Branche `< 10 g` : `f"{quantity_g:.1f} g"` → `"5.5 g"` avec un **point**, alors que tout le
reste du texte utilise la virgule française.

### 7.7 `str.capitalize()` sur les catégories
`"fruits, legumes".capitalize()` → `"Fruits, legumes"` : le reste de la chaîne est mis en
**minuscules**. Peut surprendre sur des catégories multi-mots.

### 7.8 `resolve_ingredient_name` — branche `elif` asymétrique
Si le match exact `MANUAL` existe mais n'est **pas** en bibliothèque personnelle, on ne
tente **pas** CIQUAL/OFF (branche `elif`) ; alors qu'avec `exact is None` on les teste.

### 7.9 `find_by_name` charge toute une source en mémoire
`SELECT … WHERE source = :source` **sans** filtre sur le nom, puis comparaison Python
`casefold()`. Avec CIQUAL (~3 000 lignes) ça passe ; c'est un anti-pattern à corriger sur
D1 (colonne normalisée + index).

### 7.10 `nutrition_service.aggregate_entries` : N+1 non corrigé
Contrairement à `shopping_service` (qui a fait l'objet du correctif « B2 »), ce service
émet une requête par entrée. `aggregate_day` charge par ailleurs la semaine entière.

### 7.11 `ORDER BY slot` non chronologique
`meal_plan_entry` est trié sur la chaîne du slot ; l'ordre chronologique est reconstitué
par l'UI. Le front web doit refaire ce tri :
`['morning','snack_morning','noon','snack_afternoon','evening']`.

### 7.12 Tri par `.lower()` / collation binaire
Liste de courses et templates triés par points de code, sans normalisation des accents.
Un tri `localeCompare('fr')` donnera un ordre différent (probablement souhaitable, mais
c'est un changement de comportement à assumer).

### 7.13 Code mort
`app\data\repositories.py` (fichier) est masqué par le package `app\data\repositories\`.
Ne pas s'y référer lors du portage.

---

## 8. Synthèse portage : desktop → web

| Élément desktop | Où | Équivalent web proposé |
|---|---|---|
| `httpx.Client` (sync, `base_url`, `timeout`, injection de client) | `openfoodfacts.py` | `fetch` + `AbortSignal.timeout(10_000)` ; injecter un `fetchImpl` pour les tests |
| `User-Agent` custom obligatoire (rate-limit OFF) | `openfoodfacts.py` | Vérifier que le Worker laisse passer l'UA ; sinon paramétrer via var d'env et surveiller les 429 |
| Appels OFF depuis le poste client | `ingredient_search.py` | **Doivent passer par le Worker** (CORS + protection de l'UA + cache mutualisé) |
| `threading.Thread` du ping OFF (5 min) | `network_vm.py` | `navigator.onLine` + un `fetch HEAD/GET` périodique côté client, ou un Cron Trigger Worker qui met un flag en KV |
| SQLite local + WAL + FTS5 `unicode61 remove_diacritics 2` + 3 triggers | `db.py` | D1 (SQLite) : FTS5 et triggers supportés ; sinon colonne `name_normalized` + `LIKE 'x%'` |
| `decimal.Decimal` + `ROUND_HALF_UP` par ligne | `pricing.py`, `shopping_service.py` | Centimes entiers, ou `decimal.js` ; **surtout pas** de `number` flottant |
| `session_scope` (commit/rollback automatiques) | `app_context.py` | Une transaction logique par handler ; `db.batch()` pour les écritures groupées |
| `QGuiApplication.clipboard()` | `shopping_vm.py` | `navigator.clipboard.writeText()` / Web Share API |
| `rapidfuzz.fuzz.token_set_ratio` | `ingredient_search.py` | Réimplémentation TS (union/intersection de tokens + Levenshtein normalisé) ; **classement non identique** |
| `datetime.fromisocalendar` / `isocalendar()` | `meal_plan_service.py` | Helpers ISO-8601 maison **en UTC** |
| Formatage `f"{x:.0f}"` (half-to-even) | `shopping_service.py` | `toFixed` fait du half-away-from-zero → écrire un arrondi bancaire explicite si la fidélité au chiffre près est requise |
| Sortie texte à chasse fixe (colonne 40) | `format_as_text` | `white-space: pre; font-family: monospace` |

---

*Fin du document — services cœur.*
