# 04 — Services d'ingestion (tickets de caisse, Lidl Plus, import de recette par URL, photos)

> Spécification de portage, établie **par lecture du code réel** (pas de CLAUDE.md / architecture.md,
> qui sont périmés sur toute cette partie). Chemins absolus donnés depuis la racine du projet
> `<racine-du-depot>/`.
>
> Cible du portage : front TypeScript (PWA mobile) + Cloudflare Worker + D1.

---

## 0. Carte des flux

Il y a **quatre pipelines d'ingestion** indépendants, qui convergent tous vers la base :

```
(A) TICKET FICHIER (Intermarché PDF)
    ~/Downloads/Tickets de caisse/*.pdf
      → receipt_watcher.py (watchdog, event on_created / on_moved)
      → receipt_parser/__init__.py  parse_receipt(path)   [détection enseigne]
      → receipt_parser/intermarche_parser.py              → ParsedReceipt
      → receipt_matcher.py  match_receipt(session, parsed) → MatchedReceipt
      → ReceiptImportViewModel (revue utilisateur dans un dialog)
      → commit : PriceHistoryEntry × N + PantryStock × M + ReceiptAlias × N
                 + ImportedReceipt (anti-doublon) + suppression du fichier source

(B) TICKET API (Lidl Plus)
    lidl_plus_client.fetch_recent_tickets(limit)  → list[dict]  (lib tierce `lidl-plus`)
      → filtrage anti-doublon sur `imported_receipt`
      → lidl_plus_client.fetch_ticket_detail(id)  → dict
      → receipt_parser/lidl_api_adapter.adapt_lidl_json(dict) → ParsedReceipt
      → même suite que (A) à partir du matcher

(C) RECETTE PAR URL
    recipe_url_importer/core.fetch_recipe(url)
      → httpx GET (1 seul fetch)
      → scrapers_adapter.try_recipe_scrapers(url, html)  [lib recipe-scrapers]
      → sinon jsonld_fallback.parse_jsonld_recipe(html, url)  [BeautifulSoup + lxml]
      → chaque ligne d'ingrédient passe par quantity_parser.parse_french_quantity()
      → ExtractedRecipe → RecipeUrlImportViewModel (wizard 3 étapes)
      → ingredient_search.resolve_ingredient_name() pour proposer des candidats
      → commit : Recipe + RecipeLine[] ; puis photo_service.save_recipe_photo_from_http_url()

(D) PHOTOS DE RECETTE
    photo_service.py — fichier local (FileDialog / drag-drop) ou URL HTTP
      → Pillow : EXIF transpose + thumbnail 1024 + RGB + JPEG q85
      → ~/.prandia/recipe_photos/<recipe_id>.jpg
```

---

## 1. Modèles de domaine associés

### 1.1 `app/domain/receipt.py` — dataclasses (pas Pydantic, pas de validation)

**`ParsedLine`** (mutable) : une ligne d'article telle qu'extraite, avant matching.

| Champ | Type | Défaut | Sémantique |
|---|---|---|---|
| `raw_name` | `str` | requis | Libellé imprimé sur le ticket, souvent tronqué (`"FRANUI FRAMBSE CHOCO"`). |
| `store_key` | `str` | requis | Clé de lookup dans `receipt_alias`. Intermarché = `raw_name` casefold + espaces collapsés ; Lidl = `art_id` de l'API. Carrefour = TBD (non implémenté). |
| `quantity` | `int` | `1` | Compteur d'unités du ticket (**pas** des grammes). |
| `unit_price` | `Decimal \| None` | `None` | Prix unitaire €. |
| `total_price` | `Decimal \| None` | `None` | Prix total ligne €. |
| `vat_code` | `str` | `""` | Code TVA `A` / `B` / `C` / `""`. |

Propriétés calculées :

```python
effective_total = total_price if total_price is not None
                  else (unit_price * Decimal(quantity)) if unit_price is not None
                  else Decimal("0")

is_likely_food = (vat_code == "A") or (vat_code == "")
```

> Heuristique France : `A` = TVA 5,5 % (alimentaire), `B` = 20 % (souvent non-alimentaire),
> `C` = 10 % (intermédiaire). Code vide ⇒ considéré alimentaire par défaut.

**`ParsedReceipt`** : `store: str` (slug `"intermarche"` / `"lidl"` / `"carrefour"`),
`ticket_id: str|None`, `date: datetime|None`, `lines: list[ParsedLine]`, `raw_text: str` (debug),
`total_eur: Decimal|None`. Propriétés `line_count` et `food_lines` (filtre `is_likely_food`).

**`MatchedLine`** : `parsed: ParsedLine` + état de résolution :

| Champ | Type | Défaut | Sémantique |
|---|---|---|---|
| `suggestions` | `list[int]` | `[]` | ids d'ingrédients, meilleur en premier. |
| `chosen_ingredient_id` | `int \| None` | `None` | Choix final (auto ou utilisateur). |
| `match_source` | `str` | `"none"` | `"alias"` / `"source_ref"` / `"fuzzy"` / `"none"`. |
| `match_score` | `float` | `0.0` | 0–1. `alias` et `source_ref` ⇒ `1.0`. |
| `add_to_pantry` | `bool` | `False` | Mais initialisé à `is_likely_food` par le matcher. |
| `expiry_date` | `datetime \| None` | `None` | DLC optionnelle si ajout au frigo. |
| `user_barcode` | `str` | `""` | EAN saisi sur la ligne (scan / clavier). |
| `quantity_g` | `float` | `0.0` | Quantité **en grammes** saisie par l'utilisateur ; 0 = non saisi ⇒ cascade de fallback au commit. |
| `user_price_override` | `bool` | `False` | Verrouille le prix contre les recalculs automatiques. |

**`MatchedReceipt`** : `parsed` + `lines: list[MatchedLine]` + `is_duplicate: bool`
(implémenté en property/setter sur un champ privé `_is_duplicate`).

### 1.2 `app/domain/url_recipe.py`

- **`ExtractedIngredient`** : `raw_text`, `parsed_name`, `parsed_quantity: float|None`,
  `parsed_unit: str|None` (code de `app.domain.units.UNITS`, ou `None`).
- **`ExtractedRecipe`** : `name`, `instructions=""`, `default_portions=1`,
  `prep_time_min: int|None`, `image_url: str|None`, `source_url=""`, `ingredients: list[...]`.
  L'image **n'est pas** téléchargée à l'extraction (uniquement au commit, best-effort).
- **`ResolvedLine`** : `extracted` + `candidates: list[int]` + `chosen_ingredient_id: int|None`
  + `quantity_g: float = 0.0` + `unit_code: str = "g"` + `is_ignored: bool` + `is_manual_override: bool`.
- **`ResolvedRecipeImport`** : `extracted` + `lines: list[ResolvedLine]`.

---

## 2. `app/services/receipt_parser/__init__.py` — dispatch de format

**Rôle** : détecter l'enseigne d'un fichier ticket et déléguer.

**Algorithme complet de `parse_receipt(path: Path) -> ParsedReceipt`** :

1. `if not path.exists(): raise FileNotFoundError(f"Fichier introuvable : {path}")`.
2. `suffix = path.suffix.lower()`.
3. Si `suffix == ".pdf"` :
   - ouvre avec `pdfplumber`, extrait `pdf.pages[0].extract_text()`, prend les **500 premiers
     caractères**, `.upper()` (chaîne vide si aucune page) ;
   - si `"INTERMARCH" in head` **ou** `"FONTAINE-LES-DIJON" in head` → `parse_intermarche_pdf(path)` ;
   - si `"CARREFOUR" in head` → log warning + `raise UnknownReceiptFormat("Carrefour n'est pas encore supporté (Phase 3 du plan).")` ;
   - sinon `raise UnknownReceiptFormat(f"PDF non reconnu : ni Intermarché ni Carrefour. En-tête extrait : {head[:120]!r}")`.
4. Sinon : `raise UnknownReceiptFormat(f"Extension non supportée : {suffix}. Formats acceptés : .pdf")`.

`UnknownReceiptFormat` hérite de `ValueError`.

**Points notables / limites**

- **Seul le PDF Intermarché est implémenté.** Carrefour et le HTML sont annoncés mais absents.
- ⚠️ **Incohérence réelle** : le watcher (§6) accepte `.pdf`, `.html`, `.htm`, mais `parse_receipt`
  rejette `.html`/`.htm`. Un HTML déposé dans le dossier déclenche donc une notification puis une
  erreur « Format non reconnu ».
- La détection `"FONTAINE-LES-DIJON"` est un **hack lié au magasin de l'utilisateur** (le PDF
  échantillon ne contient pas toujours le mot « Intermarché » dans les 500 premiers caractères).

---

## 3. `app/services/receipt_parser/intermarche_parser.py`

**Rôle** : extraire un `ParsedReceipt` d'un PDF Intermarché à **texte natif** (pas d'OCR).

**Dépendance** : `pdfplumber>=0.11`.

**Format de référence** (magasin Fontaine-lès-Dijon, mai 2026, cité dans le docstring) :

```
SAS GREECE-25
RUE DES PRES POTETS
21121 FONTAINE-LES-DIJON
...
FRANUI FRAMBSE CHOCO     6,06 EUR A
L'ANGELYS SORB ORASA     5,29 EUR A
DOM LOUCHE INOX          3,70 EUR B
ELEPHANT KIT DE LAVA    25,99 EUR B
PAT CREME UHT SE 18%     2,09 EUR A
    MONTANT DU          43,13 EUR
...
16:35:41 2/05/2026
202605021635010402310718   ← ticket id
```

### 3.1 Regex (recopiées telles quelles)

```python
_ARTICLE_RE = re.compile(
    r'^(.{2,40}?)\s+(\d+,\d{2})\s+EUR\s+([A-Z])\s*$',
    re.MULTILINE,
)

_DATE_RE = re.compile(
    r'(\d{2}):(\d{2}):(\d{2})\s+(\d{1,2})/(\d{1,2})/(\d{4})'
)

_TICKET_ID_RE = re.compile(r'^(\d{18,24})$', re.MULTILINE)

_TOTAL_RE = re.compile(
    r'MONTANT\s+DU\s+(\d+,\d{2})\s+EUR',
    re.IGNORECASE,
)
```

### 3.2 Algorithme

1. `text = "\n".join(page.extract_text() or "" for page in pdf.pages)` (toutes les pages concaténées).
2. Si `not text.strip()` → `ValueError("PDF Intermarché vide ou non extractible — vérifie qu'il s'agit bien d'un PDF avec texte natif (pas une image scannée).")`.
3. Pour chaque match de `_ARTICLE_RE` (`finditer`, donc **ordre du document préservé**) :
   - `raw_name = groupe1.strip()`
   - `store_key = " ".join(raw_name.split()).casefold()` (collapse whitespace + casefold)
   - `price = Decimal(price_str.replace(",", "."))`
   - crée `ParsedLine(raw_name, store_key, quantity=1, unit_price=price, total_price=price, vat_code=groupe3)`
   - ⚠️ **`quantity` est toujours 1** et `unit_price == total_price` : le format observé n'a pas de multi-quantité.
4. Si aucune ligne → `ValueError("Aucune ligne d'article détectée dans le PDF — format peut-être modifié. Texte extrait (premiers 300 chars) : " + repr(text[:300]))`.
5. `date` : premier match de `_DATE_RE`, ordre des groupes = `(h, mn, s, jour, mois, année)` →
   `datetime(y, mo, d, h, mn, s)` ; si `ValueError` (date invalide) → `None` ; si pas de match → `None`.
6. `ticket_id` : premier match de `_TICKET_ID_RE` (18 à 24 chiffres seuls sur leur ligne) sinon `None`.
7. `total_eur` : premier match de `_TOTAL_RE`, virgule → point, `Decimal` ; toute exception → `None`.
8. Retourne `ParsedReceipt(store="intermarche", ticket_id, date, lines, raw_text=text, total_eur)`.

### 3.3 Fiabilité

- **Bonne** sur le format échantillon (test `tests/test_receipt_parser_intermarche.py`, mais **skippé**
  si le PDF échantillon n'est pas présent sur le disque — chemin en dur
  `<ticket-intermarche-local>.pdf`). Il n'existe donc
  **aucun test qui tourne en CI** sur ce parser.
- Limites explicitement documentées dans le code, **non vérifiées** : multi-quantité
  (`YAOURT NATURE 3x1,25 = 3,75`), vrac au poids (`TOMATES 0,420 kg x 4,50 = 1,89`),
  promotions / remises.
- **Faux positifs possibles** : toute ligne finissant par `<nombre>,<2 chiffres> EUR <LETTRE>` est
  prise pour un article (une ligne de total/TVA formatée ainsi serait avalée). `MONTANT DU 43,13 EUR`
  échappe au piège uniquement parce qu'il n'y a pas de lettre après `EUR`.
- Le nom est limité à **2–40 caractères** (lazy) : un libellé plus long ne matche pas.
- Aucun OCR : un ticket photographié n'est pas exploitable par ce chemin.

---

## 4. `app/services/receipt_parser/lidl_api_adapter.py`

**Rôle** : convertir un dict JSON de ticket Lidl (renvoyé par la lib `lidl-plus`) en `ParsedReceipt`.
**Aucune dépendance tierce**, aucun accès réseau ni DB : `dict → dataclass`. C'est le seul morceau
Lidl testable hors authentification (`tests/test_lidl_plus_adapter.py`).

### 4.1 Format d'entrée attendu (docstring + fixtures de test)

```json
{
  "id": "0888338655391103020526",
  "date": "2026-05-02T16:09:13",
  "store": {"id": "3386", "name": "AHUY Vigier"},
  "totalAmount": "35.62",
  "currency": "EUR",
  "items": [
    {
      "id": "0082231",
      "name": "Concombre",
      "quantity": "2",
      "currentUnitPrice": "1.29",
      "originalUnitPrice": "1.29",
      "currentTotalPrice": "2.58",
      "taxGroup": "5.5",
      "isWeight": false,
      "discounts": []
    }
  ]
}
```

> ⚠️ Ce format est **supposé** (« basé sur l'observation de la lib comm. »), validé uniquement sur
> Lidl DE/AT/UK. Les champs `store`, `currency`, `originalUnitPrice`, `isWeight`, `discounts`
> sont **ignorés** par l'adapter.

### 4.2 Helpers de conversion (règles exactes)

| Helper | Règle |
|---|---|
| `_to_decimal(v)` | `None` si `v is None` ; sinon `Decimal(str(v).replace(",", "."))` ; `None` sur `InvalidOperation`/`ValueError`. Passage par `str` volontaire (évite le bruit binaire de `Decimal(float)`). |
| `_to_int_qty(v)` | `1` si `None` ; sinon `max(1, int(round(float(str(v).replace(",", ".")))))` ; `1` sur erreur. **⇒ un vrac de 0,420 kg devient `quantity = 1`** (perte de précision assumée ; le `total_price` reste juste). |
| `_tax_to_vat_code(t)` | `""` si `None` ou non numérique. `abs(rate-5.5) < 0.1` → `"A"` ; `abs(rate-20.0) < 0.5` → `"B"` ; `abs(rate-10.0) < 0.5` → `"C"` ; sinon `""`. **Ordre d'évaluation : A puis B puis C.** |
| `_parse_iso_date(s)` | `None` si falsy ; `datetime.fromisoformat(str(s))` ; log warning + `None` si `ValueError`. |

### 4.3 `adapt_lidl_json(ticket_json) -> ParsedReceipt`

1. `items_raw = ticket_json.get("items", []) or []`.
2. Pour chaque `item` :
   - ignore si ce n'est pas un `dict` ;
   - `name = (item.get("name") or "").strip()`, `art_id = (item.get("id") or "").strip()` ;
   - **ignore la ligne si `name` ET `art_id` sont vides** ;
   - `unit_price = _to_decimal(item["currentUnitPrice"])`, `total_price = _to_decimal(item["currentTotalPrice"])`,
     `quantity = _to_int_qty(item["quantity"])`, `vat_code = _tax_to_vat_code(item["taxGroup"])` ;
   - **complétion croisée** : si `total_price is None` et `unit_price` connu et `quantity` truthy →
     `total_price = unit_price * Decimal(quantity)` ; si `unit_price is None` et `total_price` connu →
     `unit_price = total_price / Decimal(quantity)` (division `Decimal`, pas d'arrondi explicite) ;
   - `ParsedLine(raw_name = name or f"Article {art_id}", store_key = art_id or name.casefold(), quantity, unit_price, total_price, vat_code)`.
3. Retourne `ParsedReceipt(store="lidl", ticket_id=(ticket_json.get("id") or "").strip() or None, date=_parse_iso_date(ticket_json.get("date")), lines, raw_text="", total_eur=_to_decimal(ticket_json.get("totalAmount")))`.

**Fiabilité** : tolérant par construction (aucune exception levée sur champ manquant) ; un ticket
dégradé produit un `ParsedReceipt` partiel. Les remises (`discounts`) ne sont **pas** répercutées —
acceptable car `currentUnitPrice` est censé refléter le prix payé.

**Portage** : trivial (fonction pure). À réécrire tel quel en TypeScript, en remplaçant `Decimal`
par une représentation en centimes (entier) ou une lib décimale — voir §11.

---

## 5. `app/services/lidl_plus_client.py` — authentification et récupération des tickets

### 5.1 Rôle et posture

Wrapper « fin » autour de la lib **communautaire PyPI `lidl-plus`** (déclarée en extra optionnel
`[lidl]` dans `pyproject.toml` : `lidl-plus>=0.3` + `keyring>=24`). Trois objectifs affichés :
dégradation gracieuse si la lib est absente, sécurité des secrets, testabilité par injection.

**⚠️ Point capital pour le portage** : **ce fichier ne contient AUCUN endpoint HTTP, aucune URL,
aucun flux OAuth.** Toute la mécanique d'authentification réelle (login, captcha, échange de token,
appel des API Lidl) est **à l'intérieur de la lib tierce**, traitée ici comme une boîte noire. Le
seul contrat visible dans le code est :

```python
from lidlplus import LidlPlusApi
LidlPlusApi(refresh_token=refresh_token, language="fr", country="FR")
# méthodes utilisées :
client.tickets()            -> list[dict]
client.ticket(ticket_id)    -> dict
```

Le `Protocol` interne le formalise :

```python
class _LidlClientProtocol(Protocol):
    def tickets(self) -> list[dict[str, Any]]: ...
    def ticket(self, ticket_id: str) -> dict[str, Any]: ...
```

Le code ne dit **nulle part** comment le `refresh_token` initial est obtenu : le VM expose
`storeCredentials(email, refresh_token)` et le docstring parle d'un « flow captcha » côté QML, mais
**aucun code de ce dépôt n'implémente ce flow**. C'est donc une saisie manuelle du token par
l'utilisateur (ou un outil externe). **Ambiguïté à lever avant portage.**

### 5.2 Stockage des secrets

```python
_KEYRING_SERVICE  = "prandia/lidl-plus"
_KEY_REFRESH_TOKEN = "refresh_token"
_KEY_EMAIL         = "email"
```

- `store_credentials(email, refresh_token)` : lève `LidlPlusError` si `keyring` n'est pas installé
  (**refus explicite d'écrire un secret en clair**), sinon deux `keyring.set_password`.
- `get_stored_credentials() -> StoredCreds(email: str|None, has_refresh_token: bool)` — ne renvoie
  jamais le token lui-même.
- `purge_credentials()` : supprime les deux clés, exceptions avalées (idempotent).
- Le **mot de passe n'est jamais persisté** ; le token vit dans Windows Credential Manager /
  Keychain / libsecret. La DB ne contient **aucun secret** (cf. `lidl_plus_settings`).

### 5.3 Disponibilité

- `is_available()` : `try: import lidlplus; return True except ImportError: return False`.
  Import volontairement paresseux (bundle PyInstaller allégé). Documenté : renvoie `True` même si
  l'API Lidl a changé — c'est `fetch_*` qui lèvera.
- `is_keyring_available()` : idem sur `import keyring`.

### 5.4 Construction du client et injection de test

`_build_real_client()` : vérifie `is_available()` puis `get_stored_credentials().has_refresh_token`,
sinon `LidlPlusError` avec message FR (« La lib `lidl-plus` n'est pas installée… » /
« Pas de connexion Lidl Plus enregistrée… »). Lit le token via `keyring.get_password`, puis
instancie `LidlPlusApi(refresh_token=..., language="fr", country="FR")`. **Aucun appel réseau à
l'instanciation** (d'après le docstring).

Variable module `_client_factory` (défaut `_build_real_client`), avec `_inject_client_factory(f)` /
`_reset_client_factory()` pour les tests.

### 5.5 API publique

```python
fetch_recent_tickets(limit: int = 10) -> list[dict]
```
1. `client = _client_factory()` ; `LidlPlusError` re-levée telle quelle ; toute autre exception →
   `LidlPlusError(f"Connexion Lidl Plus impossible : {exc}. Si l'API a changé, mets à jour la lib via `pip install --upgrade lidl-plus`.")`.
2. `tickets = client.tickets()` ; exception → `LidlPlusError(f"Échec de récupération des tickets Lidl : {exc}")`.
3. **Tri défensif côté Python** : `sorted(tickets, key=lambda t: t.get("date", ""), reverse=True)`
   (tri lexicographique sur la chaîne ISO — correct pour un format `YYYY-MM-DDThh:mm:ss`), puis `[:limit]`.
4. Pas de filtre `since` : le dédoublonnage est à la charge de l'appelant via `imported_receipt`.

```python
fetch_ticket_detail(ticket_id: str) -> dict
```
Même gestion d'erreurs ; retourne le dict brut, destiné à `adapt_lidl_json`.

### 5.6 Orchestration côté app (`app/ui/viewmodels/lidl_plus_vm.py` + `LidlPlusSettingsRepo`)

État persistant en DB — table `lidl_plus_settings`, **singleton PK = 1**, créée à la volée :

| Colonne | Type | Défaut | Note |
|---|---|---|---|
| `id` | int PK | 1 | |
| `enabled` | int (bool) | 0 | |
| `poll_interval_minutes` | int | 60 | `set_poll_interval` force `max(5, minutes)` |
| `last_fetched_at` | datetime\|null | | `mark_fetched()` remet `last_error = None` |
| `last_error` | text\|null | | `mark_error(msg)` tronque à **500 caractères** |
| `created_at` / `updated_at` | datetime | now | |

Comportement du VM :

- `start_if_enabled()` (appelé depuis `main.py`) : no-op si la lib est absente ; sinon si
  `enabled`, arme un `QTimer` à `poll_interval_minutes × 60 000 ms` et planifie une **première sync
  différée de 15 s** (`QTimer.singleShot(15_000, syncNow)`).
- `setEnabled(true)` alors que la lib est absente → message d'erreur + re-bascule à `false` en DB.
- `setPollIntervalMinutes(m)` : ignore `m < 5`.
- `syncNow()` : garde `_inflight` (pas de sync concurrente), lance un `threading.Thread(daemon=True)`.
  Le worker :
  1. `fetch_recent_tickets(limit=20)` (⚠️ limite **20** ici, alors que le défaut de la fonction est 10) ;
  2. filtre `new_ids = [str(t["id"]) for t in tickets if t.get("id") and not ImportedReceiptRepo.exists(str(t["id"]))]` ;
  3. `mark_fetched(datetime.now())` + commit ;
  4. message FR pluralisé (`"3 nouveaux tickets Lidl"` / `"Sync OK — aucun nouveau ticket."`) ;
  5. sur `LidlPlusError` : `mark_error(...)` + `error_emitted` ; sur toute autre exception :
     `"Erreur inattendue : {exc}"` — le timer n'est **jamais** cassé.
- `fetchTicketDetailAsDict(ticket_id)` → dict brut passé au `ReceiptImportViewModel.loadFromLidlJson`.
- `pendingTicketIds()` / `removePendingTicketId(id)` : file d'attente en mémoire (non persistée).

### 5.7 Portabilité dans un Cloudflare Worker — **non, pas en l'état**

| Élément | Portable ? | Détail |
|---|---|---|
| `adapt_lidl_json` | ✅ oui | Fonction pure, à réécrire en TS. |
| `lidl-plus` (lib Python) | ❌ non | Pas de runtime Python dans un Worker ; il faudrait **réimplémenter le protocole OAuth Lidl en TS**, or ce dépôt n'en documente rien (pas d'URL, pas de client_id, pas de scopes). **Reverse-engineering de la lib upstream requis.** |
| `keyring` | ❌ non | Pas de trousseau OS. Équivalent : chiffrer le refresh token et le stocker en D1/KV, ou Cloudflare **Secrets Store** ; ou ne jamais stocker et demander à l'utilisateur de recoller le token. Un token en clair dans D1 contredirait la posture sécurité actuelle (« refus de stocker en clair »). |
| Captcha du login Lidl | ❌ non | Impossible à automatiser côté Worker. Le flow devra rester manuel (l'utilisateur colle un refresh token obtenu ailleurs). |
| Polling toutes les 60 min | ⚠️ à remplacer | `QTimer` → **Cron Trigger Cloudflare** (`wrangler.toml`, ex. `*/60 * * * *`) ou Durable Object Alarm. Attention aux limites de CPU/durée : le fetch + N détails doit tenir dans le budget d'un scheduled event ; sinon, découper en queue. |
| Thread daemon `_sync_worker` | ⚠️ | Devient un handler `scheduled()` async ou un `ctx.waitUntil()`. |

**Recommandation de portage** : traiter Lidl Plus comme une feature **opt-in de second rang**,
derrière un endpoint Worker `POST /api/lidl/sync` protégé, avec le refresh token fourni par
l'utilisateur et stocké chiffré. Prévoir un **fallback prioritaire** : import d'un ticket Lidl par
copier-coller du JSON, ou photo/upload — l'adapter JSON étant déjà découplé, il fonctionne
indépendamment de l'origine du dict.

---

## 6. `app/services/receipt_watcher.py` — surveillance de dossier (spécifique desktop)

**Rôle** : détecter l'arrivée d'un fichier ticket dans un dossier local et émettre un signal Qt.
**Dépendances** : `watchdog>=4.0` (FSEvents / inotify / ReadDirectoryChangesW), `PySide6.QtCore`, `threading`.

### 6.1 Dossier surveillé

```python
_VALID_EXTENSIONS = {".pdf", ".html", ".htm"}

def default_receipt_dir() -> Path:
    override = os.environ.get("PRANDIA_RECEIPT_DIR")
    if override:
        return Path(override)
    return Path.home() / "Downloads" / "Tickets de caisse"
```

- `ensure_receipt_dir(path=None)` : `mkdir(parents=True, exist_ok=True)`, idempotent, appelé au boot.
- `list_pending_files(path=None)` : liste les fichiers **déjà présents** (rattrapage des dépôts faits
  app fermée) ; filtre sur l'extension (casse insensible) ; **ignore les sous-dossiers** ;
  **tri par `st_mtime` croissant (le plus ancien d'abord)**.
- **Sécurité déclarée** : jamais `~/Downloads` directement, uniquement le sous-dossier dédié.

### 6.2 Déclencheur exact

`_ReceiptHandler(FileSystemEventHandler)` :

- `on_created(event)` : ignore les répertoires ; ignore si l'extension n'est pas dans
  `_VALID_EXTENSIONS` ; sinon `_schedule(path)`.
- `on_moved(event)` : ignore les répertoires ; regarde **`event.dest_path`** ; même filtre
  d'extension ; `_schedule(dest)`. → **c'est ce cas qui capte les téléchargements Chrome**
  (`fichier.crdownload` → renommé `fichier.pdf` en fin de download).
- `_schedule(path)` : `threading.Timer(_WRITE_SETTLE_DELAY_S, callback, args=(path,))`, daemon,
  avec **`_WRITE_SETTLE_DELAY_S = 0.25`** (250 ms) — laisse le fichier finir de s'écrire avant que
  le parser PDF ne l'ouvre. `threading.Timer` et pas `QTimer.singleShot` car le thread watchdog n'a
  pas de boucle d'événements Qt.
- ⚠️ Aucun `on_modified` : un fichier écrasé en place n'est **pas** re-détecté.
- ⚠️ Aucune déduplication : `on_created` **et** `on_moved` peuvent tirer deux fois pour un même
  fichier selon l'OS ; côté VM, `onWatcherDetectedFile` déduplique via `if path not in self._pending_files`.

### 6.3 Classe `ReceiptWatcher(QObject)`

- Signal `file_detected = Signal(str)` (chemin absolu, `path.resolve()`).
- `start()` : sous `threading.Lock`, idempotent (no-op si déjà démarré) ; `ensure_receipt_dir` ;
  `Observer().schedule(handler, str(dir), recursive=False)` ; `observer.daemon = True` ; `start()`.
- `stop()` : `observer.stop()` + `join(timeout=2.0)`.
- `_on_new_file` émet directement le signal Qt depuis le thread `threading.Timer` — commentaire
  explicite : `Signal.emit()` est thread-safe et Qt route en `QueuedConnection` vers le slot du
  thread principal.

### 6.4 Câblage et cycle de vie (`app/main.py`)

```python
receipt_watcher = ReceiptWatcher(parent=qt_app)
receipt_watcher.file_detected.connect(receipt_import_vm.onWatcherDetectedFile)
receipt_watcher.start()
receipt_import_vm.rescanPending()
...
finally:
    receipt_watcher.stop()
```

Côté VM : `pendingFileCount` (badge status bar), `rescanPending()`, `onWatcherDetectedFile(path)`
(ajoute + émet `new_file_detected` pour un toast), `loadNextPending()` (charge le **plus ancien**,
retire de la liste si le fichier a disparu ou si le parsing échoue).

### 6.5 « Cleanup Option B » — suppression du fichier après import

Implémentée **dans le VM** (`commitImport`), pas dans le watcher :

```python
receipt_dir = default_receipt_dir().resolve()
src = self._source_path.resolve()
if str(src).startswith(str(receipt_dir)):
    src.unlink(missing_ok=True)
```

⇒ un ticket importé depuis un file picker quelconque n'est **jamais** supprimé ; seul le dossier
dédié est nettoyé. Le message de fin ajoute « · fichier supprimé ». Erreur `OSError` loguée, non fatale.

### 6.6 Portage web — **aucun équivalent, à remplacer par un flux d'entrée explicite**

Il n'existe pas d'API navigateur de surveillance de dossier (la File System Access API demande une
permission utilisateur par répertoire, n'est pas disponible sur iOS Safari, et ne notifie pas en
arrière-plan). Sur mobile, la notion même de « dossier ~/Downloads surveillé » disparaît.

Équivalents recommandés, par ordre de proximité fonctionnelle :

1. **Téléversement explicite** : `<input type="file" accept="application/pdf,image/*">` +
   drag-and-drop sur une zone. Le fichier part vers `POST /api/receipts/upload` (multipart) ;
   le Worker stocke le binaire en **R2** et déclenche le parsing.
2. **Photo du ticket** (le cas mobile naturel) : `<input type="file" accept="image/*" capture="environment">`.
   ⚠️ Cela impose une **brique OCR qui n'existe pas dans l'app actuelle** (le parser Intermarché
   suppose du texte natif). Options : Tesseract WASM côté client, ou un service OCR externe appelé
   par le Worker. **C'est un ajout de périmètre, à arbitrer.**
3. **Partage Web Share Target** (PWA Android) : déclarer `share_target` dans le manifest pour que
   l'app apparaisse dans le menu « Partager » du navigateur / de l'appli e-mail — c'est le plus
   proche du confort « le PDF arrive tout seul ».
4. **Ingestion par e-mail** (facultatif) : adresse dédiée → Cloudflare Email Routing → Worker.
   Reproduit fidèlement l'ergonomie « je ne fais rien, ça arrive ».

Le reste de la mécanique se transpose sans perte : la liste `pending` devient une table D1
(`receipt_upload` : id, r2_key, status, uploaded_at), le badge « X tickets en attente » lit cette
table, et le « cleanup option B » devient une suppression de l'objet R2 après commit.

**Parsing PDF dans un Worker** : `pdfplumber` n'a pas d'équivalent. Options :
`unpdf` / `pdfjs-dist` (extraction texte pure JS, fonctionne en Worker mais surveiller la limite CPU),
ou extraction **côté navigateur** avec `pdf.js` puis envoi du texte brut au Worker (recommandé :
déporte le coût CPU et évite d'uploader le PDF).

---

## 7. `app/services/receipt_matcher.py` — rapprochement libellé → ingrédient

### 7.1 Constantes

```python
FUZZY_THRESHOLD      = 70.0   # 0-100 : score minimum pour SUGGÉRER
FUZZY_AUTO_THRESHOLD = 90.0   # 0-100 : score minimum pour PRÉ-SÉLECTIONNER
MAX_SUGGESTIONS      = 3
```

Le commentaire du code calibre ainsi `token_set_ratio` : `90+` = très probablement le même produit
(« Tomate » vs « tomate cerise ») ; `80+` = possible (« Yaourt nature » vs « Yaourts nature 0% ») ;
`<80` = trop hasardeux. Le seuil retenu est néanmoins **70** pour la suggestion.

### 7.2 `match_receipt(session, parsed) -> MatchedReceipt`

1. Instancie `IngredientRepo`, `ReceiptAliasRepo`, `ImportedReceiptRepo`.
2. **Une seule requête** pour toute la bibliothèque personnelle :
   `library = ing_repo.list_personal()` → `SELECT * FROM ingredient WHERE in_personal_library IS TRUE ORDER BY name`.
   Construit `candidates = [(id, name) for ing in library if ing.id is not None]` (évite les N+1).
3. Appelle `_match_one` pour chaque ligne, **dans l'ordre** (l'ordre des lignes est préservé, testé).
4. `if parsed.ticket_id and imported_repo.exists(parsed.ticket_id): result.is_duplicate = True`
   (pas de `ticket_id` ⇒ jamais marqué doublon).

### 7.3 `_match_one` — algorithme en 4 niveaux (ordre strict)

`default_pantry = line.is_likely_food` — utilisé pour `add_to_pantry` **dans tous les cas de sortie**.
Rationale du code : « importer un ticket = remplir le frigo », donc tout y va sauf les lignes TVA B.

**Niveau 1 — `source_ref` (Lidl uniquement)**
```python
if store == "lidl":
    ing = ing_repo.find_by_source_ref(Source.LIDL, line.store_key)   # SELECT ... WHERE source='lidl' AND source_ref=?
    if ing is not None and ing.id is not None:
        → MatchedLine(suggestions=[ing.id], chosen_ingredient_id=ing.id,
                      match_source="source_ref", match_score=1.0)
```

**Niveau 2 — alias appris (`receipt_alias`)**
```python
alias = alias_repo.find(store, line.store_key)   # index UNIQUE (store, source_key)
if alias is not None:
    → MatchedLine(suggestions=[alias.ingredient_id], chosen_ingredient_id=alias.ingredient_id,
                  match_source="alias", match_score=1.0)
```
Applicable à **tous** les magasins (y compris Lidl si l'utilisateur a forcé un mapping manuel).

**Niveau 3 — fuzzy `rapidfuzz`**
```python
if not candidates:                       # bibliothèque vide
    → MatchedLine(match_source="none", match_score=0.0)

matches = process.extract(
    line.raw_name,
    [name for _id, name in candidates],
    scorer=fuzz.token_set_ratio,
    processor=str.casefold,
    limit=MAX_SUGGESTIONS,               # = 3
)
above_threshold = [(name, score, idx) for name, score, idx in matches if score >= FUZZY_THRESHOLD]
if not above_threshold:
    → MatchedLine(match_source="none", match_score=0.0)

suggestion_ids = [candidates[idx][0] for _n, _s, idx in above_threshold]
best_score = above_threshold[0][1] / 100.0
chosen = suggestion_ids[0] if best_score >= (FUZZY_AUTO_THRESHOLD / 100.0) else None
→ MatchedLine(suggestions=suggestion_ids, chosen_ingredient_id=chosen,
              match_source="fuzzy", match_score=best_score)
```

Détails qui comptent pour une réimplémentation identique :

- Le **comparé** est `line.raw_name` (le libellé brut du ticket, ex. `"FRANUI FRAMBSE CHOCO"`),
  **pas** `store_key`.
- `processor=str.casefold` : la normalisation appliquée aux deux côtés est **uniquement** un
  casefold. **Pas** de suppression de ponctuation, **pas** de dé-accentuation (contrairement au
  `default_process` de rapidfuzz). `"L'ANGELYS"` garde son apostrophe ; `"Crème"` garde son accent.
- `process.extract` renvoie `(choice, score, index)` trié par score décroissant ; `limit=3` est
  appliqué **avant** le filtre de seuil ⇒ on peut obtenir 0 à 3 suggestions.
- `match_score` est normalisé en 0–1 (division par 100), alors que le seuil est comparé en 0–100.

**Spécification de `fuzz.token_set_ratio` à répliquer** (comportement documenté de rapidfuzz ; à
valider sur corpus lors du portage, cf. §12) :

1. Tokeniser les deux chaînes sur les espaces ; construire les ensembles de tokens `A` et `B`.
2. `inter = sorted(A ∩ B)`, `diffA = sorted(A − B)`, `diffB = sorted(B − A)`, joints par des espaces.
3. `t0 = inter`, `t1 = (inter + " " + diffA).strip()`, `t2 = (inter + " " + diffB).strip()`.
4. `score = max(ratio(t0,t1), ratio(t0,t2), ratio(t1,t2)) × 100`, où `ratio` est la similarité
   **Indel normalisée** : `1 − distance_indel(x,y) / (len(x) + len(y))` (équivalent au
   `2·M/T` de `difflib.SequenceMatcher`, mais avec l'algorithme Indel exact, pas l'heuristique
   « autojunk » de difflib).

Ce niveau de fidélité est nécessaire : à seuils 70/90 constants, une implémentation JS approximative
(Levenshtein simple, Dice, Fuse.js) **ne produira pas les mêmes décisions**. Deux stratégies possibles
au portage : (a) réimplémenter token_set_ratio + Indel fidèlement ; (b) recalibrer les seuils sur un
corpus de tickets réels. **Ne pas mélanger les deux sans mesure.**

**Niveau 4 — `"none"`** : `suggestions = []`, `chosen_ingredient_id = None`. L'UI force l'utilisateur
à créer ou choisir manuellement.

### 7.4 Tables de persistance associées

**`receipt_alias`** (`app/data/orm.py`, `app/data/repositories/receipt_alias.py`)

| Colonne | Type | Note |
|---|---|---|
| `id` | int PK | |
| `store` | varchar(20) | slug enseigne |
| `source_key` | varchar(200) | libellé normalisé (Intermarché) ; **non utilisé pour Lidl** |
| `ingredient_id` | FK ingredient ON DELETE CASCADE, indexé | |
| `hit_count` | int, défaut 0 | |
| `created_at` / `updated_at` | datetime | `onupdate=now()` |
| index | `ix_receipt_alias_store_key` **UNIQUE (store, source_key)** | |

`upsert(store, source_key, ingredient_id)` : crée avec `hit_count = 1` ; si la ligne existe avec le
**même** ingrédient → `hit_count += 1` ; si elle existe avec un **autre** ingrédient → réécrit
`ingredient_id` et **remet `hit_count = 1`** (correction utilisateur).
`delete_for_ingredient(id)` supprime tous les alias d'un ingrédient.

**`imported_receipt`** (anti-doublon)

| Colonne | Type | Note |
|---|---|---|
| `ticket_id` | varchar(64) **PK** | identifiant du ticket réel |
| `store` | varchar(20) | |
| `imported_at` | datetime, `server_default=now()` | |
| `receipt_date` | datetime null | |
| `total_eur` | Numeric(10,2) null | |
| `line_count` | int, défaut 0 | |

`get` / `exists` / `add` / `list_recent(limit=20)` (tri `imported_at DESC`).

### 7.5 Ce que fait le commit (contexte indispensable au portage) — `ReceiptImportViewModel.commitImport`

1. Refuse si `is_duplicate and not force_import` : « Ticket déjà importé. Active 'Forcer' pour ré-importer. »
2. `receipt_date = parsed.date or datetime.now()`.
3. Pour chaque ligne :
   - **skip** si `chosen_ingredient_id is None` ;
   - **skip** si `unit_price is None or unit_price <= 0` (log warning) ;
   - **cascade de résolution de `quantity_g`** (un ticket ne donne jamais la masse) :
     1. `line.quantity_g` si `> 0` (saisi par l'utilisateur — prioritaire) ;
     2. sinon `ingredient.price_quantity_g` si `> 0` ;
     3. sinon `ingredient.piece_weight_g × line.parsed.quantity` si `piece_weight_g > 0` ;
     4. sinon **`1000.0` g** (placeholder assumé : la métrique €/100 g devient approximative mais
        l'évolution relative reste lisible) ;
   - `PriceHistoryRepo.add(PriceHistoryEntry(ingredient_id, price_eur = unit_price × quantity,
     quantity_g, store = parsed.store, recorded_at = receipt_date, notes = f"Import ticket — {raw_name}"))` ;
   - `recompute_current_price(session, ingredient_id)` ;
   - si `add_to_pantry` : `PantryRepo.add(PantryStock(ingredient_id, quantity_g = qty_g,
     expiry_date, notes = f"Importé depuis ticket {store}"))` ;
   - si `store != "lidl"` : `ReceiptAliasRepo.upsert(store, line.parsed.store_key, chosen_ingredient_id)`
     ⇒ **c'est là que le matcher « apprend »**.
4. Si `ticket_id` et pas doublon : `ImportedReceiptRepo.add(...)`.
5. Commit unique de la session, puis cleanup fichier (§6.5).
6. Retourne `{success, message, priceCount, pantryCount}`.

Autres slots d'édition (à reproduire côté web) : `setLineQuantity` (recalcule `total_price` **sauf**
si `user_price_override`), `setLineQuantityG` (ne touche jamais au prix), `setLineTotalPrice`
(nettoie `,`/`€`, refuse `<= 0`, recalcule `unit_price = total / max(qty,1)`, pose
`user_price_override = True`), `setLineBarcode`, `lookupBarcodeAndAssign` (EAN ≥ 8 chiffres :
cherche d'abord `source_ref` OFF puis LIDL en local, sinon `openfoodfacts.lookup_barcode`, crée et
assigne), `setLineExpiry` (ISO `YYYY-MM-DD` + `T00:00:00`), `removeLine`, `suggestCreatePayload`
(pré-remplit `categoryL1 = "Alimentaire"` si TVA A **ou** store Lidl ; `sourceRef = store_key` si Lidl),
`createIngredientFromLine` (Lidl → `Source.LIDL` + art_id ; sinon EAN saisi → `Source.OPENFOODFACTS`,
sans EAN → `Source.MANUAL` + création d'alias).

### 7.6 Fiabilité et portage

- Bien testé (`tests/test_receipt_matcher.py` : source_ref, alias, fuzzy haut/bas, biblio vide,
  doublon, ordre).
- **Faiblesse structurelle** : le fuzzy ne compare **que** contre la bibliothèque personnelle
  (`in_personal_library = True`). Une biblio vide ⇒ aucune suggestion, jamais.
- Portage : 100 % logique métier, aucun élément desktop. Le seul point délicat est la fidélité de
  `token_set_ratio` (§7.3) et la charge : `list_personal()` charge toute la bibliothèque en mémoire
  à chaque ticket — acceptable en D1 tant que la biblio reste de l'ordre de quelques milliers de lignes ;
  au-delà, pré-filtrer par FTS avant le scoring.

---

## 8. `app/services/recipe_url_importer/` — import d'une recette par URL

### 8.1 `core.py` — orchestration et erreurs

**Constantes**
```python
_USER_AGENT = "prandia/0.1.0 (+https://github.com/MarckuusS/prandia)"
_TIMEOUT    = httpx.Timeout(15.0, connect=5.0)     # 15 s total, 5 s connexion
```

**Client HTTP** (`_make_client`) : `follow_redirects=True` et en-têtes
```
User-Agent: prandia/0.1.0 (+https://github.com/MarckuusS/prandia)
Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8
Accept-Language: fr-FR,fr;q=0.9,en;q=0.8
```

**Hiérarchie d'erreurs** — toutes sous `RecipeImportError(RuntimeError)` :
`UnsupportedSite`, `NoRecipeFound`, `ParseError`, `NetworkError`.

**Messages utilisateur (FR, affichables verbatim) — `_friendly_http_error`** :

| Condition | Message |
|---|---|
| HTTP 404 | `Page introuvable (HTTP 404). Vérifie l'URL.` |
| HTTP 401 / 403 | `Cette page nécessite une connexion ou un abonnement (HTTP {code}).` |
| HTTP 502 / 503 / 504 | `Le serveur est temporairement indisponible (HTTP {code}). Réessaie dans quelques minutes.` |
| HTTP 429 | `Trop de requêtes vers ce site (HTTP 429). Attends une minute avant de réessayer.` |
| autre statut | `Le serveur a renvoyé une erreur HTTP {code}.` |
| `TimeoutException` | `Le serveur ne répond pas (timeout). Vérifie ta connexion.` |
| `ConnectError` | `Impossible de joindre ce site. Vérifie l'URL et ta connexion internet.` |
| autre `HTTPError` | `Erreur réseau : {exc}` |

**`fetch_recipe(url, *, client=None) -> ExtractedRecipe`** :

1. URL vide / blanche → `NetworkError("URL vide.")`. Sinon `url = url.strip()`.
2. `resp = client.get(url)` + `raise_for_status()` ; toute `httpx.HTTPError` → `NetworkError(_friendly_http_error(exc))`.
3. `html = resp.text or ""`.
4. **Chemin 1** : `try_recipe_scrapers(url, html=html)` ; toute exception est capturée
   (log warning) et traitée comme `None`. Si le résultat est non-`None` **et** (`name` non vide
   **ou** `ingredients` non vide) → retour immédiat.
5. Si `not html or len(html) < 50` →
   `NoRecipeFound("La page semble vide. Vérifie qu'elle s'affiche bien dans un navigateur.")`.
6. **Chemin 2** : `parse_jsonld_recipe(html, source_url=url)` ; toute exception →
   `ParseError("Les données de recette sur cette page sont mal formées.")`.
   Résultat non-`None` avec `name` ou `ingredients` → retour.
7. Sinon `UnsupportedSite("Aucune recette trouvée sur cette page. Le site n'est pas supporté ou n'expose pas de données structurées (Schema.org).")`.
8. `finally` : ferme le client s'il a été créé localement.

⇒ **Un seul GET HTTP** est fait ; le HTML est partagé entre les deux chemins.

### 8.2 `scrapers_adapter.py` — pont vers `recipe-scrapers`

**Dépendance** : `recipe-scrapers>=14.55` (~400 sites nativement : Marmiton, 750g, Hervé Cuisine,
Cuisine AZ…). Import **paresseux** ; `ImportError` → log warning + `return None` (le fallback prend le relais).

```python
scraper = scrape_html(html=html, org_url=url) if html is not None else scrape_me(url)
```
Exceptions gérées → `None` : `WebsiteNotImplementedError`, `NoSchemaFoundInWildMode`, et toute
autre exception (log warning).

Accesseurs, tous protégés par `_safe_call` (try/except → défaut) :

| Champ domaine | Source | Défaut / transformation |
|---|---|---|
| `name` | `scraper.title()` | `""` → `"(recette sans titre)"`, puis `.strip()` |
| `instructions` | `scraper.instructions()` | `""`, `.strip()` |
| `default_portions` | `scraper.yields()` | `_portions_from_yield` : premier `\d+` de la chaîne → `max(1, int)` ; sinon `1` |
| `prep_time_min` | `scraper.total_time()` | conservé **seulement si** `isinstance(int)` et `> 0`, sinon `None` |
| `image_url` | `scraper.image()` | `None` si falsy |
| `ingredients` | `scraper.ingredients()` | lignes vides ignorées ; chaque ligne → `parse_french_quantity` |
| `source_url` | l'URL passée | |

### 8.3 `jsonld_fallback.py` — parser Schema.org maison

**Dépendances** : `beautifulsoup4>=4.12` + `lxml>=5.0` (`BeautifulSoup(html, "lxml")`).

**Cible** : `<script type="application/ld+json">`. Très courant sur les blogs WordPress + WP Recipe
Maker (le gros des blogs de cuisine français), que `recipe-scrapers` n'énumère pas forcément.

**Algorithme** :

1. `html` vide → `None`.
2. `soup.find_all("script", attrs={"type": "application/ld+json"})`.
3. Pour chaque bloc, dans l'ordre du document : `raw = (script.string or script.get_text() or "").strip()` ;
   ignore si vide ; `json.loads` ; sur `JSONDecodeError` **log debug et continue** (un bloc malformé
   ne casse pas la page — testé) ; puis `_find_recipe_in_payload(payload)`.
   **Le premier nœud Recipe trouvé gagne** (`break`).
4. `_find_recipe_in_payload` : récursif — sur une liste, essaie chaque élément ; sur un dict,
   renvoie le dict si `_is_recipe_node`, sinon descend dans `@graph`. `_is_recipe_node` accepte
   `@type == "Recipe"` **ou** une liste contenant `"Recipe"`.
5. Extraction :
   - `name = _coerce_str(node["name"])` → fallback `"(recette sans titre)"` ;
   - `instructions = _instructions_from_jsonld(node["recipeInstructions"])` ;
   - `default_portions = _portions_from_yield(node["recipeYield"])` ;
   - `prep_time_min = _iso_duration_to_minutes(node["totalTime"])` ; si `None`, **somme
     `prepTime + cookTime`** (`(p1 or 0) + (p2 or 0)` si l'un des deux existe) ;
   - `image_url` : `str` direct ; sinon `list` non vide → `_coerce_str(image[0])` ; sinon `dict` →
     `_coerce_str(image.get("url") or image.get("@id"))` ; `None` si vide ;
   - `recipeIngredient` : si ce n'est pas une liste, l'emballe en liste d'un élément ; chaque
     élément passe par `_coerce_str` (ignoré si vide) puis `parse_french_quantity`.

**Helpers (règles exactes)** :

```python
_ISO_DURATION_RE = re.compile(r"^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?", re.IGNORECASE)
# total = jours×1440 + heures×60 + minutes ; retourne None si total == 0
```
⚠️ Cette regex ignore les semaines (`P1W`) et les secondes (`PT30S` → `None`). `PT1H30M` → 90.

- `_coerce_str(v)` : `None` → `""` ; liste → premier élément récursivement (`""` si vide) ;
  dict → `@value` puis `text` ; sinon `str(v).strip()`.
- `_portions_from_yield(v)` : `_coerce_str` puis premier `\d+` → `max(1, int)`, sinon `1`
  (`"6 portions"` → 6, `["4", "4 portions"]` → 4).
- `_instructions_from_jsonld(v)` : `str` → `.strip()` ; `list` → concaténation récursive **jointe
  par `"\n"`** (blocs vides sautés) ; `dict` de type `HowToSection` → récursion sur `itemListElement` ;
  autre dict → `text` sinon `name`.

**Fiabilité** : bonne et bien testée (`tests/test_recipe_url_importer.py` : cas simple, wrapper
`@graph` RankMath, bloc JSON malformé suivi d'un valide, absence de recette, 404, timeout, URL vide,
réponse vide). Ne lève jamais sur JSON malformé.

### 8.4 `quantity_parser.py` — parsing de quantités en français

**Rôle** : `parse_french_quantity(text) -> (quantity: float|None, unit_code: str|None, name: str)`.
**Aucune dépendance tierce** (`re` + `unicodedata`). **Ne lève jamais.** En cas de doute :
`(None, None, texte.strip())`.

#### 8.4.1 Table d'alias d'unités (recopiée intégralement, **l'ordre est significatif** : les
alias les plus longs d'abord ; le premier qui matche gagne)

```python
_UNIT_ALIASES: list[tuple[str, str]] = [
    # Cuillères — longest first so "c. a soupe" matches before "c"
    ("cuilleres a soupe", "c_soupe"),
    ("cuillere a soupe",  "c_soupe"),
    ("cuilleree a soupe", "c_soupe"),
    ("c. a soupe",        "c_soupe"),
    ("c a soupe",         "c_soupe"),
    ("cas",               "c_soupe"),
    ("c.s.",              "c_soupe"),
    ("c.s",               "c_soupe"),
    ("cs",                "c_soupe"),
    ("cuilleres a cafe",  "c_cafe"),
    ("cuillere a cafe",   "c_cafe"),
    ("cuilleree a cafe",  "c_cafe"),
    ("c. a cafe",         "c_cafe"),
    ("c a cafe",          "c_cafe"),
    ("cac",               "c_cafe"),
    ("c.c.",              "c_cafe"),
    ("c.c",               "c_cafe"),
    ("cc",                "c_cafe"),
    # Volumes
    ("litres", "L"), ("litre", "L"), ("ml", "ml"), ("cl", "cl"), ("dl", "dl"), ("l", "L"),
    # Masses
    ("kilos", "kg"), ("kilogrammes", "kg"), ("kilogramme", "kg"), ("kg", "kg"),
    ("grammes", "g"), ("gramme", "g"), ("gr", "g"), ("g", "g"), ("mg", "mg"),
    # Cuisine
    ("tasses", "tasse"), ("tasse", "tasse"), ("pincees", "pincee"), ("pincee", "pincee"),
]
```

Les codes produits correspondent à `app/domain/units.py` :
`g`=1 g, `kg`=1000, `mg`=0.001, `ml`=1 (densité 1), `cl`=10, `dl`=100, `L`=1000,
`c_cafe`=5, `c_soupe`=15, `tasse`=250, `pincee`=1.

```python
_LEADING_ARTICLES = ("de l'", "de la ", "des ", "du ", "de ", "d'")

_PIECE_PREFIXES = (
    "piece(s)", "pieces", "paquet(s)", "paquets", "sachet(s)", "sachets",
    "boite(s)", "boites", "tranche(s)", "tranches", "bouquet(s)", "bouquets",
    "branche(s)", "branches", "feuille(s)", "feuilles",
)

_NAME_STRIPPED_TOKENS = ("de l'", "de la ", "des ", "du ", "de ", "d'", "à ", "a ")
```

Chaque article se termine par une **frontière explicite** (espace ou apostrophe) pour que
« de la » ne mange pas le début de « de lait ».

#### 8.4.2 Normalisation et parsing de nombre

```python
def _ascii_fold(s):                       # NFKD + suppression des combinants + lower()
    nfkd = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower()
```

```python
_NUMBER_RE = re.compile(
    r"""^\s*
        (?P<num>
            \d+\s+\d+\s*/\s*\d+   # mixte : "1 1/2"
            |
            \d+\s*/\s*\d+          # fraction : "1/2"
            |
            \d+(?:[.,]\d+)?        # décimal/entier : "1,5" ou "200"
        )
        \s*
    """,
    re.VERBOSE,
)
```
**L'ordre de l'alternance est critique** : sans lui, `\d+` avalerait « 1 » de « 1/2 » et la branche
fraction ne serait jamais tentée.

`_parse_number(token)` : mixte (`" "` et `"/"` présents) → `whole + frac` récursif ;
fraction (`"/"`) → `num/den`, `None` si `den == 0` ou parsing impossible ;
sinon `float(token.replace(",", "."))`, `None` si échec. **La virgule française et le point anglais
sont tous deux acceptés.**

`_strip_leading_article(name)` : compare la forme **ascii-foldée** au préfixe, retire la longueur du
préfixe **sur la chaîne d'origine** (préserve les accents du reste), `break` au premier match.

#### 8.4.3 Algorithme complet de `parse_french_quantity`

1. `text` falsy ou blanc → `(None, None, "")`. Sinon `s = text.strip()`.
2. `_NUMBER_RE.match(s)` — pas de match → `(None, None, s)` (tout est le nom).
   `qty = _parse_number(...)` ; si `qty is None` → `(None, None, s)`.
   `rest = s[m.end():].strip()`.
3. **Unité** : `folded_rest = _ascii_fold(rest)` ; parcours de `_UNIT_ALIASES` dans l'ordre ;
   `folded_rest.startswith(alias)` **et** contrôle de frontière : le caractère suivant doit être
   absent ou **non alphanumérique** (`not after.isalnum()`).
   Si match : `rest = rest[len(alias):].strip()` puis `_strip_leading_article(rest)`.
   Si `rest` devient vide → `(qty, unit, text.strip())` (retombe sur le texte original complet).
   Sinon `(qty, unit, rest)`.
4. **Préfixes « pièce »** (`_PIECE_PREFIXES`), même contrôle de frontière :
   `stripped = rest[len(prefix):].strip()` puis `_strip_leading_article(stripped) or stripped` ;
   si non vide → `(qty, None, stripped)` ; sinon → `(qty, None, text.strip())`.
5. **Pas d'unité reconnue** (« pièces implicites ») :
   `rest = _strip_leading_article(rest) or rest`, puis **seconde passe** sur `_NAME_STRIPPED_TOKENS`
   (qui ajoute `"à "` et `"a "`), `break` au premier match.
   Retourne `(qty, None, rest if rest else text.strip())`.

#### 8.4.4 Corpus de comportement (extrait des tests, exhaustif)

| Entrée | Sortie `(qty, unit, name)` |
|---|---|
| `"200 g de tomates cerises"` | `(200.0, "g", "tomates cerises")` |
| `"30 g d'huile d'olive"` | `(30.0, "g", "huile d'olive")` |
| `"500 gr de farine"` | `(500.0, "g", "farine")` |
| `"1 kg de pommes de terre"` | `(1.0, "kg", "pommes de terre")` |
| `"300 ml de lait"` | `(300.0, "ml", "lait")` |
| `"25 cl de vin blanc"` | `(25.0, "cl", "vin blanc")` |
| `"1 l d'eau"` | `(1.0, "L", "eau")` |
| `"1 c. à soupe d'huile d'olive"` | `(1.0, "c_soupe", "huile d'olive")` |
| `"2 cas de sucre"` | `(2.0, "c_soupe", "sucre")` |
| `"1,5 cuillères à café de sel"` | `(1.5, "c_cafe", "sel")` |
| `"3 cc de cumin"` | `(3.0, "c_cafe", "cumin")` |
| `"1 pincée de poivre"` | `(1.0, "pincee", "poivre")` |
| `"2 tasses de riz"` | `(2.0, "tasse", "riz")` |
| `"1,5 kg de carottes"` | qty `1.5` (virgule FR) |
| `"0.5 kg de farine"` | qty `0.5` (point EN) |
| `"1/2 oignon"` | `(0.5, None, "oignon")` |
| `"1/4 c. à café de muscade"` | `(0.25, "c_cafe", "muscade")` |
| `"Sel, poivre"` | `(None, None, "Sel, poivre")` |
| `"1 oignon"` / `"3 carottes"` | `(1.0, None, "oignon")` / `(3.0, None, "carottes")` |
| `""` / `"   "` | `(None, None, "")` |
| `"50ml de crème"` (sans espace) | `(50.0, "ml", "crème")` |
| `"  200  g   de  tomates  "` | `(200.0, "g", "tomates")` |
| `"1 gousse d'ail"` | `(1.0, None, "gousse d'ail")` — le `g` **ne matche pas** (frontière) |
| `"100 G de chocolat"` | `(100.0, "g", …)` — insensible à la casse |
| `"1 pièce(s) Oignon"` | `(1.0, None, "Oignon")` |
| `"1 paquet(s) Crème liquide"` | `(1.0, None, "Crème liquide")` |
| `"1 sachet(s) Épinards"` | `(1.0, None, "Épinards")` |
| `"2 pièce(s) Cuisse de poulet"` | `(2.0, None, "Cuisse de poulet")` |
| `"2 pieces de tomate"` | `(2.0, None, "tomate")` |
| `"1 pièce(s)"` (seul) | `(1.0, None, "1 pièce(s)")` — texte original conservé |

#### 8.4.5 Limites connues (non couvertes)

- Pas de gestion de `"2 x 200 g de farine"` : donne `qty = 2`, `unit = None`,
  `name = "x 200 g de farine"`.
- Pas de quantités en toutes lettres (`"une poignée de noisettes"`, `"un demi-citron"`).
- Pas de plages (`"2 à 3 cuillères"`) — `"2"` est pris, `"à 3 cuillères"` devient le nom
  amputé du `"à "` par la passe finale ⇒ `"3 cuillères"`. **Comportement à vérifier/normaliser au portage.**
- Le commentaire « Strip trailing dot ("c.s.", "c. à soupe.") » du code **ne correspond à aucune
  instruction** : aucun point final n'est retiré (les alias avec point sont déjà dans la table).
- `_ascii_fold` fait `.lower()`, pas `.casefold()` — divergence avec le reste du projet
  (négligeable en français sauf pour `ß`).

#### 8.4.6 Comment le VM consomme la sortie (`RecipeUrlImportViewModel._build_resolved`)

```python
qty  = parsed_quantity or 0.0
unit = parsed_unit or "g"
quantity_g = to_grams(qty, unit) if (qty > 0 and unit != "_piece") else qty * 1.0
# KeyError sur unité inconnue → quantity_g = qty si qty > 0 sinon 100.0
if quantity_g <= 0: quantity_g = 100.0
unit_code = unit if unit in {"g","kg","ml","cl","dl","L","c_cafe","c_soupe","tasse","pincee"} else "g"
```
⇒ **une ligne sans quantité vaut 100 g par défaut**. Puis `resolve_ingredient_name(session, parsed_name)`
donne jusqu'à 5 candidats, et **le premier est auto-sélectionné**.

Note : `unit != "_piece"` est du code mort — `parse_french_quantity` ne renvoie jamais `"_piece"`.

#### 8.4.7 `resolve_ingredient_name` (`app/services/ingredient_search.py`) — le matcher côté recettes

Distinct du `receipt_matcher` (§7). Stratégie, `max_candidates = 5` :

1. **Exact** : `find_by_name(q, source=MANUAL)` (comparaison en Python via `str.casefold()`,
   pas `LOWER()` SQL — SQLite ne gère pas l'Unicode, ex. « Œufs »).
   Si `None`, boucle sur `CIQUAL` puis `OPENFOODFACTS` et prend le premier **qui est dans la
   bibliothèque personnelle** (`break`). Boost `+0.10`.
   ⚠️ **Piège** : si un match exact MANUAL existe mais **hors** bibliothèque personnelle, la boucle
   CIQUAL/OFF n'est **pas** exécutée (branche `elif`) — l'exact est simplement perdu.
2. **FTS5 préfixe** dans `scope="personal"`, `limit = max_candidates × 2` ; boost `+0.10`.
3. Si le pool < 5, **extension** en `scope="all"` (CIQUAL + OFF caché), boost `0.0`.
4. **Re-classement** : `score = fuzz.token_set_ratio(q.lower(), name.lower()) / 100 + boost`,
   tri décroissant, `[:max_candidates]`. Si `rapidfuzz` est absent (`ImportError`), renvoie le pool
   dans l'ordre d'insertion tronqué à 5.

Jamais de réseau ; l'appel OFF est explicite (`searchOnlineForLine`).

### 8.5 Fiabilité globale de l'import URL et portage

- **recipe-scrapers est irremplaçable tel quel** : ~400 scrapers spécifiques Python. Aucun
  équivalent JS de couverture comparable. Conséquences pour le Worker :
  - soit on **n'implémente que le chemin JSON-LD** (fallback maison) — ce qui couvre déjà la
    majorité des blogs WordPress/WPRM, mais **perd** les sites dont le balisage est cassé et que
    recipe-scrapers corrige à la main (Marmiton en particulier a historiquement des quirks) ;
  - soit on héberge recipe-scrapers hors Worker (conteneur Python, Cloud Run, Fly.io) appelé par
    le Worker — coût d'infra supplémentaire, contraire à l'esprit « tout Cloudflare » ;
  - soit on ajoute progressivement des extracteurs sur mesure pour les 3-5 sites réellement utilisés.
  **Décision à arbitrer explicitement.**
- BeautifulSoup + lxml → **`HTMLRewriter`** (natif Workers, streaming) suffit largement à extraire
  le contenu des `<script type="application/ld+json">` ; sinon `linkedom` / `cheerio`
  (attention à la taille du bundle et à la limite CPU).
- `httpx` → `fetch()`. Pas de problème CORS (requête serveur→serveur), mais **certains sites
  bloquent les IP Cloudflare ou les UA non-navigateur** : prévoir de conserver l'UA actuel ou
  d'en adopter un plus banal, et gérer les 403.
- `quantity_parser` → portage **direct et fidèle** en TS (regex compatibles ; `_ascii_fold`
  devient `s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()`).
- Threading (`threading.Thread` pour le fetch de 5-10 s) → simple `await` côté Worker ; côté UI,
  un état de chargement.

---

## 9. `app/services/photo_service.py` — stockage des photos de recette

**Dépendances** : `Pillow>=10.0` (`PIL.Image`, `PIL.ImageOps`), `httpx`, `tempfile`, `pathlib`.

### 9.1 Arborescence et convention de nommage

```python
def default_photo_dir() -> Path:
    override = os.environ.get("PRANDIA_PHOTO_DIR")
    if override:
        return Path(override)
    return Path.home() / ".prandia" / "recipe_photos"
```

- Un fichier par recette : **`<recipe_id>.jpg`** (⇒ **une seule photo par recette**, écrasée à
  chaque nouvel enregistrement).
- La colonne `recipe.image_path` stocke **le nom de fichier seul** (`"42.jpg"`), pas le chemin
  absolu — pour que déplacer le projet ne casse pas les liens.
- `absolute_photo_path(image_path, photo_dir=None) -> Path|None` :
  `None` si `image_path` falsy (**silencieux**, cas légitime « pas de photo ») ;
  `None` **+ log warning `"Photo file referenced but missing on disk: …"`** si la référence existe
  mais le fichier a disparu ; sinon le chemin absolu. QML affiche alors un placeholder « 🍽 Aucune photo ».

### 9.2 Constantes de traitement

```python
_MAX_DIMENSION = 1024          # px, côté le plus long
_JPEG_QUALITY  = 85
_DOWNLOAD_TIMEOUT    = httpx.Timeout(15.0, connect=5.0)
_DOWNLOAD_USER_AGENT = "prandia/0.1.0 (+https://github.com/MarckuusS/prandia)"
_MAX_DOWNLOAD_BYTES  = 20 * 1024 * 1024      # 20 Mo
```

### 9.3 `save_recipe_photo(src_path, recipe_id, photo_dir=None) -> str` (nom de fichier)

1. `FileNotFoundError` si la source n'existe pas.
2. `photo_dir.mkdir(parents=True, exist_ok=True)` ; cible = `photo_dir / f"{recipe_id}.jpg"`.
3. `Image.open(src)` (auto-détection du format).
4. **`ImageOps.exif_transpose(img)`** — applique l'orientation EXIF (photos iPhone/Android en
   portrait qui ont un tag Orientation plutôt que des pixels tournés).
5. **`img.thumbnail((1024, 1024), Image.Resampling.LANCZOS)`** — en place, **préserve le ratio**,
   **n'agrandit jamais** une image déjà plus petite. Une source 4000×3000 devient 1024×768.
6. **Conversion RGB** : si `mode ∈ {"RGBA", "LA", "P"}` → nouvelle image `RGB` **fond blanc
   (255,255,255)** ; `"P"` est d'abord converti en `"RGBA"` ; `paste` avec le canal alpha
   (`img.split()[-1]`) comme masque si `mode ∈ {"RGBA","LA"}`. Sinon, si `mode != "RGB"` → `convert("RGB")`.
7. `img.save(target, "JPEG", quality=85, optimize=True)`.
8. Log info + retourne `f"{recipe_id}.jpg"`.

Erreurs propagées : `FileNotFoundError`, `OSError`, `PIL.UnidentifiedImageError`.
Repère de taille validé par test : une image 2048×2048 pleine couleur pèse **< 200 Ko** en sortie.

> ⚠️ **Bug latent (mode `"P"`)** : après `img = img.convert("RGBA")`, la variable `img.mode` vaut
> `"RGBA"`, mais le test du masque `if img.mode in ("RGBA","LA")` est évalué **après** la conversion,
> donc le masque est bien appliqué. En revanche `background = Image.new("RGB", img.size, …)` est
> créé **avant** la conversion : les tailles concordent, donc pas de casse. Comportement correct
> mais fragile — à réécrire proprement au portage.

### 9.4 `save_recipe_photo_from_http_url(url, recipe_id, photo_dir=None, *, client=None) -> str`

Utilisé par le wizard d'import URL (au commit, si `ExtractedRecipe.image_url`) et par le drag-drop
d'une URL HTTP sur `RecipePhotoBlock`.

1. URL vide → `ValueError("URL vide.")`.
2. Client `httpx` (UA + timeout ci-dessus, `follow_redirects=True`), injectable pour les tests
   (`httpx.MockTransport`).
3. `client.get(url)` + `raise_for_status()` (⇒ un 404 propage `httpx.HTTPStatusError` au caller).
4. **GET non streamé** ; si `len(content) > 20 Mo` → `OSError("Image trop volumineuse (… bytes ; max …)")`.
   ⚠️ Le garde-fou s'applique **après** le téléchargement complet : la mémoire est déjà consommée.
5. Extension du temp devinée par suffixe d'URL (après suppression de la query string) parmi
   `.jpg .jpeg .png .webp .gif .bmp`, défaut `.img` — purement cosmétique.
6. `tempfile.NamedTemporaryFile(delete=False, suffix=…, prefix="recipe-photo-")`, écriture, puis
   délégation à `save_recipe_photo`.
7. `finally` : `unlink` du temp (erreur loguée seulement) + fermeture du client s'il est local.

### 9.5 `delete_recipe_photo(image_path, photo_dir=None) -> bool`

`False` si `image_path` falsy ou fichier absent ; sinon `unlink` → `True` ; `OSError` logué et
avalé → `False`. Idempotent.

### 9.6 Portage web

| Élément desktop | Équivalent web recommandé |
|---|---|
| Pillow resize/recompress | **Redimensionnement navigateur** avant envoi : `createImageBitmap(file, { imageOrientation: "from-image" })` (applique l'EXIF nativement) → `OffscreenCanvas` dimensionné pour que `max(w,h) ≤ 1024` en conservant le ratio → `canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 })`. **Reproduit exactement** la spec actuelle (1024 / q85 / EXIF appliqué). ⚠️ Pillow n'agrandit jamais : reproduire `scale = min(1, 1024 / max(w,h))`. |
| Aplatissement alpha sur blanc | `ctx.fillStyle = "#fff"; ctx.fillRect(...)` avant `drawImage` — indispensable, le JPEG n'a pas d'alpha. |
| `~/.prandia/recipe_photos/<id>.jpg` | Bucket **R2**, clé `recipes/<recipe_id>.jpg` (même convention « une photo par recette, écrasée »). `recipe.image_path` en D1 garde la **clé relative**, pas l'URL absolue — même raisonnement de portabilité. |
| Lecture / affichage | URL signée R2, ou route Worker `GET /api/recipes/:id/photo` qui proxie depuis R2 (permet le cache et le contrôle d'accès). |
| `absolute_photo_path` renvoyant `None` + warning | `HEAD` R2 (`env.BUCKET.head(key)`) → 404 → placeholder côté UI ; loguer l'incohérence. |
| Téléchargement d'image distante (import URL) | `fetch()` dans le Worker, garde-fou de taille **en streaming** via `Content-Length` puis lecture bornée (mieux que l'actuel : ne pas charger 20 Mo avant de refuser). Puis, faute de Pillow : soit **Cloudflare Images** / `cf.image` resizing, soit stocker l'original et redimensionner à la volée, soit renvoyer l'URL au client pour qu'il fasse le canvas. |
| Fichier temporaire + cleanup | Disparaît : `ArrayBuffer` → `env.BUCKET.put(key, buffer)`. |
| `PRANDIA_PHOTO_DIR` (surcharge par env) | Binding R2 + préfixe de clé configurable. |
| Suppression | `env.BUCKET.delete(key)`, idempotent. |

---

## 10. Récapitulatif des dépendances tierces (services d'ingestion uniquement)

| Lib | Version (pyproject) | Utilisée par | Équivalent web |
|---|---|---|---|
| `pdfplumber` | `>=0.11` | détection d'enseigne + parser Intermarché | `unpdf` / `pdfjs-dist` (Worker ou navigateur) |
| `rapidfuzz` | `>=3.5` | `receipt_matcher`, `resolve_ingredient_name` | à réimplémenter (token_set_ratio + Indel) |
| `watchdog` | `>=4.0` | `receipt_watcher` | **aucun** — remplacer par upload / photo / share target |
| `recipe-scrapers` | `>=14.55` | `scrapers_adapter` | **aucun équivalent de couverture** (voir §8.5) |
| `beautifulsoup4` + `lxml` | `>=4.12` / `>=5.0` | `jsonld_fallback` | `HTMLRewriter` (natif Workers) ou `linkedom` |
| `httpx` | `>=0.27` | `core`, `photo_service` | `fetch()` |
| `Pillow` | `>=10.0` | `photo_service` | Canvas navigateur / Cloudflare Images |
| `lidl-plus` | extra `[lidl]`, `>=0.3` | `lidl_plus_client` | **aucun** — protocole à reverse-engineer |
| `keyring` | extra `[lidl]`, `>=24` | `lidl_plus_client` | Secrets Store / D1 chiffré / pas de stockage |
| `PySide6` | `>=6.6` | `receipt_watcher` (QObject/Signal) | événements / SSE / polling |

---

## 11. Points de portage délicats — synthèse

1. **`lidl_plus_client` n'est pas portable** : zéro endpoint dans ce dépôt, tout est dans la lib
   Python ; login à captcha ; `keyring` sans équivalent. → traiter en feature secondaire, prévoir
   un chemin « coller le JSON du ticket » qui réutilise `adapt_lidl_json` (lui, trivialement portable).
2. **`receipt_watcher` disparaît** : aucun équivalent mobile/web du dossier surveillé. → upload
   explicite + **Web Share Target** (PWA Android) comme meilleur substitut ergonomique ; photo +
   OCR si l'on veut le cas mobile complet (**ajout de périmètre**, pas de la simple traduction).
3. **`pdfplumber` → PDF en JS** : préférer l'extraction texte **côté navigateur** (`pdf.js`) et
   n'envoyer que le texte au Worker (économie CPU Worker, pas d'upload de PDF).
4. **`recipe-scrapers` sans équivalent** : décider entre « JSON-LD seul » (dégradation de la
   couverture) et « micro-service Python » (rupture de l'architecture tout-Cloudflare).
5. **Fidélité de `token_set_ratio`** : les seuils 70 / 90 ne veulent rien dire avec un autre
   scorer. Réimplémenter fidèlement **ou** recalibrer sur corpus, jamais l'un pour l'autre.
6. **`Decimal` → TypeScript** : `unit_price`, `total_price`, `total_eur`, `price_eur` sont des
   `Decimal` Python et `Numeric(10,2)` en base. En JS, stocker des **centimes entiers** (ou une lib
   décimale) ; attention à `unit_price = total_price / Decimal(quantity)` dans l'adapter Lidl, qui
   produit aujourd'hui une valeur non arrondie.
7. **Threads → async** : les 3 usages (`ReceiptWatcher._schedule`, `LidlPlusViewModel._sync_worker`,
   `RecipeUrlImportViewModel._do_extract`) sont de simples « ne pas bloquer l'UI » → `await` +
   état de chargement ; le polling Lidl → **Cron Trigger**.
8. **Chemins de fichiers** : `PRANDIA_RECEIPT_DIR`, `PRANDIA_PHOTO_DIR`, `file:///` → tout disparaît.
   Attention au décodage `file:///C:/…` codé en dur dans `recipe_vm.setPhotoFromUrl` (spécifique Windows).
9. **Garde-fou de taille d'image** appliqué après téléchargement complet (20 Mo en RAM) — à
   corriger en streaming côté Worker.
10. **Une photo par recette, nommée par l'id** : cela impose que la recette soit **sauvegardée avant**
    l'ajout de photo (l'app émet « Sauvegarde la recette avant d'ajouter une photo. »). Si le portage
    veut permettre la photo avant la première sauvegarde, il faut passer à des clés UUID.

---

## 12. Ambiguïtés, incohérences et zones à vérifier (relevées dans le code)

1. **Watcher vs parser** : le watcher accepte `.html`/`.htm`, `parse_receipt` les refuse. Bug réel.
2. **Carrefour** : mentionné partout (slug, TBD, message d'erreur) mais **aucun parser**.
3. **Détection d'enseigne** basée sur `"FONTAINE-LES-DIJON"` — dépendante du magasin de l'utilisateur.
4. **Le seul test du parser Intermarché est skippé** en l'absence d'un PDF au chemin absolu
   `<dossier-telechargements>/f24b2e99-….pdf`. Aucune couverture CI.
5. **Format JSON Lidl non confirmé** pour la France ; l'adapter est écrit sur une observation de la
   lib côté DE/AT/UK. `store`, `currency`, `discounts`, `isWeight`, `originalUnitPrice` ignorés.
6. **Vrac Lidl** : `_to_int_qty("0.420")` → `1` (documenté comme « à enrichir Phase 5+ »).
7. **Obtention du refresh token Lidl non implémentée** dans ce dépôt (docstring parle d'un « flow
   captcha » côté QML introuvable). À clarifier avec l'utilisateur avant portage.
8. **`fetch_recent_tickets`** : défaut `limit=10`, mais le VM appelle avec `limit=20`.
9. **`_iso_duration_to_minutes`** ignore les semaines et les secondes ; `PT0S` → `None`.
10. **`quantity_parser`** : commentaire « strip trailing dot » sans code correspondant ;
    `"2 à 3 cuillères"` produit un nom bancal ; `"2 x 200 g"` non géré ; `_ascii_fold` utilise
    `lower()` au lieu de `casefold()`.
11. **`resolve_ingredient_name`, étape 1** : un match exact `MANUAL` hors bibliothèque personnelle
    court-circuite la recherche CIQUAL/OFF (branche `elif`) — probable bug.
12. **`unit != "_piece"`** dans `_build_resolved` : code mort (`"_piece"` n'est jamais produit).
13. **Doublons d'événements watcher** (`on_created` + `on_moved`) non dédupliqués au niveau du
    handler ; seul le VM déduplique.
14. **`receipt_alias.hit_count`** est incrémenté mais **jamais lu** nulle part (pas de tri par
    fréquence). À porter ou à supprimer sciemment.
15. **Défaut `quantity_g = 1000.0`** au commit d'un ticket : choix assumé mais qui fausse les
    métriques €/100 g absolues. À exposer clairement dans l'UI web.
16. **`ParsedLine.is_likely_food`** considère un code TVA vide comme alimentaire ⇒ toutes les lignes
    Lidl dont le `taxGroup` est inconnu partent au frigo par défaut.
