# 00 — SPÉCIFICATION DE PORTAGE — "Prandia" : desktop Qt → webapp Cloudflare

Document de référence du portage. Consolide les sept inventaires détaillés :

| Fichier | Périmètre |
|---|---|
| `01-domain.md` | Modèles Pydantic, formules nutrition / prix / unités, dataclasses tickets & import URL |
| `02-data.md` | Schéma SQLite réel (15 tables + FTS5), 12 repositories, migrations inline, seeds |
| `03-services-core.md` | OpenFoodFacts, recherche d'ingrédients, nutrition, courses, planning, prix |
| `04-services-ingest.md` | Tickets de caisse, Lidl Plus, import de recette par URL, photos |
| `05-viewmodels.md` | 13 viewmodels, 5 modèles de liste, surface d'appel complète |
| `06-pages.md` | 5 pages QML, libellés, interactions, adaptation mobile |
| `07-dialogs.md` | 16 dialogues, 25 composants, jetons de design |

**Cible** : front TypeScript (PWA mobile-first) + Cloudflare Worker + D1 (SQLite managé) + R2 (photos).

**Avertissement conservé de tous les inventaires** : `CLAUDE.md` et `architecture.md` du dépôt sont
**périmés** et ne décrivent ni les tickets de caisse, ni Lidl Plus, ni l'import de recette par URL,
ni les catégories, ni le frigo, ni l'historique de prix, ni le journal de cuisson, ni la source
`'lidl'`. Ce document s'appuie exclusivement sur le code réel lu.

### Conventions de cotation d'effort

| Cote | Signification |
|---|---|
| **Faible** | Logique pure ou CRUD direct, transposition mécanique. Ordre de grandeur : ≤ 1 jour. |
| **Moyen** | Plusieurs jours : UI dense, agrégations, ou dépendance à remplacer par un équivalent connu. |
| **Élevé** | Réécriture non triviale, dépendance sans équivalent JS, ou arbitrage produit requis. |

🖥 = **spécifique desktop** : pas d'équivalent mobile/web direct, la fonctionnalité doit être
repensée ou abandonnée.

### Volumétrie réelle des données (base de production au 2026-08-01)

| Table | Lignes |
|---|---|
| `ingredient` | 4 177 (3 484 ciqual dont 21 en biblio perso ; 693 OFF dont 37 en biblio perso) |
| `ingredient_fts` | 4 177 |
| `recipe` / `recipe_ingredient` / `recipe_tag` | 6 / 56 / 5 |
| `tag` | 10 (tags par défaut) |
| `meal_plan_entry` / `meal_plan_template` | 2 / 1 |
| `pantry_stock` | 3 |
| `ingredient_price_history` | 8 |
| `recipe_cooking_log` | 0 |
| `imported_receipt` / `receipt_alias` | 1 / 1 |
| `category_definition` | 35 |
| `lidl_plus_settings` | 1 |
| `weekly_cost_snapshot` | 2 |

**Conséquence majeure** : la base est minuscule (≈ 4 300 lignes utiles). La migration des données
est un problème de **fidélité**, pas de volume. Aucune contrainte de performance ne justifie de
compromis d'architecture.

---

## 1. Inventaire des fonctionnalités

### 1.1 Onglet Ingrédients

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| I-01 | Liste de la bibliothèque personnelle | `in_personal_library = 1`, `ORDER BY name`. Limites en dur desktop : 500 si filtre texte, 2000 sinon | Faible | |
| I-02 | Recherche texte plein-texte | FTS5 `unicode61 remove_diacritics 2`, tokens `"tok"*` joints par AND implicite, debounce 200 ms | Moyen | |
| I-03 | Tri (18 options) | `name/kcal/proteins/carbs/fats/fiber/salt/price/created` × asc/desc. `NULL` **toujours en fin**, dans les deux sens | Faible | |
| I-04 | Groupement en sections | `none / source / rayon / season / kcal_range` → rôle `groupKey` ; libellés d'en-tête dérivés | Faible | |
| I-05 | Filtres avancés (12 axes) | sources, rayons, de saison, avec marque, avec poids unitaire, avec prix, 6 plages macro min/max. Badge `activeFilterCount` | Moyen | |
| I-06 | Persistance des options de vue | QSettings (registre Windows) → `localStorage` | Faible | 🖥 |
| I-07 | Formulaire ingrédient (20 champs) | nom, réf. source, marque, 8 macros /100 g, poids unitaire, poids cuit, rayon, 12 mois de saison. Prix et quantité de réf. en **lecture seule** | Moyen | |
| I-08 | Sémantique « clé présente » à la sauvegarde | `brand`, `categoryL1`, `categoryL2`, `seasonMonths` : absents du payload ⇒ valeur existante préservée. Macros `0`/`""` ⇒ `NULL` (impossible d'enregistrer une macro à 0) | Faible | |
| I-09 | Détection de collision de nom | Sur **création** seulement, `find_by_name(name, MANUAL)` insensible à la casse → dialogue « Éditer l'existant / Annuler » | Faible | |
| I-10 | Suppression soft / hard | `manual` → suppression dure ; `ciqual/openfoodfacts/lidl` → `in_personal_library = 0`. `ON DELETE RESTRICT` si l'ingrédient est utilisé dans une recette | Faible | |
| I-11 | Annulation de suppression (toast 5 s) | Un seul niveau. L'undo d'une suppression dure recrée avec un **nouvel id**, sans re-lier les références | Moyen | |
| I-12 | Liens externes CIQUAL / OFF | `ciqual.anses.fr/#/aliments/<ref>` et `world.openfoodfacts.org/product/<ref>` | Faible | |
| I-13 | Saisonnalité | CSV de mois 1–12, 12 bascules, badge `🌱 De saison` calculé sur le mois **local** | Faible | |
| I-14 | Sélecteur de rayon | Liste plate des `category_definition` de niveau 1 | Faible | |
| I-15 | Multi-sélection → « Trouver les recettes » | ≥ 2 cases cochées, `findByIngredientsCategorized(ids, maxMissing=3)` | Moyen | |
| I-16 | Glisser un ingrédient vers Frigo / Calendrier | DnD Qt + onglets magnétiques (300 ms) | Moyen | 🖥 |

### 1.2 Catalogue & sources externes

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| C-01 | Dialogue d'import CIQUAL | Recherche paginée (25/page) + filtres macro min/max + catégorie + tri + multi-sélection persistante inter-pages | Moyen | |
| C-02 | Import OFF en ligne | `search.openfoodfacts.org/search` (Search-a-licious), requête Lucene, `langs=fr,en`, 30 résultats. **Tris macro refusés par l'API** → tri client page-locale | Élevé | |
| C-03 | Promotion en bibliothèque | Unitaire (`importExisting`) et en lot (`importMany`, transaction unique) | Faible | |
| C-04 | Lookup code-barres EAN | `world.openfoodfacts.org/api/v2/product/{ean}`, validation locale « chiffres, ≥ 8 » | Faible | |
| C-05 | Cache local des résultats OFF | `upsert_by_source_ref` — ⚠️ **écrase les champs utilisateur** (prix, poids pièce, catégories, `in_personal_library`) | Moyen | |
| C-06 | Indicateur de disponibilité OFF | `GET search.openfoodfacts.org/` toutes les 5 min, accepte 2xx **et 3xx**, `redirect: manual` | Faible | 🖥 |
| C-07 | Chargement du catalogue CIQUAL | Lecture `.xls`/`.xlsx`/`.csv` ANSES, normalisation d'en-têtes, upsert idempotent par `alim_code`. **Action manuelle**, jamais déclenchée par l'app | Élevé | 🖥 |
| C-08 | Semis de saisonnalité | 56 préfixes → CSV de mois, `UPDATE … WHERE season_months IS NULL`. 🐛 les motifs à initiale accentuée (`épinard`) ne matchent jamais | Faible | |

### 1.3 Onglet Recettes

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| R-01 | Liste des recettes + vignette | 68 px, `photoUrl`, `N portions · M ingrédients` | Faible | |
| R-02 | Filtre par tags (chips) | Sémantique **OU** (au moins un tag), pas ET | Faible | |
| R-03 | Éditeur : méta | nom, portions (1–50), instructions | Faible | |
| R-04 | Éditeur : lignes d'ingrédients | Picker debounce 200 ms, quantité + unité (11 unités + « pièce »), notes, ordinal, tri par `(rayon, ordinal)` | Moyen | |
| R-05 | Conversion d'unités | Stockage **toujours en grammes**, l'unité choisie n'est que cosmétique et restituée au rechargement | Moyen | |
| R-06 | Buffer d'édition + garde « non sauvegardé » | Modale 3 boutons Enregistrer / Abandonner / Annuler | Moyen | |
| R-07 | Mise à l'échelle des portions | `scaleRatio = displayPortions / defaultPortions` ; saisir une quantité affichée stocke la valeur ramenée au défaut | Moyen | |
| R-08 | Tableau nutritionnel 3 colonnes | Pour 100 g cru / par portion / recette entière, ordre réglementaire UE 1169/2011, décimales fixées par ligne | Moyen | |
| R-09 | Donut de composition (Atwater) | Lipides ×9, glucides ×4, fibres ×2, protéines ×4. ⚠️ le centre affiche l'énergie **recalculée**, pas `kcal` de la base | Moyen | |
| R-10 | Coût total / par portion | Arrondi **ligne par ligne** au centime `ROUND_HALF_UP` puis somme ; compteur d'ingrédients sans prix | Faible | |
| R-11 | Poids de portion cuite | `cooked_weight_per_100g_raw`, défaut 1:1, indicateur « au moins un ratio défini » | Faible | |
| R-12 | Photo de recette | Upload fichier, drag d'URL http(s), EXIF transposé, `thumbnail(1024)` sans agrandissement, aplati sur blanc, JPEG q85, **une photo par recette** nommée `<recipe_id>.jpg` | Élevé | |
| R-13 | Tags de la recette | Toggle, **persistance immédiate** (hors buffer) | Faible | |
| R-14 | Journal de cuisson | Date, note 1–5 (0 = pas de note), notes libres ; compteur **30 jours glissants** (libellé UI « ce mois » trompeur) | Faible | |
| R-15 | Suppression + undo | Snapshot complet (lignes + tags), recréation avec **nouvel id** | Moyen | |
| R-16 | « Qu'est-ce que je peux cuisiner ? » | 3 sections : `ready` (couverture totale), `missing` (1..3 manquants), `shopping` (top 5 ingrédients débloquant le plus de recettes, calculé sur les recettes à **exactement 1 manquant**) | Moyen | |
| R-17 | Import de recette par URL | Assistant 3 étapes : fetch → extraction (recipe-scrapers puis repli JSON-LD) → résolution ligne par ligne → commit | Élevé | |
| R-18 | Parsing de quantités françaises | 30 alias d'unités, fractions `1/2`, mixtes `1 1/2`, articles `de la / d'`, préfixes « pièce(s) / paquet(s) / … ». **Défaut 100 g** si rien n'est extrait | Moyen | |

### 1.4 Onglet Calendrier

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| K-01 | Grille 7 jours × 5 créneaux | `morning, snack_morning, noon, snack_afternoon, evening` — ordre chronologique **reconstruit côté client** (le SQL trie alphabétiquement) | Moyen | |
| K-02 | Navigation par semaine ISO | Clé naturelle `'YYYY-Www'`, arithmétique ISO-8601 (semaine du premier jeudi) | Moyen | |
| K-03 | Ajout d'une entrée | XOR strict recette / ingrédient ; `portions` obligatoire côté recette, `quantity_g` côté ingrédient | Faible | |
| K-04 | Suppression + undo | Idem I-11 | Faible | |
| K-05 | Copier la semaine précédente | **Append**, pas de purge ; confirmation si la cible n'est pas vide | Faible | |
| K-06 | Templates de semaine | Snapshot JSON à 7 clés fixes, upsert par nom, application **append**, entrées malformées ignorées une par une | Moyen | |
| K-07 | Récap nutritionnel jour + semaine | Agrégation des entrées ; ratio recette = `portions / max(default_portions, 1)` | Moyen | |
| K-08 | Coût de la semaine | Recette : `recipe_cost × facteur` ; ingrédient : `ingredient_cost` ; arrondi à 2 décimales **à la fin** | Faible | |
| K-09 | Archivage automatique du coût | Écriture cachée dans le rafraîchissement (`weekly_cost_snapshot`), semaines vides non archivées | Moyen | |
| K-10 | Mini-graphe 12 dernières semaines | Barres cliquables, moyenne affichée dès 2 points | Faible | |
| K-11 | Panneau latéral de chips draggables | 100 ingrédients, dépôt = `pieceWeightG` ou 100 g | Moyen | 🖥 |

### 1.5 Onglet Liste de courses

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| S-01 | Agrégation par semaine ISO | Recettes développées et mises à l'échelle, ingrédients bruts cumulés, dégradation silencieuse (recette/ingrédient supprimé → sauté) | Moyen | |
| S-02 | Semaine indépendante du calendrier | Deux états distincts, à conserver | Faible | |
| S-03 | Regroupement par rayon + tri | Catégorisés d'abord, puis `category_l1.lower()`, puis `name.lower()` (tri **par points de code**, accents non normalisés) | Faible | |
| S-04 | Case « déjà au frigo » | Pré-cochée si `in_pantry_g >= quantity_g && quantity_g > 0`. **État volatile non persisté** | Faible | |
| S-05 | Coût total + compteur sans prix | Items sans prix exclus du total mais comptés | Faible | |
| S-06 | Affichage en pièces | `≈ N pièce(s)` si `piece_weight_g` connu | Faible | |
| S-07 | Export texte + presse-papiers | Format à chasse fixe : colonne de 40 caractères, `☐`, `—`, `·`, `≈`, `─`×30, virgule décimale, `capitalize()` Python | Moyen | |

### 1.6 Onglet Frigo / Cellier

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| P-01 | Liste des stocks | Plusieurs lots par ingrédient, tri `expiry NULL en dernier` | Faible | |
| P-02 | Seaux d'urgence | `soon ≤ 5 j`, `watch ≤ 14 j`, `stock` sinon ou sans date. Négatif = périmé (rouge) | Faible | |
| P-03 | Tri / groupement / filtre | `urgency, name, quantity, expiry, category` ; groupement `urgency / category / none` ; filtre texte **sans debounce** | Faible | |
| P-04 | Ajout / édition / suppression | `PATCH` sémantique « clé présente » ; confirmation à la suppression (asymétrie avec les autres écrans) | Faible | |
| P-05 | Ajout par glisser-déposer | Popup rapide qty + DLC, valeur par défaut = poids unitaire ou 100 g, `Entrée` valide | Moyen | 🖥 |
| P-06 | Couplage liste de courses | Après toute mutation, la liste de courses est rafraîchie (précochage) | Faible | |

### 1.7 Tickets de caisse

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| T-01 | Surveillance de `~/Downloads/Tickets de caisse/` | `watchdog`, `on_created` + `on_moved`, délai d'assainissement 250 ms, badge « N tickets en attente » | Élevé | 🖥 |
| T-02 | Détection d'enseigne | 500 premiers caractères du PDF en majuscules : `INTERMARCH` ou `FONTAINE-LES-DIJON` ; `CARREFOUR` → non supporté | Moyen | |
| T-03 | Parseur PDF Intermarché | `pdfplumber`, 4 regex (article, date, ticket id 18–24 chiffres, `MONTANT DU`). Pas d'OCR, pas de multi-quantité, pas de vrac | Élevé | |
| T-04 | Adaptateur JSON Lidl | Fonction pure, complétion croisée prix unitaire ↔ total, TVA `5.5→A / 20→B / 10→C` | Faible | |
| T-05 | Matcher 4 niveaux | `source_ref` (Lidl) → `alias` appris → `fuzzy` rapidfuzz `token_set_ratio` (seuils 70 suggérer / 90 pré-sélectionner, max 3) → `none` | Élevé | |
| T-06 | Détection de doublon | PK `imported_receipt.ticket_id`, bascule « Forcer » | Faible | |
| T-07 | UI de revue ligne à ligne | Tableau 7 colonnes (1 300 px), quantité en grammes, prix éditable (verrou `user_price_override`), DLC, EAN + lookup, choix d'ingrédient, retrait de ligne | Élevé | |
| T-08 | Masquage des non-alimentaires | Coché par défaut : `vat_code == "A"` ou `""` = alimentaire | Faible | |
| T-09 | Création d'ingrédient depuis une ligne | Pré-remplissage (nom, catégorie `Alimentaire` si TVA A ou Lidl, `sourceRef` = art_id Lidl) + **création d'alias** pour l'apprentissage | Moyen | |
| T-10 | Commit transactionnel | N `price_history` + recalcul du prix courant + M `pantry_stock` + N alias + 1 `imported_receipt` | Élevé | |
| T-11 | Cascade de résolution de la masse | `quantity_g` saisi > 0 → `price_quantity_g` → `piece_weight_g × qty_ticket` → **1000 g** | Faible | |
| T-12 | Suppression du fichier source | Uniquement si le fichier est dans le dossier surveillé | Faible | 🖥 |

### 1.8 Lidl Plus

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| L-01 | Stockage du refresh token | Windows Credential Manager via `keyring` ; **aucun secret en base** | Élevé | 🖥 |
| L-02 | Obtention du token | **Non implémentée dans le dépôt** : commande CLI externe `python -m lidlplus … auth` + 2FA email, token collé à la main | Élevé | 🖥 |
| L-03 | Récupération des tickets | Lib PyPI `lidl-plus` (boîte noire : aucune URL, aucun `client_id`, aucun scope dans le dépôt) | Élevé | 🖥 |
| L-04 | Polling périodique | `QTimer`, intervalle ≥ 5 min (défaut 60), première sync à +15 s, garde anti-concurrence | Moyen | 🖥 |
| L-05 | File de tickets en attente | En mémoire, badge dans la barre de statut | Faible | |
| L-06 | Réglages persistés | `lidl_plus_settings` singleton (`enabled`, `poll_interval_minutes`, `last_fetched_at`, `last_error` tronqué à 500 car.) | Faible | |

### 1.9 Transverse

| # | Fonctionnalité | Détail | Effort | 🖥 |
|---|---|---|---|---|
| X-01 | Rayons / catégories | Table `category_definition` auto-référencée ; en UI, **liste plate L1 uniquement** ; renommage cascade sur `ingredient.category_l1` **par MATCH global sur le nom** | Moyen | |
| X-02 | Tags | 10 tags semés, **lecture seule** (aucune création/édition exposée) | Faible | |
| X-03 | Recherche unifiée Ctrl+K | 3 sections (ingrédients perso 12, recettes 12, calendrier semaine courante 12), navigation clavier | Moyen | |
| X-04 | Mode sombre | Singleton `Theme`, tous les jetons dérivés d'un booléen | Faible | |
| X-05 | Raccourcis clavier | Ctrl+1..5, Ctrl+K, Ctrl+/, Ctrl+N/S/F, Suppr, Ctrl+←/→/T, Ctrl+Shift+D | Moyen | 🖥 |
| X-06 | Sauvegardes SQLite + restauration | `sqlite3.backup()` au démarrage, rotation 7 jours + 1/mois pendant 6 mois, restauration avec sauvegarde de sécurité | Élevé | 🖥 |
| X-07 | Barre de statut | Badges tickets/Lidl + pastille réseau | Faible | 🖥 |
| X-08 | Dossier de logs | `Qt.openUrlExternally` | — | 🖥 (abandon) |
| X-09 | Sélecteur de date maison | Grille 6×7 lundi-first, « Aujourd'hui », navigation PageUp/PageDown | Faible | |
| X-10 | Dialogues détachables (13 fenêtres système) | Non modaux, déplaçables hors de l'app | Élevé | 🖥 (abandon) |

### 1.10 Récapitulatif des abandons assumés

| Fonctionnalité | Raison | Remplacement |
|---|---|---|
| Surveillance de dossier (T-01) | Aucune API navigateur | Téléversement explicite + Web Share Target (Android) |
| Sauvegarde / restauration locale (X-06) | Fichier SQLite local | D1 Time Travel + export JSON/SQL |
| Dossier de logs (X-08) | Système de fichiers | Page de diagnostic |
| Fenêtres détachables (X-10) | Multi-fenêtrage | Modales / routes plein écran |
| Barre de menus native | Alt-mnémoniques | Menu `⋯` + page Réglages |
| Glisser-déposer souris (I-16, K-11, P-05) | Tactile fragile | Menu de ligne « Ajouter au frigo / au calendrier » |
| Raccourcis Ctrl+N/S/T/F/1-5 | Réservés par le navigateur | `Ctrl+K`, `/`, `Ctrl+Entrée`, touches nues hors champ de saisie |

---

## 2. Schéma de base cible pour Cloudflare D1

### 2.1 Ce qui passe tel quel

- Toutes les tables : D1 est du SQLite complet. `INTEGER PRIMARY KEY` = alias de `rowid`.
- Les clés étrangères et les `ON DELETE CASCADE` / `RESTRICT` : **D1 applique les FK par défaut**,
  le hook `PRAGMA foreign_keys = ON` de `db.py` disparaît (ne pas le porter).
- Les index (hors les 4 redondants, cf. 2.2).
- Les triggers FTS5.
- Le SQL brut de la recherche (`_search_page`) — **à une exception près** : D1 n'accepte que des
  paramètres positionnels `?`, pas les `:nom` de SQLAlchemy. Convertir en conservant l'ordre de
  construction des clauses.

### 2.2 Ce qui doit changer

| # | Problème dans SQLite local | Correction en D1 |
|---|---|---|
| 1 | ~12 colonnes `NOT NULL` **sans `DEFAULT`** dans le DDL (les défauts vivaient dans l'ORM) | Ajouter les `DEFAULT` en SQL — sans quoi tout `INSERT` partiel échoue |
| 2 | `updated_at` géré par `onupdate` **côté client** SQLAlchemy | Poser `updated_at` dans chaque `UPDATE`, ou un trigger `AFTER UPDATE` |
| 3 | Fuseaux mélangés : `CURRENT_TIMESTAMP` = UTC sans microsecondes ; `datetime.now()` = **local** avec microsecondes ; `WeeklyCostRepo` = UTC naïf | **Tout normaliser en ISO-8601 UTC** (`YYYY-MM-DDTHH:MM:SSZ`) au moment de la migration |
| 4 | `NUMERIC(10,4)` stocke en `REAL`/`INTEGER` (valeur `12` de type `integer` observée) | `TEXT` décimal (ex. `"3.9900"`) + `decimal.js` côté Worker. Alternative : entiers en micro-euros |
| 5 | `slot VARCHAR(10)` trop court pour `'snack_afternoon'` (15 car.) | `TEXT` + `CHECK (slot IN (…))` |
| 6 | `UNIQUE (parent_id, name)` sur `category_definition` **ne contraint pas les L1** (NULL distincts) | `UNIQUE (COALESCE(parent_id, -1), name)` |
| 7 | 4 index redondants (`index=True` + `Index(...)`) | Ne pas les recréer |
| 8 | Toutes les règles métier vivent dans Pydantic, **rien en base** (seul le XOR est un vrai `CHECK`) | Ajouter les `CHECK` évidents en D1 **et** revalider côté Worker (Zod) |
| 9 | Recherche par nom insensible à la casse faite **en Python** (chargement de toute une source en mémoire) | Colonne `name_normalized` (minuscule + NFD sans diacritiques) + index |
| 10 | `recipe.image_path` = nom de fichier local | Clé d'objet R2 |
| 11 | 8 migrations inline + 3 seeders rejoués **à chaque démarrage** dans une transaction unique | `wrangler d1 migrations` : un fichier par étape, exécutées une fois |
| 12 | Aucun versionnage (`PRAGMA user_version = 0`) | Table de migrations de `wrangler` |

### 2.3 DDL cible

```sql
-- ============================================================
-- 0001_core.sql
-- ============================================================

PRAGMA foreign_keys = ON;   -- no-op sur D1 (déjà actif), conservé pour l'exécution locale

-- ---------- ingredient ----------
CREATE TABLE ingredient (
  id                          INTEGER PRIMARY KEY,
  name                        TEXT    NOT NULL,
  -- NOUVEAU : minuscules + NFD sans diacritiques, maintenu par le Worker.
  -- Remplace le find_by_name() qui chargeait toute une source en mémoire.
  name_normalized             TEXT    NOT NULL DEFAULT '',
  source                      TEXT    NOT NULL DEFAULT 'manual'
                                CHECK (source IN ('ciqual','openfoodfacts','manual','lidl')),
  source_ref                  TEXT,
  brand                       TEXT,
  kcal_per_100g               REAL    CHECK (kcal_per_100g       IS NULL OR kcal_per_100g       >= 0),
  proteins_g                  REAL    CHECK (proteins_g          IS NULL OR proteins_g          >= 0),
  carbs_g                     REAL    CHECK (carbs_g             IS NULL OR carbs_g             >= 0),
  sugars_g                    REAL    CHECK (sugars_g            IS NULL OR sugars_g            >= 0),
  fats_g                      REAL    CHECK (fats_g              IS NULL OR fats_g              >= 0),
  saturated_fats_g            REAL    CHECK (saturated_fats_g    IS NULL OR saturated_fats_g    >= 0),
  fiber_g                     REAL    CHECK (fiber_g             IS NULL OR fiber_g             >= 0),
  salt_g                      REAL    CHECK (salt_g              IS NULL OR salt_g              >= 0),
  -- Argent : chaîne décimale, JAMAIS un REAL. Précision d'origine : 4 décimales.
  price_eur                   TEXT    CHECK (price_eur IS NULL OR CAST(price_eur AS REAL) > 0),
  price_quantity_g            REAL    CHECK (price_quantity_g            IS NULL OR price_quantity_g            > 0),
  piece_weight_g              REAL    CHECK (piece_weight_g              IS NULL OR piece_weight_g              > 0),
  cooked_weight_per_100g_raw  REAL    CHECK (cooked_weight_per_100g_raw  IS NULL OR cooked_weight_per_100g_raw  > 0),
  in_personal_library         INTEGER NOT NULL DEFAULT 0 CHECK (in_personal_library IN (0,1)),
  category_l1                 TEXT,
  category_l2                 TEXT,
  season_months               TEXT,          -- CSV de mois 1..12, ex. '6,7,8,9'
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- NULL distincts en SQLite → tous les 'manual' (source_ref NULL) cohabitent. Comportement conservé.
CREATE UNIQUE INDEX ix_ingredient_source_ref ON ingredient (source, source_ref);
CREATE INDEX ix_ingredient_personal          ON ingredient (in_personal_library, name);
CREATE INDEX ix_ingredient_name_normalized   ON ingredient (name_normalized);
CREATE INDEX ix_ingredient_category_l1       ON ingredient (category_l1);

-- ---------- tag ----------
CREATE TABLE tag (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color_hex  TEXT NOT NULL DEFAULT '#9ca3af'
               CHECK (color_hex GLOB '#[0-9a-fA-F]*' AND length(color_hex) IN (7,9)),  -- NOUVEAU
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------- recipe ----------
CREATE TABLE recipe (
  id               INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  instructions     TEXT    NOT NULL DEFAULT '',
  default_portions INTEGER NOT NULL DEFAULT 1 CHECK (default_portions >= 1),
  image_key        TEXT,        -- RENOMMÉ depuis image_path : clé R2 'recipes/<id>.jpg'
  source_url       TEXT,        -- NOUVEAU (voir §2.5)
  prep_time_min    INTEGER,     -- NOUVEAU (voir §2.5)
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE recipe_ingredient (
  recipe_id     INTEGER NOT NULL REFERENCES recipe (id)     ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredient (id) ON DELETE RESTRICT,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  quantity_g    REAL    NOT NULL CHECK (quantity_g > 0),
  notes         TEXT,
  unit          TEXT,   -- g|kg|mg|ml|cl|dl|L|c_cafe|c_soupe|tasse|pincee|_piece — cosmétique
  PRIMARY KEY (recipe_id, ingredient_id, ordinal)
);

CREATE TABLE recipe_tag (
  recipe_id INTEGER NOT NULL REFERENCES recipe (id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tag (id)    ON DELETE CASCADE,
  PRIMARY KEY (recipe_id, tag_id)
);
CREATE INDEX ix_recipe_tag_tag ON recipe_tag (tag_id);

-- ---------- meal_plan ----------
CREATE TABLE meal_plan_entry (
  id            INTEGER PRIMARY KEY,
  iso_week      TEXT    NOT NULL CHECK (iso_week GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]'),
  day_of_week   INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = lundi
  slot          TEXT    NOT NULL
                  CHECK (slot IN ('morning','snack_morning','noon','snack_afternoon','evening')),
  recipe_id     INTEGER REFERENCES recipe (id)     ON DELETE CASCADE,
  ingredient_id INTEGER REFERENCES ingredient (id) ON DELETE CASCADE,
  quantity_g    REAL    CHECK (quantity_g IS NULL OR quantity_g > 0),
  portions      REAL    CHECK (portions   IS NULL OR portions   > 0),   -- float : 0.5 portion permis
  ordinal       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT ck_meal_plan_entry_xor CHECK (
      (recipe_id IS NOT NULL AND ingredient_id IS NULL AND portions   IS NOT NULL) OR
      (recipe_id IS NULL AND ingredient_id IS NOT NULL AND quantity_g IS NOT NULL))
);
CREATE INDEX ix_meal_plan_week ON meal_plan_entry (iso_week, day_of_week, slot, ordinal);

CREATE TABLE meal_plan_template (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  snapshot_json TEXT NOT NULL,   -- tableau d'objets à 7 clés fixes (cf. §4.4)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE weekly_cost_snapshot (
  iso_week      TEXT    PRIMARY KEY,
  total_eur     TEXT    NOT NULL DEFAULT '0.00',
  missing_count INTEGER NOT NULL DEFAULT 0,
  captured_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------- pantry / prix / cuisson ----------
CREATE TABLE pantry_stock (
  id            INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredient (id) ON DELETE CASCADE,
  quantity_g    REAL    NOT NULL CHECK (quantity_g > 0),
  expiry_date   TEXT,                       -- 'YYYY-MM-DD' (jour, pas d'heure)
  notes         TEXT,
  added_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX ix_pantry_stock_expiry     ON pantry_stock (expiry_date);
CREATE INDEX ix_pantry_stock_ingredient ON pantry_stock (ingredient_id);

CREATE TABLE ingredient_price_history (
  id            INTEGER PRIMARY KEY,
  ingredient_id INTEGER NOT NULL REFERENCES ingredient (id) ON DELETE CASCADE,
  price_eur     TEXT    NOT NULL CHECK (CAST(price_eur AS REAL) > 0),
  quantity_g    REAL    NOT NULL CHECK (quantity_g > 0),
  store         TEXT,
  recorded_at   TEXT    NOT NULL,
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX ix_price_history_ingredient_date ON ingredient_price_history (ingredient_id, recorded_at, id);

CREATE TABLE recipe_cooking_log (
  id         INTEGER PRIMARY KEY,
  recipe_id  INTEGER NOT NULL REFERENCES recipe (id) ON DELETE CASCADE,
  cooked_at  TEXT    NOT NULL,
  rating     INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  notes      TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX ix_cooking_log_recipe_date ON recipe_cooking_log (recipe_id, cooked_at);

-- ---------- tickets ----------
CREATE TABLE imported_receipt (
  ticket_id   TEXT    PRIMARY KEY,
  store       TEXT    NOT NULL CHECK (store IN ('intermarche','lidl','carrefour')),
  imported_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  receipt_date TEXT,
  total_eur   TEXT,
  line_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE receipt_alias (
  id            INTEGER PRIMARY KEY,
  store         TEXT    NOT NULL,
  source_key    TEXT    NOT NULL,   -- casefold + espaces collapsés (Intermarché) ; art_id (Lidl)
  ingredient_id INTEGER NOT NULL REFERENCES ingredient (id) ON DELETE CASCADE,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX ix_receipt_alias_store_key ON receipt_alias (store, source_key);

-- NOUVEAU : remplace le dossier surveillé. Une ligne par ticket téléversé.
CREATE TABLE receipt_upload (
  id           INTEGER PRIMARY KEY,
  r2_key       TEXT    NOT NULL,
  filename     TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  byte_size    INTEGER NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','parsed','committed','failed','discarded')),
  store        TEXT,
  ticket_id    TEXT,
  parse_error  TEXT,
  uploaded_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX ix_receipt_upload_status ON receipt_upload (status, uploaded_at);

-- ---------- catégories ----------
CREATE TABLE category_definition (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES category_definition (id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- CORRECTION : COALESCE rend l'unicité effective au niveau racine.
CREATE UNIQUE INDEX ix_category_unique_in_parent
  ON category_definition (COALESCE(parent_id, -1), name);

-- ---------- réglages ----------
CREATE TABLE app_setting (          -- REMPLACE lidl_plus_settings, généralisé
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- clés attendues : 'lidl_plus' -> {enabled, pollIntervalMinutes, lastFetchedAt, lastError}
--                  'view_options.ingredients' (si l'on veut la synchro multi-appareil)
```

### 2.4 Le sort de FTS5

**Décision : conserver FTS5.** D1 est du SQLite complet et la table virtuelle, les triggers et le
tokenizer `unicode61 remove_diacritics 2` sont des fonctionnalités intégrées, sans extension externe.
C'est le point à **valider en premier** sur un environnement D1 réel (cf. §6, risque #1).

```sql
-- ============================================================
-- 0002_fts.sql — À EXÉCUTER APRÈS LE CHARGEMENT DES DONNÉES
-- ============================================================
CREATE VIRTUAL TABLE ingredient_fts USING fts5(
    name,
    content='ingredient',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER ingredient_ai AFTER INSERT ON ingredient BEGIN
  INSERT INTO ingredient_fts(rowid, name) VALUES (new.id, new.name);
END;
CREATE TRIGGER ingredient_ad AFTER DELETE ON ingredient BEGIN
  INSERT INTO ingredient_fts(ingredient_fts, rowid, name) VALUES('delete', old.id, old.name);
END;
CREATE TRIGGER ingredient_au AFTER UPDATE ON ingredient BEGIN
  INSERT INTO ingredient_fts(ingredient_fts, rowid, name) VALUES('delete', old.id, old.name);
  INSERT INTO ingredient_fts(rowid, name) VALUES (new.id, new.name);
END;

-- OBLIGATOIRE après un chargement de masse : le code Python ne l'appelle JAMAIS,
-- son index n'est alimenté que par les triggers. Sans ce rebuild, toute recherche
-- renverrait 0 résultat sur les 4 177 lignes migrées.
INSERT INTO ingredient_fts(ingredient_fts) VALUES('rebuild');
```

**Séquence de migration obligatoire** : créer `ingredient` → insérer les données → créer
`ingredient_fts` + les 3 triggers → `rebuild`.

**Plan B, à concevoir dès le départ** (pas après) si FTS5 s'avère indisponible ou instable :
- colonne `name_normalized` (déjà au schéma) : `s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'')` ;
- recherche `name_normalized LIKE 'tok%'` par token, `AND` entre tokens ;
- on perd le classement `rank` → repli `ORDER BY name`, qui est **déjà** le comportement du code
  Python quand la requête est vide. Sur 4 177 lignes, l'écart de performance est nul.

**Correctif de robustesse à intégrer** : un guillemet double dans la requête utilisateur
(`to"mate`) casse la syntaxe FTS5 et produit aujourd'hui une **erreur SQL non rattrapée**.
Échapper : `token.replace(/"/g, '""')` avant d'entourer de guillemets et de suffixer `*`.

### 2.5 Champs ajoutés / renommés — arbitrages à valider

| Champ | Décision proposée | Justification |
|---|---|---|
| `recipe.image_path` → `image_key` | Renommer, valeurs existantes **abandonnées** | Chemin local sans sens ; 6 recettes seulement, photos à re-téléverser |
| `recipe.prep_time_min` | **Ajouter** | `ExtractedRecipe.prep_time_min` est extrait des pages web et exposé par le VM, mais n'a nulle part où atterrir : l'information est perdue au commit |
| `recipe.source_url` | **Ajouter** | Même constat ; utile pour « revoir la recette d'origine » |
| `ingredient.name_normalized` | **Ajouter** | Supprime l'anti-pattern « charger toute une source en mémoire pour comparer en Python » |
| `receipt_upload` | **Ajouter** | Remplace le dossier surveillé par une file serveur |
| `lidl_plus_settings` → `app_setting` | Généraliser | Une seule table clé/valeur JSON pour les réglages ; **jamais de secret dedans** |
| `ingredient.category_l1/l2` | **Rester en TEXT libre** (pas de FK) | Rétrocompatibilité CIQUAL et imports OFF. Voir l'arbitrage §6 |
| `recipe_ingredient.ordinal` | Corriger `ordinal = line.ordinal or idx` | Le `or` traite `0` comme faux : une ligne à `ordinal = 0` en 4ᵉ position est réécrite en `3`. Utiliser `??` |

### 2.6 Seeds à rejouer

1. **10 tags par défaut** (`INSERT OR IGNORE` par nom) :
   `entrée #fbbf24`, `plat principal #3b82f6`, `dessert #ec4899`, `petit-déjeuner #fb923c`,
   `batch-cooking #14b8a6`, `végétarien #22c55e`, `végan #16a34a`, `sans gluten #a855f7`,
   `rapide #ef4444`, `du placard #78716c`.
2. **Saisonnalité** : 56 préfixes → CSV de mois, appliqué **uniquement** si `season_months IS NULL`.
   **Deux bugs à corriger au portage** :
   - le `lower()` de SQLite est ASCII-only : `'épinard%'` ne matche aucun des 6 `'Épinard%'` réels.
     → faire le pliage applicatif via `name_normalized` ;
   - le résultat dépend de l'**ordre de déclaration du dict** (`pomme de terre` avant `pomme` par
     chance). → trier explicitement les motifs **du plus long au plus court**.
3. **Catégories dérivées** des valeurs distinctes de `ingredient.category_l1/l2`, tous les
   `ordinal` à 0 (donc affichage alphabétique initial).

---

## 3. Surface d'API REST du Worker

Conventions générales :

- JSON en entrée et en sortie ; `Content-Type: application/json` sauf téléversements (`multipart/form-data`).
- **Montants sérialisés en `string`** (`"12.0000"`, `"3.50"`) — jamais en `number`.
- Dates en ISO-8601. Les dates « jour » (`expiry_date`, `recorded_at` saisi) restent des
  `YYYY-MM-DD` sans heure ; les horodatages système sont en UTC suffixés `Z`.
- Semaines ISO en paramètre de chemin : `2026-W18` (regex stricte `^\d{4}-W\d{2}$`).
- Listes paginées : `{ items, totalCount, page, pageSize, pageCount }` avec
  `pageCount = ceil(totalCount / pageSize)`, `1` si `pageSize <= 0` ou `totalCount <= 0`.
- Erreurs : `{ error: { code, message } }`, `message` **en français** (les messages existants sont
  destinés à l'utilisateur et doivent être conservés mot pour mot — cf. §4.2).
- Codes : `400` validation, `401` non authentifié, `404` introuvable, `409` conflit
  (collision de nom, ticket déjà importé, ingrédient utilisé par une recette), `502` erreur amont
  (OFF, site de recette), `504` timeout amont.

### 3.1 Ingrédients — bibliothèque personnelle

| Méthode | Chemin | Charge utile | Réponse | Remplace |
|---|---|---|---|---|
| `GET` | `/api/ingredients` | query : `q`, `sort`, `group`, `sources` (csv), `rayons` (csv), `inSeason`, `withBrand`, `withPieceWeight`, `withPrice`, `kcalMin/Max`, `proteinsMin/Max`, `carbsMin/Max`, `fatsMin/Max`, `fiberMin/Max`, `saltMin/Max`, `page`, `pageSize` | `{ items: Ingredient[], totalCount, page, pageSize, pageCount, activeFilterCount }` | `setFilter`, `refreshList`, `setSortBy`, `setGroupBy`, 6× `setFilter*`, `setMacroRange`, `resetFilters`, property `items` |
| `GET` | `/api/ingredients/:id` | — | `Ingredient` | `getAsDict` |
| `POST` | `/api/ingredients` | `Ingredient` sans `id` | `201 Ingredient` · `409 { error, existingId, name }` en cas de collision de nom manuel | `saveFromDict` (création) + `name_collision_detected` |
| `PATCH` | `/api/ingredients/:id` | champs à modifier ; **sémantique « clé présente »** pour `brand`, `categoryL1`, `categoryL2`, `seasonMonths` | `Ingredient` | `saveFromDict` (mise à jour) |
| `DELETE` | `/api/ingredients/:id` | — | `{ mode: "hard" \| "unflagged", undo: Ingredient }` · `409` si utilisé dans une recette | `deleteIngredient` |
| `POST` | `/api/ingredients/:id/library` | `{ value: boolean }` | `Ingredient` | `importExisting` |
| `POST` | `/api/ingredients/library-batch` | `{ ids: number[], value: boolean }` | `{ promoted: number }` | `importMany` |
| `GET` | `/api/ingredients/resolve` | query : `q`, `limit` (défaut 5) | `Ingredient[]` classés (exact → perso → tous, re-classés par similarité) | `resolve_ingredient_name`, `setLineParsedName`, `searchCandidatesForLine` |
| `GET` | `/api/ingredients/categories` | query : `source?` | `string[]` — valeurs distinctes de `category_l1` | `categoriesL1` |

**`Ingredient` (contrat de sérialisation, dérivé de `_ing_to_dict`)** :

```jsonc
{
  "id": 42, "name": "Carotte", "source": "ciqual", "sourceRef": "20055",
  "brand": null,                       // null, pas "" (le desktop est incohérent : "" côté dict, null côté modèle)
  "kcal": 41.0, "proteins": 0.8, "carbs": 6.7, "sugars": 5.2,
  "fats": 0.2, "saturatedFats": 0.05, "fiber": 2.8, "salt": 0.06,   // /100 g, null = inconnu ≠ 0
  "priceEur": "1.2000",                // string décimale ou null
  "priceQuantityG": 1000.0, "pieceWeightG": null, "cookedWeightPer100gRaw": null,
  "inLibrary": true, "categoryL1": "Fruits et légumes", "categoryL2": null,
  "seasonMonths": "1,2,3,4,5,6,7,8,9,10,11,12",
  "createdAt": "2026-05-02T10:16:37Z", "updatedAt": "2026-05-02T10:16:37Z"
}
```

`hasSeasonality`, `inSeasonNow`, `sourceLabel`, `seasonStatus`, `kcalRange`, `rayon`, `groupKey`
sont des **dérivés à calculer côté client** — `inSeasonNow` dépend du mois **local** de l'utilisateur.

### 3.2 Catalogue & OpenFoodFacts (proxy)

| Méthode | Chemin | Charge utile | Réponse | Remplace |
|---|---|---|---|---|
| `GET` | `/api/catalog/search` | query : `source` (`ciqual\|openfoodfacts`), `scope` (`all\|personal`), `q`, `categoryL1`, `minKcal/maxKcal/minProteins/maxProteins/minCarbs/maxCarbs/minFats/maxFats`, `sortBy` (`rank\|name\|kcal\|proteins\|carbs\|fats`), `sortDesc`, `page`, `pageSize` (défaut 25) | `{ items, totalCount, page, pageSize, pageCount }` | `searchCatalogPaged` + `searchBySource` + `searchOnce` **fusionnés** |
| `GET` | `/api/off/search` | query : `q`, `page`, `pageSize`, `sortBy`, filtres macro, `categoryTag` | `{ items: Ingredient[], totalCount, sortApplied: boolean }` — **effet de bord : mise en cache locale des résultats** | `fetchOnline` + `fetchOnlineAndList` **fusionnés** |
| `GET` | `/api/off/barcode/:ean` | — | `Ingredient` · `404` si introuvable · `400` si l'EAN n'est pas exclusivement numérique | `lookupBarcodeAsDict` + étape 2 de `lookupBarcodeAndAssign` |
| `GET` | `/api/off/status` | — | `{ online: boolean, checkedAt }` (valeur en cache KV, rafraîchie par cron) | `networkVM.online` |

Contraintes de fidélité pour `/api/off/search` :
- court-circuit **sans appel réseau** si la requête est vide **et** qu'aucun filtre effectif n'est
  posé (⚠️ le code actuel a deux tests incohérents qui laissent passer `*:*` — cf. §6) ;
- requête Lucene construite dans cet ordre : texte, `nutriments.energy-kcal_100g`,
  `nutriments.proteins_100g`, `nutriments.carbohydrates_100g`, `nutriments.fat_100g`,
  `categories_tags:"…"` ; jointure par `" AND "` ; repli `"*:*"` ;
- `sortBy` : seuls `name_asc → product_name` et `name_desc → -product_name` sont transmis. Les 8
  tris macro sont **omis** (l'API renvoie 400 sur `nutriments.*`) → renvoyer `sortApplied: false`
  pour que le front affiche l'avertissement « tri page-local ».

### 3.3 Historique de prix

| Méthode | Chemin | Charge utile | Réponse |
|---|---|---|---|
| `GET` | `/api/ingredients/:id/prices` | — | `PriceEntry[]` triés `recorded_at ASC, id ASC`, chacun avec `pricePer100g` précalculé (`price_eur × 100 / quantity_g`, **sans arrondi**) |
| `POST` | `/api/ingredients/:id/prices` | `{ priceEur, quantityG, store?, recordedAt, notes? }` | `{ entry, ingredient }` — **le prix courant de l'ingrédient est recalculé dans la même transaction** |
| `DELETE` | `/api/prices/:entryId` | — | `{ ingredient }` — recalcul, ou remise à `null` s'il ne reste aucune observation |
| `GET` | `/api/stores` | — | `string[]` — enseignes distinctes non vides, triées |

Règle métier centrale : `ingredient.price_eur` / `price_quantity_g` sont un **cache dénormalisé de
la dernière observation** (`ORDER BY recorded_at DESC, id DESC LIMIT 1`), recalculé **exactement une
fois** par ajout/suppression. Les prix saisis avant l'existence de l'historique restent intacts tant
qu'aucune observation n'est ajoutée.

### 3.4 Recettes

| Méthode | Chemin | Charge utile | Réponse |
|---|---|---|---|
| `GET` | `/api/recipes` | query : `tags` (csv, sémantique **OU**), `q` | `RecipeSummary[]` (`id, name, defaultPortions, lineCount, instructionsHead, photoUrl`) |
| `GET` | `/api/recipes/:id` | — | `Recipe` complète : lignes **hydratées** avec l'objet ingrédient entier, tags, `photoUrl` |
| `POST` | `/api/recipes` | `Recipe` sans `id` | `201 Recipe` |
| `PUT` | `/api/recipes/:id` | `Recipe` complète (remplacement des lignes et des tags) | `Recipe` |
| `DELETE` | `/api/recipes/:id` | — | `{ undo: Recipe }` (snapshot complet pour l'annulation) |
| `PUT` | `/api/recipes/:id/tags` | `{ tagIds: number[] }` | `Tag[]` |
| `PUT` | `/api/recipes/:id/photo` | `multipart/form-data` (fichier déjà redimensionné côté client) | `{ photoUrl }` |
| `POST` | `/api/recipes/:id/photo-from-url` | `{ url }` | `{ photoUrl }` — garde-fou 20 Mo **en streaming**, timeout 15 s |
| `DELETE` | `/api/recipes/:id/photo` | — | `204` |
| `GET` | `/api/recipes/:id/cooking-log` | — | `{ entries: CookingLogEntry[], last30DaysCount }` |
| `POST` | `/api/recipes/:id/cooking-log` | `{ cookedAt?, rating?, notes? }` (`cookedAt` vide → maintenant ; `rating` 0/absent → `null`) | `201 CookingLogEntry` |
| `DELETE` | `/api/cooking-log/:entryId` | — | `204` |
| `POST` | `/api/recipes/suggest` | `{ ingredientIds: number[], maxMissing: 3 }` | `{ ready[], missing[], shopping[] }` |

**`RecipeLine` embarque l'objet `Ingredient` complet**, pas un id — les fonctions de nutrition et de
coût en dépendent. L'API doit hydrater avant tout calcul.

**Tout le buffer d'édition reste côté client** : `updateMeta`, `addLineById`, `removeLineByOrdinal`,
`updateLineQty`, `updateLineNotes`, `updateLineUnit`, `hasUnsavedChanges`, et **tout le scaling de
portions** (`displayPortions`, `isScaled`, `scaleRatio`). Un seul `PUT` à l'enregistrement.

**Les 5 slots de dérivés** (`nutritionTotal`, `nutritionPerPortion`, `nutritionPer100g`, `costInfo`,
`portionWeight`) **ne deviennent pas des endpoints** : les formules sont pures et les données sont
déjà dans la réponse de `GET /api/recipes/:id`. Calcul client → 0 requête, réactivité immédiate au
scaling.

### 3.5 Calendrier

| Méthode | Chemin | Charge utile | Réponse |
|---|---|---|---|
| `GET` | `/api/calendar/:week` | — | `{ isoWeek, days: Day[7], entries: MealPlanEntry[] }` — entrées avec `description` pré-résolue et triées **chronologiquement** par créneau (`CASE` explicite, pas l'ordre alphabétique) |
| `POST` | `/api/calendar/:week/entries` | `{ dayOfWeek, slot, recipeId?, portions?, ingredientId?, quantityG? }` (XOR) | `201 MealPlanEntry` |
| `DELETE` | `/api/calendar/entries/:id` | — | `{ undo: MealPlanEntry }` |
| `POST` | `/api/calendar/:week/copy-previous` | — | `{ copied: number }` — **append**, no-op si `src == dst` |
| `GET` | `/api/calendar/:week/totals` | — | `{ week: NutritionTotal, days: NutritionTotal[7], cost: { total: string, missingPriceCount } }` |
| `POST` | `/api/calendar/:week/snapshot` | — | `WeeklyCostSnapshot` — **rend explicite l'écriture aujourd'hui cachée dans le rafraîchissement** |
| `GET` | `/api/calendar/cost-history` | query : `weeks` (défaut 12) | `WeeklyCostSnapshot[]` du plus ancien au plus récent |
| `GET` | `/api/meal-templates` | — | `{ id, name, entryCount }[]` triés par nom |
| `POST` | `/api/meal-templates` | `{ name, sourceWeek }` | `{ id, name, entryCount }` — **upsert par nom** ; nom vide → `400` |
| `POST` | `/api/meal-templates/:id/apply` | `{ week }` | `{ applied: number }` — **append**, entrées malformées ignorées une par une |
| `DELETE` | `/api/meal-templates/:id` | — | `204` |

`shiftWeek`, `currentWeekEntryCount` et la recherche Ctrl+K dans le calendrier sont **purement
client** (arithmétique ISO + filtrage des entrées déjà chargées).

### 3.6 Liste de courses

| Méthode | Chemin | Réponse |
|---|---|---|
| `GET` | `/api/shopping/:week` | `{ isoWeek, items: ShoppingItem[], totalEur: string, missingPriceCount, itemCount }` — chaque item porte `pieceCount`, `hasPrice`, `inPantryG`, `isCoveredByPantry` |
| `GET` | `/api/shopping/:week/text` | `text/plain` — rendu exact de `format_as_text` |
| `PUT` | `/api/shopping/:week/checked` | `{ ingredientIds: number[] }` → `204` — **NOUVEAU** : persiste les cases cochées (aujourd'hui volatiles) |

`setInFridge` reste client, mais **il est recommandé de persister** (voir §5.5 : c'est l'écran
utilisé en magasin, un rafraîchissement efface tout le travail aujourd'hui).

### 3.7 Frigo / cellier

| Méthode | Chemin | Charge utile | Réponse |
|---|---|---|---|
| `GET` | `/api/pantry` | — | `PantryRow[]` — jointure ingrédient dénormalisée (`name`, `source`, `categoryL1`, `pieceWeightG`) |
| `POST` | `/api/pantry` | `{ ingredientId, quantityG, expiryDate?, notes? }` | `201 PantryRow` |
| `PATCH` | `/api/pantry/:id` | champs à modifier — sémantique « clé présente » ; `ingredientId` **jamais modifiable** | `PantryRow` |
| `DELETE` | `/api/pantry/:id` | — | `204` |

`daysUntilExpiry` et `urgencyBucket` (`soon ≤ 5`, `watch ≤ 14`, `stock` sinon ou sans date)
dépendent de la **date locale** → calculés côté client. Tri / groupement / filtre également (le
stock est petit).

### 3.8 Tickets de caisse

| Méthode | Chemin | Charge utile | Réponse |
|---|---|---|---|
| `POST` | `/api/receipts/upload` | `multipart` (PDF) **ou** `{ text }` (texte déjà extrait côté navigateur — recommandé) | `{ uploadId, store, ticketId, receiptDate, totalEur, lineCount, isDuplicate, lines: MatchedLine[] }` — **aucune écriture métier** |
| `POST` | `/api/receipts/parse-lidl-json` | JSON brut du ticket Lidl | idem |
| `GET` | `/api/receipts/pending` | — | `receipt_upload[]` en `status = 'pending'` (remplace le badge du watcher) |
| `DELETE` | `/api/receipts/pending/:uploadId` | — | `204` (statut `discarded`, objet R2 purgé) |
| `POST` | `/api/ingredients/from-receipt-line` | `{ store, storeKey, name, sourceRef?, categoryL1?, categoryL2?, pieceWeightG?, priceQuantityG? }` | `201 Ingredient` — **crée aussi l'alias d'apprentissage** si `store != 'lidl'`. Un `POST /api/ingredients` classique ne suffit pas |
| `POST` | `/api/receipts/commit` | Le ticket complet corrigé : `{ uploadId?, store, ticketId, receiptDate, totalEur, forceImport, lines: [{ chosenIngredientId, storeKey, rawName, quantity, unitPrice, quantityG, addToPantry, expiryDate }] }` | `{ success, message, priceCount, pantryCount }` · `409` si doublon et `forceImport` faux |
| `GET` | `/api/receipts/history` | query : `limit` (défaut 20) | `imported_receipt[]` triés `imported_at DESC` |

**Tout le buffer de revue est client** : `setLineChosenIngredient`, `toggleLineAddToPantry`,
`removeLine`, `setLineQuantity`, `setLineQuantityG`, `setLineTotalPrice`, `setLineBarcode`,
`setLineExpiry`, `setForceImport`, `suggestCreatePayload`, `reset`.

**`/api/receipts/commit` doit être atomique.** Effets, par ligne retenue (ignorée si
`chosenIngredientId` absent ou `unitPrice <= 0`) :
1. `price_history` : `price_eur = unitPrice × quantity`, `quantity_g` selon la cascade T-11,
   `store = <slug>`, `recorded_at = receiptDate ?? maintenant`, `notes = "Import ticket — <rawName>"` ;
2. recalcul du prix courant de l'ingrédient ;
3. si `addToPantry` : `pantry_stock` avec la **même** `quantity_g` et `notes = "Importé depuis ticket <store>"` ;
4. si `store != 'lidl'` : `receipt_alias.upsert(store, storeKey, ingredientId)` — c'est là que le
   matcher **apprend** ;
5. si `ticketId` et pas doublon : `imported_receipt.add(...)`.

### 3.9 Import de recette par URL

| Méthode | Chemin | Charge utile | Réponse |
|---|---|---|---|
| `POST` | `/api/recipe-import/extract` | `{ url }` | `{ extracted: { name, instructions, defaultPortions, prepTimeMin, imageUrl, sourceUrl }, lines: ResolvedLine[] }` — peut durer 5–10 s |
| `POST` | `/api/recipe-import/commit` | La recette résolue | `{ recipeId }` — promeut les ingrédients CIQUAL/OFF en bibliothèque perso, crée la recette, télécharge la photo **best-effort** (échec avalé) |

`goToStep0/1`, `reset`, `updateMeta`, `setLineQuantityG`, `setLineUnitCode`,
`setLineChosenIngredient`, `ignoreLine`, `unignoreLine`, `stepIndex` : **machine à états 100 % client**.

Messages d'erreur à conserver **verbatim** (français, affichés à l'utilisateur) : voir §4.2.

### 3.10 Lidl Plus (optionnel, phase tardive)

| Méthode | Chemin | Charge utile | Réponse |
|---|---|---|---|
| `GET` | `/api/lidl/settings` | — | `{ configured, enabled, pollIntervalMinutes, lastFetchedAt, lastError }` — **jamais le token** |
| `PUT` | `/api/lidl/settings` | `{ enabled?, pollIntervalMinutes? }` | idem ; `pollIntervalMinutes < 5` → `400` (au lieu du refus silencieux actuel) |
| `POST` | `/api/lidl/credentials` | `{ email, refreshToken }` | `204` — token chiffré, jamais renvoyé |
| `DELETE` | `/api/lidl/credentials` | — | `204` — purge + désactivation |
| `POST` | `/api/lidl/sync` | — | `{ newTicketIds: string[], message }` |
| `GET` | `/api/lidl/tickets/:id` | — | JSON brut à passer à `/api/receipts/parse-lidl-json` |

### 3.11 Divers

| Méthode | Chemin | Réponse |
|---|---|---|
| `GET` | `/api/tags` | `Tag[]` |
| `POST` / `PATCH` / `DELETE` | `/api/tags[/:id]` | **NOUVEAU** — le desktop n'expose aucune édition de tag, c'est une lacune |
| `GET` | `/api/categories` | Arbre complet `{ id, name, ordinal, children[] }[]` (fusionne `tree`, `flatL1`, `l2For`) |
| `POST` | `/api/categories` | `{ name, parentId? }` → `201` · `409` si homonyme au même niveau |
| `PATCH` | `/api/categories/:id` | `{ name?, ordinal? }` — le renommage **cascade** sur `ingredient.category_l1/l2` |
| `DELETE` | `/api/categories/:id` | `204` — met à `NULL` les ingrédients concernés, supprime les enfants en cascade |
| `GET` | `/api/search` | query : `q` → `{ ingredients[], recipes[], mealEntries[] }` (Ctrl+K unifié, 12 par section) |
| `GET` | `/api/export` | Dump JSON complet (remplacement fonctionnel des sauvegardes locales) |
| `POST` | `/api/import` | Restauration depuis un dump JSON |
| `GET` | `/api/health` | `{ ok, dbOk, offOnline, version }` |

### 3.12 Doublons de la surface desktop, fusionnés

1. `searchOnce` + `searchBySource` + `searchCatalogPaged` → **1** endpoint de recherche.
2. `fetchOnline` + `fetchOnlineAndList` → **1** endpoint OFF.
3. `lookupBarcodeAsDict` + étape OFF de `lookupBarcodeAndAssign` → **1** endpoint code-barres.
4. `findByIngredients` + `findByIngredientsCategorized` → **1** endpoint (garder le catégorisé).
5. 5 slots de dérivés de recette → **0** endpoint (calcul client).
6. `dayTotalAsDict` + `weekTotalAsDict` + `weekCostAsDict` → **1** endpoint de totaux.
7. `addRecipe` + `addIngredient` (calendrier) → **1** endpoint avec XOR.
8. `addL1` + `addL2` → **1** endpoint avec `parentId` optionnel.
9. `recipeListVM.searchOnce` + `calendarVM.searchOnce` → **1** endpoint `/api/search`.
10. `categoriesL1(source)` (texte libre) vs `flatL1()` (table structurée) → **à trancher**, pas
    simplement à fusionner (cf. §6, risque #12).

---

## 4. Logique métier à réécrire de Python vers TypeScript

### 4.1 Inventaire des modules

| Module Python | Rôle | Volume TS estimé | Difficulté | Notes de portage |
|---|---|---|---|---|
| `domain/models.py` (15 ko) | 11 modèles Pydantic + 2 enums + validateurs | 350–450 l. (Zod) | **Faible** | `frozen` → `readonly`. Messages d'erreur FR à conserver. Aucun modèle n'active `extra="forbid"` → `.strip()` de Zod équivalent |
| `domain/units.py` (2,1 ko) | 11 unités + `to_grams` / `from_grams` / `label_for` | 60 l. | **Faible** | ⚠️ `_piece` n'est **pas** dans la table : pseudo-code fabriqué à l'exécution, facteur = `piece_weight_g`. Centraliser une table partagée front/worker et traiter `_piece` explicitement |
| `domain/nutrition.py` (1,6 ko) | `NutritionTotal`, `_macros_for`, agrégations | 80 l. | **Faible** | Flottant IEEE 754 pur → JS `number` bit-à-bit identique. `None` contribue **0** |
| `domain/pricing.py` (1,5 ko) | Coûts en `Decimal` | 60 l. | **Moyen** | `decimal.js` `{ precision: 28 }`. **Arrondi par ligne `ROUND_HALF_UP` puis somme** — pas somme puis arrondi |
| `domain/shopping.py` (2,7 ko) | `ShoppingItem` / `ShoppingList` + dérivés | 80 l. | **Faible** | |
| `domain/receipt.py` (6,2 ko) | 4 dataclasses du pipeline ticket | 120 l. (interfaces) | **Faible** | Pas de Pydantic → simples `interface`. `is_duplicate` (property + champ privé) → simple booléen |
| `domain/url_recipe.py` (3,7 ko) | 4 dataclasses de l'import URL | 90 l. | **Faible** | |
| `services/nutrition_service.py` | Agrégation recette / jour / semaine | 120 l. | **Moyen** | ⚠️ **N+1 assumé** : 1 requête par entrée. À batcher (`WHERE id IN (…)`) — sur D1 les allers-retours coûtent bien plus cher |
| `services/shopping_service.py` | Agrégation + `format_as_text` | 250 l. | **Moyen** | Anti-N+1 déjà fait (≤ 8 SELECT). Format texte à chasse fixe : `ljust(40)`, `capitalize()` Python (minuscule le reste !), `─`×30, virgule décimale, `f"{x:.0f}"` en **arrondi banquier** |
| `services/meal_plan_service.py` | Semaines ISO, copie, templates | 200 l. | **Moyen** | `datetime.fromisocalendar` / `isocalendar()` sans équivalent JS : implémenter ISO-8601 **en UTC** (semaine du premier jeudi). `previous_iso_week('2026-W01')` doit donner `2025-W52` ou `W53` |
| `services/pricing_history_service.py` | Recalcul du prix courant | 50 l. | **Faible** | Remplacer le réécrit-tout par `UPDATE ingredient SET price_eur = ?, price_quantity_g = ? WHERE id = ?` |
| `services/openfoodfacts.py` | Client OFF (2 hôtes) | 250 l. | **Moyen** | `httpx` → `fetch` + `AbortSignal.timeout(10_000)`. `redirect: 'manual'` pour le health check. `round(kJ/4.184, 1)` : Python fait du **half-to-even**, JS du half-up |
| `services/ingredient_search.py` | Orchestration FTS + OFF + résolution | 300 l. | **Élevé** | Contient `resolve_ingredient_name` (bonus 0.10 exact/perso, re-classement rapidfuzz) |
| `data/repositories/*` (12 fichiers) | Accès données | 900–1 200 l. | **Moyen** | Le SQL brut de `_search_page` se transpose tel quel (`:nom` → `?`). Le reste est du CRUD |
| `services/receipt_parser/intermarche_parser.py` | Parseur PDF | 150 l. | **Élevé** | 4 regex transposables telles quelles. **Le problème est l'extraction de texte PDF**, pas le parsing |
| `services/receipt_parser/lidl_api_adapter.py` | JSON Lidl → `ParsedReceipt` | 120 l. | **Faible** | Fonction pure, entièrement testable |
| `services/receipt_matcher.py` | Rapprochement 4 niveaux | 200 l. + **scorer** | **Élevé** | Le scorer `token_set_ratio` (§4.3) est le vrai coût |
| `services/recipe_url_importer/quantity_parser.py` | Parsing de quantités FR | 250 l. | **Moyen** | Regex compatibles. `_ascii_fold` → `normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()`. 30 alias, l'**ordre est significatif** (plus longs d'abord) |
| `services/recipe_url_importer/jsonld_fallback.py` | Parseur Schema.org | 200 l. | **Moyen** | BeautifulSoup + lxml → `HTMLRewriter` (natif Workers) ou `linkedom` |
| `services/recipe_url_importer/scrapers_adapter.py` | Pont `recipe-scrapers` | — | **Élevé** | **Aucun équivalent JS** (~400 scrapers Python). Arbitrage §6 |
| `services/photo_service.py` | Pillow : EXIF, resize, JPEG | 120 l. (client) | **Moyen** | Déporté dans le navigateur : `createImageBitmap({ imageOrientation: 'from-image' })` + `OffscreenCanvas` + `convertToBlob({ quality: 0.85 })`. Reproduire `scale = min(1, 1024 / max(w,h))` — Pillow **n'agrandit jamais** |
| `services/lidl_plus_client.py` | Wrapper lib `lidl-plus` | ??? | **Élevé** | **Zéro endpoint dans le dépôt** — reverse-engineering requis (§6) |
| `services/receipt_watcher.py` | Surveillance de dossier | — | — | **Non porté** |
| `data/db.py` (backups) | Sauvegardes fichier | — | — | **Non porté** (D1 Time Travel) |
| `ui/viewmodels/*` (13 fichiers) | Orchestration + sérialisation | 1 500–2 000 l. (stores front) | **Moyen** | La majorité devient de l'état client (buffers, filtres, wizards) |

**Total estimé** : ≈ 3 000 lignes de logique métier partagée (domaine + services) + ≈ 1 200 lignes
d'accès données Worker + ≈ 2 000 lignes de state management front. Le **cœur métier pur** (domaine)
représente moins de 1 000 lignes et se porte mécaniquement : c'est de loin le morceau le plus sûr.

### 4.2 Constantes et messages à conserver mot pour mot

**Validateurs (français, affichés à l'utilisateur)** :
- `"Le nom de l'ingrédient ne peut pas être vide."`
- `"Les macros par 100 g ne peuvent pas être négatives."`
- `"Le prix doit être strictement positif."`
- `"Une quantité (g) doit être strictement positive."`
- `"Le nom de la recette ne peut pas être vide."`
- `"Le nom du tag ne peut pas être vide."`
- `"La note doit être comprise entre 1 et 5."`
- `"quantity_g et portions doivent être strictement positifs."`
- `"MealPlanEntry must reference exactly one of recipe_id / ingredient_id"` (anglais dans le code)
- `"portions must be > 0"` (anglais)

**Erreurs OpenFoodFacts** :
| Condition | Message |
|---|---|
| 502 / 503 / 504 | `"OpenFoodFacts est temporairement indisponible (HTTP {code}). Réessaie dans quelques minutes."` |
| 429 | `"Trop de requêtes vers OpenFoodFacts (HTTP 429). Attends une minute avant de réessayer."` |
| autre statut | `"OpenFoodFacts a renvoyé une erreur HTTP {code}."` |
| timeout | `"OpenFoodFacts ne répond pas (timeout). Vérifie ta connexion."` |
| connexion | `"Impossible de joindre OpenFoodFacts. Vérifie ta connexion internet."` |
| autre | `"Erreur réseau OpenFoodFacts : {exc}"` |

**Erreurs d'import URL** :
| Condition | Message |
|---|---|
| 404 | `"Page introuvable (HTTP 404). Vérifie l'URL."` |
| 401 / 403 | `"Cette page nécessite une connexion ou un abonnement (HTTP {code})."` |
| 502 / 503 / 504 | `"Le serveur est temporairement indisponible (HTTP {code}). Réessaie dans quelques minutes."` |
| 429 | `"Trop de requêtes vers ce site (HTTP 429). Attends une minute avant de réessayer."` |
| timeout | `"Le serveur ne répond pas (timeout). Vérifie ta connexion."` |
| connexion | `"Impossible de joindre ce site. Vérifie l'URL et ta connexion internet."` |
| page vide | `"La page semble vide. Vérifie qu'elle s'affiche bien dans un navigateur."` |
| JSON-LD malformé | `"Les données de recette sur cette page sont mal formées."` |
| aucune recette | `"Aucune recette trouvée sur cette page. Le site n'est pas supporté ou n'expose pas de données structurées (Schema.org)."` |

**Constantes numériques** :
- unités : `g 1 · kg 1000 · mg 0.001 · ml 1 · cl 10 · dl 100 · L 1000 · c_cafe 5 · c_soupe 15 · tasse 250 · pincee 1` (densité 1 g/ml assumée)
- Atwater : lipides ×9, glucides ×4, fibres ×2, protéines ×4
- seuils fuzzy : suggérer ≥ **70**, pré-sélectionner ≥ **90**, max **3** suggestions
- seuils frigo : `soon ≤ 5 j`, `watch ≤ 14 j`
- cascade masse au commit ticket : saisie > 0 → `price_quantity_g` → `piece_weight_g × qty` → **1000 g**
- défaut de quantité d'une ligne de recette importée sans quantité : **100 g**
- timeouts : OFF 10 s (connect 5) ; import URL 15 s (connect 5) ; photo 15 s, plafond **20 Mo**
- polling Lidl : plancher **5 min**, défaut 60, première sync +15 s
- debounces : recherche ingrédient 200 ms, CIQUAL 250 ms, Ctrl+K 200 ms
- User-Agent : `prandia/0.1.0 (+https://github.com/MarckuusS/prandia)`

### 4.3 Le point de fidélité le plus délicat : `token_set_ratio`

Utilisé par **deux** chemins critiques avec des seuils constants (70 / 90) :
`receipt_matcher._match_one` et `ingredient_search.resolve_ingredient_name`.

Algorithme à répliquer :
1. Tokeniser les deux chaînes sur les espaces → ensembles `A`, `B`.
2. `inter = sorted(A ∩ B)`, `diffA = sorted(A − B)`, `diffB = sorted(B − A)`, joints par espaces.
3. `t0 = inter`, `t1 = (inter + " " + diffA).trim()`, `t2 = (inter + " " + diffB).trim()`.
4. `score = max(ratio(t0,t1), ratio(t0,t2), ratio(t1,t2)) × 100`, où `ratio` est la similarité
   **Indel normalisée** : `1 − distance_indel(x,y) / (len(x) + len(y))`.

Normalisation appliquée par le matcher de tickets : **uniquement `casefold()`** (pas de suppression
de ponctuation, pas de dé-accentuation — contrairement au `default_process` de RapidFuzz).
`"L'ANGELYS"` garde son apostrophe, `"Crème"` son accent.

Deux stratégies, **à ne pas mélanger sans mesure** :
- (a) réimplémenter fidèlement `token_set_ratio` + Indel → les seuils 70/90 restent valides ;
- (b) utiliser un scorer JS existant et **recalibrer les seuils sur un corpus de tickets réels**.

Une implémentation approximative (Levenshtein simple, Dice, Fuse.js) à seuils constants **ne
produira pas les mêmes décisions de pré-sélection**.

### 4.4 Formats sérialisés à respecter à l'octet près

**Snapshot de template de semaine** — 7 clés, **toujours présentes**, y compris les `null` :
```json
[{"day_of_week":0,"slot":"noon","recipe_id":12,"ingredient_id":null,
  "quantity_g":null,"portions":2.0,"ordinal":0}]
```

**Export texte de la liste de courses** :
```
Liste de courses — 2026-W18\n
\n
== Fruits, legumes ==\n
☐ Carotte                                  500 g  (0,60 €)\n
☐ Oeuf                                     180 g · ≈ 3 pièces  (1,20 €)\n
== Viandes ==\n
☐ Boeuf                                    300 g  (4,20 €)\n
\n
──────────────────────────────\n
Total : 6,00 € · 1 ingrédient(s) sans prix\n
```
- `☐` U+2610, `—` U+2014, `·` U+00B7, `≈` U+2248, `─` U+2500 (×30) ;
- nom : `name[:40]` complété à 40 par des espaces ;
- quantité : `≥ 1000 g` → kg à 3 décimales, zéros de queue supprimés, virgule ;
  `≥ 10 g` → entier ; sinon 1 décimale **avec un point** (incohérence conservée telle quelle ou
  corrigée sciemment) ;
- en-tête de catégorie : `capitalize()` **Python** — première lettre en majuscule **et le reste en
  minuscules** (`"fruits, LEGUMES"` → `"Fruits, legumes"`). `text-transform: capitalize` en CSS ne
  fait **pas** la même chose ;
- liste vide : `"Liste de courses — {week}\n\n(aucun ingrédient)\n"`.

### 4.5 Contrat de tests à rejouer

**44 tests domaine existants** (5 fichiers) constituent le contrat de comportement et doivent être
retranscrits : `test_nutrition.py` (6), `test_pricing.py` (5), `test_units.py` (6),
`test_models.py` (20), `test_shopping_service.py` (17, dont 12 avec base en mémoire).

Assertions de référence à verrouiller en priorité :
- fromage `3,99 € / 250 g` × 80 g = `1,2768` → **`1,28 €`** (ROUND_HALF_UP verrouillé) ;
- farine `1,00 €/1000 g` × 500 g + beurre `4,00 €/250 g` × 250 g → total `4,50 €` ;
- recette `default_portions=4`, ligne 200 g, entrée `portions=2.0` → **100 g** dans la liste ;
- tri de la liste de courses : `["Aubergine", "Carotte", "Boeuf", "Sel"]` ;
- `IsoWeek.from_date(2026-04-29)` → `"2026-W18"` ;
- aller-retour d'unités : `|from_grams(to_grams(v,u),u) − v| < 1e-9` pour toutes les unités.

Le test `test_aggregate_uses_constant_query_count` (≤ 8 SELECT) est spécifique à SQLAlchemy →
équivalent : compter les appels `D1.prepare()` / `batch()` via un wrapper de test.

---

## 5. Écrans du front et adaptation mobile

### 5.1 Contrainte structurante

Le desktop repose sur des schémas qui ne tiennent pas en 360–430 px :
deux `SplitView` maître-détail simultanés (Ingrédients 42/58 %, Recettes 30/70 %), deux panneaux
latéraux coulissants de 240 px (Calendrier, Frigo), une grille calendrier 7 × 5 d'au moins 900 px de
large, et un tableau de ticket de 1 300 px.

**Passage obligatoire d'une maître-détail simultanée à une navigation en pile** (liste → détail →
retour), avec **conservation de l'état par onglet** (le `StackLayout` desktop garde aujourd'hui
scroll, sélection et formulaires en cours).

**Points de rupture** : `< 768 px` = pile mobile ; `768–1023 px` = une colonne large, calendrier
compacté ; `≥ 1024 px` = retour aux deux panneaux et à la grille 7 × 5.

### 5.2 Navigation mobile proposée

**Barre d'onglets fixe en bas, 5 entrées** (reprise directe des 5 onglets) :

| # | Icône | Libellé | Écran |
|---|---|---|---|
| 1 | 🥕 | Ingrédients | liste + formulaire empilé |
| 2 | 🍽 | Recettes | liste + éditeur empilé |
| 3 | 📅 | Semaine | vue jour + sélecteur de semaine |
| 4 | 🛒 | Courses | liste de courses |
| 5 | 🥫 | Frigo | stock (badge : tickets en attente) |

**En-tête compact (56 px)** : titre + bouton `🔍` (recherche unifiée plein écran — elle devient un
point d'entrée de premier plan puisque `Ctrl+K` disparaît) + bouton `⋯` (Mode sombre, Rayons
d'ingrédients, Imports de tickets, Lidl Plus, Export/Import, Aide).

**Toasts** : remonter au-dessus de la barre d'onglets (marge basse ≥ 72 px). Conserver le bouton
`Annuler` 5 s — **essentiel**, car aucune suppression sur Ingrédients / Recettes / Calendrier n'a de
confirmation préalable.

**Hors-ligne** : bannière en haut, pas une pastille dans une barre de statut (qui disparaît).

### 5.3 Ingrédients

- **Écran 1 — liste.** Recherche collante en haut ; `Trier ▾`, `Grouper ▾`, `🔧 Filtres · N` en une
  barre d'actions ouvrant des feuilles.
- Ligne 52 px → ~64 px (cible tactile 44 px). Les 3 macros P/G/L sur 2 lignes ou masquées < 380 px.
- La case à cocher multi-sélection devient un **mode « Sélectionner »** ; le bandeau « Trouver les
  recettes » devient une **barre d'action flottante en bas**.
- La poignée de drag `⠿` disparaît → menu de ligne (`⋮` ou appui long) : « Ajouter au frigo » /
  « Ajouter au calendrier ».
- **Écran 2 — formulaire** plein écran. Les 8 macros passent en une colonne, dans un **accordéon
  « Valeurs nutritionnelles » replié par défaut** (8 champs + prix + poids + rayon + 12 mois = écran
  très long). 12 bascules de saison → grille 6 × 2 à 40 px. `Enregistrer` / `Retirer` en barre fixe
  en bas.
- **À corriger au passage** : le prix s'affiche aujourd'hui en chaîne brute (`"1.2000"`), sans
  virgule ni `€` — incohérent avec tout le reste. Et une recherche sans résultat n'affiche **aucun**
  état vide.

### 5.4 Recettes

- **Écran 1 — liste.** La ligne 68 px avec vignette 56 px fonctionne telle quelle en tactile. Filtre
  par tags : chips défilables horizontalement.
- **Écran 2 — éditeur** plein écran, découpé en **sections repliables ou onglets internes** :
  `Infos` (photo, nom, portions, tags) · `Ingrédients` · `Nutrition` · `Coût & portions` ·
  `Instructions` · `Journal`.
- La ligne d'ingrédient (nom 220 + quantité 240 + notes 320 + ✕) **ne rentre pas** → carte à 2
  lignes : nom + `✕`, puis quantité + unité ; notes en 3ᵉ ligne ou derrière « + Note ».
- Tableau nutritionnel + donut → **empilement vertical**. Le tableau 3 colonnes tient en 360 px si
  l'on réduit la colonne de libellés et retire les pictos, sinon défilement horizontal du tableau seul.
- Le donut n'a pas de survol en tactile → **quartiers tappables**, le centre affiche le détail, un
  nouveau tap revient au total.
- La modale « modifications non sauvées » (3 boutons) → feuille d'action native.
- Photo : `<input type="file" accept="image/*">` ; sur mobile, `capture="environment"` en option.

### 5.5 Calendrier — l'écran le plus problématique

**Vue « un jour à la fois »** :
- En-tête : sélecteur de semaine `‹ S18 ›` + bande horizontale des 7 jours (`L 28` `M 29` …) avec un
  point sur les jours remplis ;
- Corps : les 5 créneaux du jour, empilés, chacun avec ses entrées et un `+ Ajouter` pleine largeur ;
- Récap nutritionnel = **colonne du jour** + pied « semaine » ;
- Mini-graphe 12 semaines conservé tel quel (déjà compact) ;
- Panneau latéral de drag supprimé.
- Tablette ≥ 768 px en paysage : grille 7 × 5 compactée (cellules ~90 px) reste jouable.

### 5.6 Liste de courses — l'écran le plus mobile-ready

C'est **l'usage n°1 en magasin** et donc l'écran à livrer en premier.
- Liste simple, sections par rayon **collantes** au défilement ;
- ligne ~56 px, case à cocher ≥ 24 px (zone de tap 44 px) ;
- total en **pied fixe** ; `📋 Copier la liste` → `Partager` (`navigator.share`) avec repli
  presse-papiers ;
- **persister les cases cochées côté serveur** (`PUT /api/shopping/:week/checked`) : aujourd'hui
  volatiles, un rafraîchissement en magasin efface tout le travail.

### 5.7 Frigo / Cellier

- Les 4 boutons d'en-tête ne tiennent pas : `+ Ajouter` en **FAB**, `Importer un ticket` et `Lidl`
  dans le menu `⋯` ou une page « Imports ».
- Barre de contrôles : `🔍` + `Grouper ▾` + `Trier ▾` en une ligne, feuilles de sélection.
  **Ajouter un debounce** sur le filtre (aujourd'hui aucun, une requête par frappe).
- Ligne 56 px conservée, notes coupées à une ligne.
- `✕` → **balayage vers la gauche**, avec la même confirmation.
- Popup d'ajout rapide → **bottom sheet** (quantité + DLC + Ajouter), mêmes valeurs par défaut
  (poids unitaire ou 100 g).
- Saisie `JJ/MM/AAAA` → `<input type="date">` natif (le sélecteur maison n'a plus lieu d'être).

### 5.8 Écrans nouveaux ou fortement remaniés

| Écran | Contenu |
|---|---|
| **Réglages** | Mode sombre, rayons d'ingrédients, Lidl Plus, export / import, diagnostic. Remplace la barre de menus native |
| **Imports** | File des tickets téléversés (`receipt_upload`), bouton « Téléverser un ticket », historique des imports. Remplace le dossier surveillé et son badge |
| **Revue de ticket** | Le tableau 1 300 px devient une **liste de cartes** : par ligne, nom du ticket + prix, un sélecteur d'ingrédient, une quantité, un `⋮` (DLC, EAN, retirer). Le plus gros chantier UI du portage |
| **Scan** | Caméra plein écran + cadre de visée, repli photo, saisie manuelle de l'EAN |
| **Recherche unifiée** | Plein écran, 3 sections, navigation clavier optionnelle. **Corriger** : les en-têtes de section doivent être sautés par ↑/↓, et l'activation d'un ingrédient doit réellement ouvrir la fiche (aujourd'hui l'`id` est ignoré) |

### 5.9 États de chargement — ajout net

Constat des inventaires : **il n'existe quasiment aucun état de chargement dans les 5 pages
desktop** (tout est synchrone sur SQLite local). En web, **chaque lecture devient un aller-retour
réseau** : il faut ajouter des squelettes / spinners **partout**, y compris là où le desktop n'en
avait aucun. Le composant `AppSpinner` existe déjà mais n'est utilisé que par les dialogues d'import.

### 5.10 Jetons de design à porter

Palette complète en variables CSS (clair / sombre) — cf. `07-dialogs.md` §2.1 pour les 26 jetons
exacts. Principaux :
`--color-primary #2563eb / #3b82f6`, `--color-background #f8fafc / #0f172a`,
`--color-surface #ffffff / #1e293b`, `--color-text #0f172a / #f1f5f9`,
`--color-error #dc2626 / #f87171`, `--color-success #16a34a / #4ade80`,
`--color-warning #ea580c / #fbbf24`, `--color-accent #0891b2 / #22d3ee`.

Hors thème, **fixes dans les deux modes** : badges de source `#15803d` (CIQUAL) / `#1d4ed8` (OFF) /
`#c2410c` (perso) ; palette nutriment `#F1B40E` énergie, `#FDA406` lipides, `#DA4A35` saturés,
`#509938` glucides, `#07A0AA` sucres, `#7CC04C` fibres, `#0B6BBB` protéines, `#7145A7` sel ;
fond du toast d'annulation `#1f2937`.

Tailles : 10 / 11 / **13 (base)** / 15 / 18 / 22 px. Espacements 4·8·12·16·24·32.
Rayons 4·6·10·14·9999. Durées 150 / 250 / 400 ms. Hauteurs de contrôle 28 / **36** / 44 px.
⚠️ La base à 13 px est **petite pour du mobile** : prévoir un passage à 15–16 px sous 768 px.

Formatage : `Intl.NumberFormat('fr-FR', { minimumFractionDigits: n, maximumFractionDigits: n })`
partout — **virgule décimale**. Ne jamais envoyer de nombre localisé à l'API.

8 icônes de nutriments à produire en SVG (`energy, fats, saturatedFats, carbs, sugars, fiber,
proteins, salt`), aujourd'hui des PNG bitmap chargés en ×2.

---

## 6. Points durs, classés par risque

### 🔴 Risque élevé

#### #1 — FTS5 sur D1

**Enjeu.** La recherche d'ingrédients (4 177 lignes, utilisée par 6 écrans) repose sur une table
virtuelle à contenu externe, 3 triggers et le tokenizer `unicode61 remove_diacritics 2` — c'est ce
tokenizer qui rend la recherche insensible aux accents (« tomate » trouve « Tomâte »).

**Recommandation.** **Valider FTS5 sur un environnement D1 réel avant d'écrire une seule ligne de
front.** D1 est du SQLite complet et FTS5 fait partie de la compilation standard : la probabilité de
succès est élevée, mais l'échec invaliderait une décision d'architecture. Test minimal : créer la
table virtuelle, insérer 10 lignes, `MATCH` + `ORDER BY rank`, puis `rebuild`.

**Plan B (à concevoir en même temps, pas après)** : colonne `name_normalized` (déjà au schéma) +
`LIKE 'tok%'` par token. On perd le classement `rank` → repli `ORDER BY name`, qui est **déjà** le
comportement du code Python quand la requête est vide. Sur 4 177 lignes l'écart est imperceptible.
Coût du plan B : ~1 jour. Coût de le découvrir après le développement du front : plusieurs jours.

**Piège associé** : le code Python **n'exécute jamais** `rebuild`. Son index n'est peuplé que par
les triggers, ce qui fonctionne parce que la table virtuelle a été créée avant le premier ingrédient.
Un chargement de masse en D1 avec les triggers absents laisserait **l'index vide et toute recherche
à 0 résultat**, sans erreur.

#### #2 — Appels OpenFoodFacts depuis un Worker

**Enjeu.** Trois problèmes distincts : (a) OFF applique un rate-limit plus agressif aux clients
anonymes, d'où le `User-Agent` personnalisé ; (b) les requêtes sortantes d'un Worker partent d'IP
Cloudflare partagées, potentiellement déjà limitées par d'autres utilisateurs ; (c) l'API expose
deux hôtes aux comportements différents (`world.openfoodfacts.org` pour les code-barres,
`search.openfoodfacts.org` pour Search-a-licious).

**Recommandation.**
1. **Toujours passer par le Worker**, jamais d'appel navigateur → CORS, contrôle de l'UA, cache
   mutualisé. C'est aussi ce que fait déjà le desktop (appel côté application, pas côté QML).
2. **Vérifier explicitement que l'UA personnalisé survit** à la sous-requête du Worker (le
   comportement varie selon les environnements) et le rendre paramétrable par variable d'environnement.
3. **Mettre en cache agressivement** via la Cache API (clé = URL normalisée) : les fiches produit
   OFF changent rarement. TTL suggéré : 24 h pour un code-barres, 1 h pour une recherche texte.
   Le desktop n'a **aucun cache HTTP** — c'est une amélioration nette, pas une reproduction.
4. **Gérer les 429 avec un backoff** et remonter le message français existant.
5. Remplacer le ping toutes les 5 min par un **Cron Trigger** qui écrit un flag dans KV, lu par
   `GET /api/off/status`. Un ping par client toutes les 5 minutes ne passe pas à l'échelle.
6. `redirect: 'manual'` pour le health check (`GET /` renvoie une 302 avec corps vide, et `HEAD` est
   refusé par Search-a-licious avec un 405).

**Bug à corriger au passage** : le court-circuit « requête vide » est incohérent entre
`search_by_name` (`not filters`, vérité booléenne) et `fetch_from_openfoodfacts_and_cache`
(`filters is None`). Résultat : un objet de filtres dont toutes les valeurs sont `None` est
« truthy » → la requête Lucene devient `"*:*"` → **on pagine dans l'intégralité du dataset OFF**,
exactement ce que le commentaire du code dit vouloir éviter. Normaliser en supprimant les clés
`null` avant l'appel.

**Ambiguïté à trancher** : `filters.category_l1` contient un libellé CIQUAL français
(« fruits, legumes ») mais est envoyé tel quel comme `categories_tags:"…"`, alors que l'API attend
un tag canonique (`fr:legumes`). **Le filtre catégorie de l'onglet OFF est probablement non
fonctionnel aujourd'hui.** Soit construire une table de correspondance, soit retirer le filtre.

#### #3 — Scan de code-barres sur iOS Safari

**Enjeu.** Le desktop n'a **aucun scan caméra** : il a un champ EAN et un lookup. Le scan est un
**ajout de périmètre** motivé par le mobile. Sur iOS :
- l'API `BarcodeDetector` (native sur Chrome Android) **n'est pas disponible sur Safari** ;
- `getUserMedia` exige HTTPS et, historiquement, ne fonctionnait que dans Safari lui-même — le
  support en mode PWA autonome (`display: standalone`) a évolué et **doit être testé sur l'appareil
  cible** avant de s'y engager ;
- l'autofocus macro nécessaire aux EAN-13 est capricieux sur les capteurs grand-angle.

**Recommandation — stratégie à trois niveaux, dans cet ordre :**
1. **Décodage WASM côté client** avec `@zxing/library` / `zxing-wasm` (le plus mature pour EAN-13 et
   EAN-8), flux `getUserMedia({ video: { facingMode: { ideal: 'environment' } } })`, décodage sur
   `requestAnimationFrame`. Fonctionne sur Chrome Android **et** Safari iOS moderne.
2. **Repli photo, sans caméra live** : `<input type="file" accept="image/*" capture="environment">`
   puis décodage de l'image fixe par la même lib. Ne dépend d'aucune permission caméra persistante,
   fonctionne partout, et couvre le cas « le live ne démarre pas ».
3. **Saisie manuelle de l'EAN**, toujours disponible — c'est le seul chemin qui existe aujourd'hui
   et il doit rester le filet de sécurité.

**À conserver** : la validation locale « chiffres uniquement, longueur ≥ 8 » **avant** tout appel
réseau, et la longueur `(8, 12, 13)` pour l'heuristique « ça ressemble à un code-barres ».
⚠️ `str.isdigit()` en Python accepte les chiffres Unicode non-ASCII — utiliser `/^\d+$/` en TS est
un durcissement acceptable.

**Note** : le pistolet douchette HID que l'utilisateur pourrait brancher se comporte comme un
clavier — aucun code spécifique, il remplit le champ EAN.

#### #4 — Import de tickets de caisse

**Enjeu.** C'est la fonctionnalité la plus dépendante du desktop, et elle enchaîne **quatre**
problèmes indépendants :
1. **Le dossier surveillé n'a aucun équivalent web.** La File System Access API demande une
   permission par répertoire, n'est pas disponible sur iOS Safari, et ne notifie pas en arrière-plan.
2. **`pdfplumber` n'existe pas en JS.**
3. **Le parseur Intermarché est fragile et non testé en CI** : son unique test est *skippé* faute
   d'un PDF au chemin absolu `<dossier-telechargements>/…`. La détection d'enseigne repose sur
   `"FONTAINE-LES-DIJON"`, le nom du magasin de l'utilisateur.
4. **Le tableau de revue fait 1 300 px de large** avec 7 colonnes éditables.

**Recommandation.**
- **Entrée** : téléversement explicite (`<input type="file" accept="application/pdf">` + zone de
  dépôt) + **Web Share Target** déclaré dans le manifeste PWA (Android) — c'est ce qui se rapproche
  le plus du confort « le PDF arrive tout seul ». Optionnellement, ingestion par e-mail via
  Cloudflare Email Routing pour reproduire fidèlement l'ergonomie d'origine.
- **Extraction de texte : côté navigateur avec `pdf.js`**, et n'envoyer que le **texte brut** au
  Worker. Trois bénéfices : pas de CPU Worker consommé, pas d'upload de PDF, et le parsing par regex
  reste identique au Python. Le Worker garde une route `multipart` de repli utilisant `unpdf`.
- **Ne pas ajouter d'OCR** en première intention : le parseur suppose du texte natif. Photographier
  un ticket papier est un **ajout de périmètre** (Tesseract WASM ou service externe) à arbitrer
  séparément — ne pas le glisser dans le portage.
- **Écrire d'abord un test de non-régression** sur le PDF échantillon, versionné dans le dépôt
  (anonymisé si besoin). Aujourd'hui **aucun test ne tourne** sur ce parser.
- **UI de revue** : abandonner le tableau, passer à une **liste de cartes** (§5.8).
- **Incohérence à corriger** : le watcher accepte `.html` / `.htm` mais `parse_receipt` les refuse —
  un HTML déposé produit une notification puis une erreur. Carrefour est mentionné partout (slug,
  message d'erreur) mais **aucun parseur n'existe**.

#### #5 — Client Lidl Plus

**Enjeu.** Le fichier `lidl_plus_client.py` **ne contient aucun endpoint HTTP, aucune URL, aucun
flux OAuth** : toute la mécanique est dans la lib PyPI communautaire `lidl-plus`, traitée comme une
boîte noire. Le seul contrat visible est `LidlPlusApi(refresh_token, language='fr', country='FR')`
avec `.tickets()` et `.ticket(id)`. De plus :
- l'obtention du refresh token **n'est pas implémentée dans le dépôt** (commande CLI externe + 2FA
  par e-mail, token collé à la main) ;
- le login comporte un captcha, non automatisable ;
- le token vit dans le Windows Credential Manager via `keyring` — la posture sécurité actuelle
  **refuse explicitement d'écrire un secret en clair** ;
- la lib est testée DE/AT/UK, le support FR **n'est pas garanti** (l'app l'affiche elle-même comme
  « expérimental »).

**Recommandation — traiter Lidl Plus comme une fonctionnalité de second rang, en dernière phase :**
1. **Livrer d'abord le chemin découplé** : `POST /api/receipts/parse-lidl-json` accepte un JSON de
   ticket collé à la main. `adapt_lidl_json` est une fonction pure, trivialement portable, et
   fonctionne indépendamment de l'origine du dict. Cela couvre 80 % de la valeur pour 5 % du coût.
2. **Ne réimplémenter le protocole OAuth Lidl en TS que si l'usage le justifie** — cela suppose un
   reverse-engineering de la lib upstream, avec un risque de rupture à chaque évolution de l'API Lidl.
3. Si c'est fait : refresh token **chiffré** (clé dans les secrets du Worker, jamais en clair en D1),
   **jamais renvoyé au front**, polling par **Cron Trigger** (fonctionne app fermée, contrairement au
   `QTimer`). Attention au budget CPU d'un événement planifié : `fetch_recent_tickets` + N détails
   doit tenir dedans, sinon découper en file.
4. Remplacer les voyants « lib installée » / « keyring disponible » par « proxy Lidl configuré ».

**Incohérence relevée** : `fetch_recent_tickets` a un défaut `limit=10` mais le viewmodel appelle
avec `limit=20`.

#### #6 — Fidélité du matching flou (rapidfuzz)

Déjà détaillé en §4.3. **C'est un risque élevé parce qu'il est silencieux** : une implémentation
approximative ne plante pas, elle propose simplement de mauvais ingrédients, et l'utilisateur ne
comprend pas pourquoi. Décider explicitement entre réimplémentation fidèle et recalibrage mesuré.

**Faiblesse structurelle à connaître** : le fuzzy ne compare qu'à la **bibliothèque personnelle**
(`in_personal_library = 1`). Une bibliothèque vide ⇒ aucune suggestion, jamais. Aujourd'hui elle
compte 58 lignes sur 4 177.

#### #7 — `recipe-scrapers` sans équivalent

**Enjeu.** ~400 scrapers spécifiques en Python (Marmiton, 750g, Hervé Cuisine, Cuisine AZ…), dont
certains corrigent à la main un balisage cassé. **Aucun équivalent JS de couverture comparable.**

**Recommandation.** Trois options, à arbitrer **explicitement** :
- **(a) JSON-LD seul.** Le repli maison (`jsonld_fallback.py`, déjà écrit, bien testé) couvre les
  blogs WordPress + WP Recipe Maker, soit le gros des blogs de cuisine français. On perd les sites au
  balisage cassé. **Recommandé pour démarrer** : coût nul (le code existe), et l'échec est explicite
  (« Le site n'est pas supporté ou n'expose pas de données structurées »).
- **(b) Micro-service Python** (Cloud Run / Fly.io) appelé par le Worker : couverture maximale,
  mais rupture de l'architecture tout-Cloudflare et coût d'infra permanent.
- **(c) Extracteurs sur mesure** pour les 3–5 sites réellement utilisés par l'utilisateur, ajoutés
  au fil de l'eau par-dessus (a).

**Contrainte technique** : le fetch **doit** passer par le Worker (CORS). Certains sites bloquent
les IP Cloudflare ou les UA non-navigateur → prévoir de gérer les 403 et éventuellement d'adopter un
UA plus banal. `HTMLRewriter` (natif Workers, en streaming) suffit largement à extraire les blocs
`<script type="application/ld+json">`.

### 🟠 Risque moyen

#### #8 — Stockage des photos

**Enjeu.** Aujourd'hui : Pillow (EXIF transpose, `thumbnail(1024)` sans agrandissement, aplatissement
de l'alpha sur blanc, JPEG q85, `optimize=True`), fichier `~/.prandia/recipe_photos/<recipe_id>.jpg`,
**une photo par recette**, colonne = **nom de fichier seul**. Pillow n'existe pas dans un Worker.

**Recommandation.**
- **Redimensionnement dans le navigateur**, avant l'upload :
  `createImageBitmap(file, { imageOrientation: 'from-image' })` (applique l'EXIF **nativement**) →
  `OffscreenCanvas` dimensionné par `scale = min(1, 1024 / max(w, h))` (reproduit le « n'agrandit
  jamais » de Pillow) → `ctx.fillStyle = '#fff'; ctx.fillRect(...)` **avant** `drawImage` (le JPEG
  n'a pas d'alpha) → `convertToBlob({ type: 'image/jpeg', quality: 0.85 })`.
  Prévoir un repli `<canvas>` classique là où `OffscreenCanvas` n'est pas disponible.
  Bénéfice : reproduit la spec **à l'identique**, et l'upload passe de plusieurs Mo à < 200 Ko.
- **Stockage R2**, clé `recipes/<recipe_id>.jpg`, même convention « une photo, écrasée ».
  `recipe.image_key` garde la **clé relative**, pas l'URL absolue — même raisonnement de portabilité
  que le nom de fichier actuel.
- **Lecture** via une route Worker `GET /api/recipes/:id/photo` (cache + contrôle d'accès) ou une URL
  signée. Un `head()` R2 en 404 → placeholder côté UI, en conservant la sémantique actuelle
  « fichier manquant → chaîne vide + avertissement en log ».
- **Photo depuis une URL distante** (import de recette) : `fetch` dans le Worker avec garde-fou de
  taille **en streaming** (`Content-Length` puis lecture bornée). Le code actuel télécharge 20 Mo
  **avant** de refuser — à corriger.
- **Contrainte à conserver ou lever** : le nom de fichier étant l'id, la recette doit être
  **sauvegardée avant** l'ajout de photo (l'app affiche « Sauvegarde la recette avant d'ajouter une
  photo »). Pour permettre la photo avant la première sauvegarde, passer à des clés UUID.
- **Les 6 valeurs `image_path` existantes sont inexploitables** : les photos seront re-téléversées à
  la main. Coût négligeable.

#### #9 — Import CIQUAL vers D1

**Enjeu.** Le loader lit `.xls` (via `xlrd<2.0`), `.xlsx` (`openpyxl`) ou `.csv`, avec une
normalisation d'en-têtes (pliage d'accents, `/`→espace, collapse) et une table de 12 candidats de
colonnes. Rien de tout cela n'existe dans un Worker. Le fichier ANSES est fourni **manuellement** par
l'utilisateur et le chargement **n'est jamais déclenché par l'app** (contrairement à ce qu'affirme
`CLAUDE.md`).

**Recommandation.** Ne **pas** porter le loader. Deux chemins, dans cet ordre de préférence :
1. **Exporter la base existante.** Les 4 177 lignes actuelles contiennent déjà CIQUAL **et** les
   693 fiches OFF mises en cache, **et** les prix, marques, saisonnalités et drapeaux
   `in_personal_library` saisis par l'utilisateur. Un `SELECT` → génération d'`INSERT` produit
   directement l'état voulu. C'est aussi la migration de données (#12) : **un seul travail**.
2. **Conversion hors ligne** du `.xls` ANSES en NDJSON/SQL (script Node ou Python jetable), chargé
   par `wrangler d1 execute --file`, pour les futures mises à jour ANSES. Le sous-ensemble pertinent
   est `(alim_code, alim_nom_fr, alim_grp_nom_fr, alim_ssgrp_nom_fr, 8 macros)`.

**Bug à corriger impérativement au portage** : `_ing_apply` écrit **tous** les champs du modèle, et
le loader ne renseigne ni `brand`, ni les prix, ni `piece_weight_g`, ni `cooked_weight_per_100g_raw`,
ni `season_months` → **un re-seed les remet tous à `NULL`**. Seul `in_personal_library` est
explicitement protégé. Le docstring affirme le contraire. En D1, faire un `UPDATE` **ciblé** sur les
seules colonnes CIQUAL (nom, macros, catégories).

Règles de parsing de cellules à conserver : `""`/`"-"` → `null` ; `"traces"`/`"trace"` → **`0.0`** ;
`"< 0.1"` → **`0.0`** ; virgule décimale, espaces et espaces insécables retirés ; **jamais
d'exception**. Un `0` numérique est **significatif** (l'eau fait 0 kcal) et n'est pas converti en
`null`.

#### #10 — Authentification mono-utilisateur

**Enjeu.** L'app desktop n'a **aucune authentification** : la base est un fichier local. En web, les
données deviennent accessibles par URL. Un seul utilisateur, plusieurs appareils (téléphone + poste).

**Recommandation — par ordre de préférence :**

1. **Cloudflare Access (Zero Trust) devant tout le Worker.** Zéro ligne de code
   d'authentification, MFA / OTP par e-mail ou Google, sessions gérées par Cloudflare, gratuit
   jusqu'à un nombre d'utilisateurs largement suffisant pour un usage personnel. Le Worker se
   contente de **vérifier le JWT injecté** (`Cf-Access-Jwt-Assertion`) contre le JWKS de l'équipe, et
   de refuser tout le reste. C'est la recommandation forte : la surface d'attaque est nulle et il n'y
   a aucun secret applicatif à gérer.
   *Limite* : les requêtes non authentifiées sont bloquées **avant** le Worker, donc pas d'API
   publique ; ce n'est pas un problème ici.
   *Point d'attention* : vérifier que le flux Access ne gêne pas l'installation de la PWA ni le Web
   Share Target — à tester tôt.

2. **Si Access ne convient pas** : mot de passe unique + session signée.
   - hash du mot de passe stocké **en secret Worker** (PBKDF2 via WebCrypto, ≥ 200 000 itérations, ou
     Argon2 WASM), jamais en D1 ;
   - à la connexion, cookie `HttpOnly; Secure; SameSite=Lax; Path=/` contenant un JWT signé
     (HMAC-SHA256, secret Worker), durée 30 jours, renouvellement glissant ;
   - **rate-limiting** de la route de connexion (KV compteur par IP) — sans quoi la seule protection
     de toute la base est un mot de passe exposé à un brute-force sans limite ;
   - protection CSRF sur les mutations (`SameSite=Lax` + en-tête `X-Requested-With` vérifié, ou
     double-submit token).

3. **À exclure** : « pas d'authentification, juste une URL secrète ». Les URL fuient par le
   `Referer`, l'historique, les logs et les partages.

**Point transverse** : le chiffrement du refresh token Lidl (#5) doit utiliser une **clé distincte**
du secret de session, elle aussi en secret Worker.

#### #11 — Migration des données existantes SQLite → D1

**Enjeu.** Faible volume (≈ 4 300 lignes), mais plusieurs transformations obligatoires et
irréversibles si mal faites.

**Recommandation — procédure, dans cet ordre :**

1. **Figer une copie** de `prandia.db` (l'app fait déjà un backup au démarrage ; en prendre
   un manuel supplémentaire).
2. **Appliquer les migrations D1** (`0001_core.sql`) sur une base **vierge**, sans FTS.
3. **Générer les `INSERT` par un script de transformation** (Node ou Python jetable) lisant le SQLite
   source **par nom de colonne, jamais par position** — sur une base migrée, les colonnes ajoutées
   sont en fin de table et n'ont pas les mêmes types déclarés que sur une base neuve
   (`in_personal_library INTEGER` vs `BOOLEAN`, `piece_weight_g REAL` vs `FLOAT`…).
4. **Transformations à appliquer ligne par ligne :**
   | Donnée | Transformation |
   |---|---|
   | Tous les horodatages | → ISO-8601 **UTC** `YYYY-MM-DDTHH:MM:SSZ`. Attention : les `CURRENT_TIMESTAMP` sont **déjà en UTC** (sans microsecondes), les `datetime.now()` sont en **heure locale** avec microsecondes. Ne pas décaler les premiers en croyant décaler les seconds |
   | `expiry_date`, `recorded_at`, `cooked_at` | → `YYYY-MM-DD` (jour) ou ISO complet selon le champ |
   | `price_eur` (ingredient, price_history), `total_eur` | `REAL`/`INTEGER` → **chaîne décimale** normalisée (`12` → `"12.0000"`) |
   | `ingredient.name_normalized` | **Calculer** : minuscule + NFD sans diacritiques |
   | `recipe.image_path` | → `NULL` (photos re-téléversées ensuite) |
   | `recipe_ingredient.ordinal` | Vérifier l'unicité de `(recipe_id, ingredient_id, ordinal)` avant insertion |
   | `meal_plan_entry` | Rejeter (en le **signalant**, pas silencieusement) toute ligne violant le XOR ou l'obligation `portions` / `quantity_g` |
   | `lidl_plus_settings` | → une ligne `app_setting('lidl_plus', …)`. **Aucun secret n'y était stocké**, rien à migrer côté token |
5. **Ordre d'insertion** (contraintes FK) : `ingredient`, `recipe`, `tag` → `recipe_ingredient`,
   `recipe_tag`, `meal_plan_entry`, `pantry_stock`, `ingredient_price_history`,
   `recipe_cooking_log`, `receipt_alias` → `category_definition` (L1 avant L2) → tables isolées.
   Par lots de ~500 `INSERT` (`wrangler d1 execute --file` a une limite de taille de fichier).
6. **Puis seulement** : `0002_fts.sql` (table virtuelle + triggers + **`rebuild`**).
7. **Vérification automatisée** : comparer les `COUNT(*)` de chaque table, la somme de
   `ingredient.kcal_per_100g`, le nombre de lignes `in_personal_library = 1` (**58** attendues :
   21 ciqual + 37 OFF), et `COUNT(ingredient_fts) == COUNT(ingredient)` (**4 177**).
8. **Rejouer la migration entière au moins deux fois** avant la bascule finale, et la garder
   scriptée : c'est le seul moyen d'avoir confiance dans une opération à sens unique.

**Écueil D1 spécifique** : pas de transaction interactive multi-requêtes. Un chargement partiel est
possible → toujours partir d'une base vierge et recommencer plutôt que de rattraper.

#### #12 — Deux sources de vérité pour les « rayons »

`ingredient.category_l1/l2` sont des **chaînes libres** ; `category_definition` est une **table
structurée avec des ids**. Le lien est maintenu à la main : renommer une catégorie fait un
`UPDATE ingredient SET category_l1 = :new WHERE category_l1 = :old`, la supprimer met à `NULL`.
Certains écrans lisent `ingredientVM.categoriesL1(source)` (valeurs distinctes du texte), d'autres
`categoryVM.flatL1()` (la table).

⚠️ **Le cascade de renommage / suppression matche le nom GLOBALEMENT**, sans se limiter au parent :
renommer la sous-catégorie « Verts » sous « Légumes » renomme aussi le `category_l2` des ingrédients
rangés sous « Verts » d'un **autre** L1.

**Recommandation** : **conserver le TEXT libre** (rétrocompatibilité CIQUAL et imports OFF, coût de
migration nul), mais :
- exposer **une seule** source côté API (`GET /api/categories`) et faire dériver les listes de
  filtres du même endpoint ;
- **scoper le cascade au parent** lors du renommage/suppression d'un L2 ;
- ne pas oublier que l'UI a **abandonné la hiérarchie** : seuls les L1 sont exposés, les L2 hérités
  restent en base silencieusement, et le formulaire ingrédient force `categoryL2 = null` à chaque
  enregistrement (nettoyage progressif volontaire des seeds CIQUAL).

#### #13 — Absence de transactions interactives sur D1

Le code Python garantit l'atomicité par `session_scope` (commit en sortie, rollback sur exception).
Cinq opérations en dépendent : commit de ticket, copie de semaine, application de template,
sauvegarde de recette (recette + lignes + tags), import en lot d'ingrédients.

**Recommandation** : `db.batch([...])` pour les écritures groupées (atomique), et réécrire le motif
« insert → récupérer l'id → insert dépendant » avec `INSERT ... RETURNING id` (supporté) plutôt qu'un
`flush()` suivi d'une relecture. Là où l'atomicité stricte n'est pas atteignable, choisir un ordre
d'écriture **idempotent au rejeu** et documenter le comportement en cas d'échec partiel.

### 🟡 Risque faible mais à ne pas rater

| # | Point | Recommandation |
|---|---|---|
| 14 | **`Decimal` → JS** | `decimal.js` `{ precision: 28 }`. Jamais de `number` pour les euros. Reproduire `ROUND_HALF_UP` **par ligne** puis somme. ⚠️ `shopping_service` fait un `quantize` **sans rounding explicite** (donc HALF_EVEN) là où `pricing` force HALF_UP — inoffensif en pratique, mais à harmoniser sciemment |
| 15 | **Arithmétique ISO-8601** | `Date` n'a pas d'API de semaine ISO. Implémenter en **UTC** (jeudi de référence). `iso.year` ≠ année civile : le 31/12/2024 est en `2025-W01`. `previous_iso_week` sur une année à 53 semaines lève aujourd'hui une exception non capturée |
| 16 | **Tri et collation** | Le desktop trie par **points de code** (`.lower()`, collation BINARY) : « Élise » après « Zoé ». `localeCompare('fr')` donnerait un ordre **différent** (et plus juste). C'est un changement de comportement à assumer explicitement |
| 17 | **Ordre chronologique des créneaux** | `ORDER BY slot` en SQL donne `evening, morning, noon, snack_afternoon, snack_morning`. L'ordre chronologique est reconstruit par l'UI. Utiliser un `CASE` explicite côté API, plus robuste |
| 18 | **`_piece` n'est pas une unité du domaine** | Pseudo-code fabriqué en QML, facteur = `piece_weight_g`. `to_grams('_piece')` lève. Un chemin d'appel (`recipe_url_import_vm`) le traite comme des **grammes** — bug potentiel à trancher. Centraliser une table d'unités partagée |
| 19 | **Semantique « clé présente »** | `brand`, `categoryL1/L2`, `seasonMonths`, et les champs du frigo : clé absente ⇒ valeur préservée. Utiliser `PATCH`, pas `PUT`, pour rendre le contrat explicite |
| 20 | **Macros à 0 impossibles** | `_or_none` convertit `0` en `null` : impossible d'enregistrer « 0 g de lipides ». Comportement volontaire côté desktop — décider si on le conserve (une eau à 0 kcal est pourtant valide côté modèle) |
| 21 | **Undo après suppression dure** | Recrée avec un **nouvel id**, sans re-lier les références (lignes de recette, entrées de calendrier). Préférable : **ne poster le `DELETE` qu'à l'expiration du toast** — supprime le besoin d'un endpoint d'annulation |
| 22 | **Archivage caché** | `weekly_cost_snapshot` est écrit **pendant une lecture**. Rendre explicite (`POST /api/calendar/:week/snapshot` ou recalcul serveur) |
| 23 | **Raccourcis clavier** | `Ctrl+N/S/T/F/1-5` sont réservés par le navigateur. `Ctrl+K` et `/` sont sûrs. Prévoir `Ctrl+Entrée` pour enregistrer et des touches nues hors champ de saisie |
| 24 | **Dates en UTC dans l'UI** | `new Date().toISOString().slice(0,10)` propose la **veille** en soirée française. Bug présent dans `PriceHistoryDialog` et `CookingHistoryDialog` — à corriger avec une date locale |
| 25 | **Suppressions sans confirmation** | Observation de prix, entrée de journal, ligne de ticket, purge des credentials Lidl : immédiates, sans confirmation **ni annulation**, alors que les composants existent. Harmoniser |
| 26 | **`Tag.color_hex` non validé** | Chaîne arbitraire injectée dans du CSS = risque. `CHECK` en base + validation Zod (`/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/`) |
| 27 | **Sentinelle `-1`** | Le dialogue d'import stocke les macros inconnues à `-1` et les masque par `>= 0`. Préférer `null` avec un rendu explicite |
| 28 | **Code mort à ne pas porter** | `app/data/repositories.py` (fichier plat masqué par le package homonyme) ; le composant `PagePlaceholder` ; le signal `tags_changed` jamais émis ; `matchThreshold` de `RecipeMatchDialog` |

---

## 7. Découpage en phases de livraison

Chaque phase aboutit à **quelque chose d'utilisable**, pas à un jalon technique.

### Phase 0 — Socle et migration (fondations)

**Livrable utilisable** : les données personnelles sont en ligne, sauvegardées, et consultables via
un export. Rien de visible côté utilisateur, mais le point de non-retour est franchi proprement.

| Tâche | Détail |
|---|---|
| Dépôt + outillage | Monorepo `worker/` + `web/` + `shared/`, TypeScript strict, `wrangler`, CI (typecheck + tests) |
| **Validation FTS5 sur D1** | ⚠️ **Tout premier travail.** Test isolé : table virtuelle + triggers + `MATCH` + `rebuild`. Si échec → basculer sur `name_normalized` avant toute autre décision |
| Migrations D1 | `0001_core.sql` + `0002_fts.sql` (§2.3, §2.4) |
| Script de migration de données | §6 #11, rejoué au moins deux fois, avec les vérifications automatisées |
| Authentification | Cloudflare Access devant le Worker + vérification du JWT (§6 #10) |
| `GET /api/health`, `GET /api/export` | Diagnostic et filet de sécurité |
| Portage du **domaine pur** | `units`, `nutrition`, `pricing`, `shopping`, `models` (Zod) + **les 44 tests domaine** |

### Phase 1 — Consultation mobile (première valeur réelle)

**Livrable utilisable** : la liste de courses de la semaine est consultable et cochable **au
supermarché, sur le téléphone**. C'est l'usage n°1 et le seul qui soit strictement meilleur en
mobile qu'en desktop.

| Tâche | Détail |
|---|---|
| Coquille PWA | Manifeste, barre d'onglets 5 entrées, thème clair/sombre, jetons CSS, états de chargement |
| `GET /api/shopping/:week` + `PUT …/checked` | Agrégation, regroupement par rayon, cases **persistées** |
| Écran Liste de courses | Sections collantes, total en pied fixe, `navigator.share` avec repli presse-papiers |
| `GET /api/ingredients` + recherche FTS | Écran Ingrédients en **lecture seule** (liste, recherche, fiche) |
| `GET /api/recipes` + `GET /api/recipes/:id` | Écran Recettes en lecture seule, avec **nutrition, coût et donut calculés côté client** |
| `GET /api/calendar/:week` + `/totals` | Vue « un jour à la fois », lecture seule |
| `GET /api/pantry` | Frigo en lecture seule, seaux d'urgence |

### Phase 2 — Écriture du cœur

**Livrable utilisable** : l'app remplace le desktop pour tout ce qui est saisie manuelle
quotidienne. Le desktop reste utile pour les imports.

| Tâche | Détail |
|---|---|
| CRUD ingrédient | Formulaire en accordéon, sémantique « clé présente », collision de nom (409), suppression soft/hard + undo différé |
| Éditeur de recette | Buffer client, lignes + unités + notes, scaling de portions, tags, `PUT` unique |
| Calendrier en écriture | Ajout XOR, suppression + undo, copie de semaine, templates |
| Frigo en écriture | CRUD, swipe-to-delete, bottom sheet d'ajout, couplage liste de courses |
| Journal de cuisson | Ajout / suppression / compteur 30 jours |
| Catégories / rayons | Arbre, ajout, renommage **scopé**, suppression |
| Tags | Ajout de la création / édition / suppression, absentes du desktop |
| Recherche unifiée | Plein écran, 3 sections, **avec** les corrections (sauter les en-têtes, ouvrir réellement la fiche ingrédient) |
| Suggestion de recettes | `POST /api/recipes/suggest`, 3 sections `ready` / `missing` / `shopping` |

### Phase 3 — Catalogue, code-barres et prix

**Livrable utilisable** : on peut enrichir sa bibliothèque depuis le téléphone, en scannant un
produit dans le magasin ou dans le placard.

| Tâche | Détail |
|---|---|
| Proxy OFF | `/api/off/search`, `/api/off/barcode/:ean`, `/api/off/status`, **cache Cache API**, backoff 429, correction du court-circuit `*:*` |
| Import CIQUAL / OFF | Écran catalogue paginé, filtres macro, promotion unitaire et en lot |
| **Scan de code-barres** | ZXing WASM + repli photo + saisie manuelle (§6 #3) |
| Historique de prix | Ajout / suppression d'observations, recalcul du prix courant, graphe d'évolution |
| Photos de recette | Redimensionnement navigateur (1024 / q85 / EXIF), R2, route de lecture (§6 #8) |
| Cron OFF status | Remplace le ping client toutes les 5 min |

### Phase 4 — Import de recettes par URL

**Livrable utilisable** : coller une URL de blog crée une recette complète, avec ses ingrédients
rattachés à la bibliothèque.

| Tâche | Détail |
|---|---|
| `quantity_parser` en TS | Portage fidèle + corpus de tests (30 cas documentés) |
| `jsonld_fallback` en TS | `HTMLRewriter`, `@graph`, `HowToSection`, durées ISO |
| `resolve_ingredient_name` | Exact → perso → tous, bonus 0.10, re-classement flou |
| `POST /api/recipe-import/extract` + `/commit` | Timeout généreux, promotion en bibliothèque, photo best-effort |
| Assistant 3 étapes | Machine à états client, édition ligne par ligne, création manuelle, ignorer |
| **Arbitrage `recipe-scrapers`** | Démarrer en JSON-LD seul, mesurer le taux d'échec sur les sites réellement utilisés, décider ensuite (§6 #7) |

### Phase 5 — Tickets de caisse

**Livrable utilisable** : un PDF Intermarché téléversé (ou partagé depuis Android) alimente
l'historique de prix et le frigo, avec apprentissage des libellés.

| Tâche | Détail |
|---|---|
| Extraction PDF navigateur | `pdf.js`, envoi du **texte** au Worker ; route `multipart` de repli |
| Parseur Intermarché | Regex portées + **test de non-régression versionné** (aujourd'hui inexistant) |
| Adaptateur JSON Lidl | Fonction pure, portage direct |
| **Scorer `token_set_ratio`** | Réimplémentation fidèle + corpus de validation (§4.3, §6 #6) |
| Matcher 4 niveaux | `source_ref` → alias → fuzzy → none |
| File `receipt_upload` + Web Share Target | Remplace le dossier surveillé, badge sur l'onglet Frigo |
| Écran de revue en cartes | Le plus gros chantier UI (§5.8) |
| `POST /api/receipts/commit` | Atomique via `db.batch`, cascade de masse, apprentissage d'alias |

### Phase 6 — Finitions et bascule

**Livrable utilisable** : le desktop peut être désinstallé.

| Tâche | Détail |
|---|---|
| Lidl Plus, chemin découplé | `POST /api/receipts/parse-lidl-json` (coller le JSON) — 80 % de la valeur |
| Lidl Plus, proxy complet | **Optionnel**, à n'engager que si l'usage le justifie (§6 #5) |
| Export / import complet | Remplacement fonctionnel des sauvegardes locales |
| Mode hors-ligne | Service worker : cache des lectures, file d'écritures différées. Cible prioritaire : **la liste de courses en magasin**, où le réseau est mauvais |
| Page Réglages / Diagnostic | Thème, rayons, imports, Lidl, export, version, état D1 et OFF |
| Accessibilité et responsive ≥ 1024 px | Retour à la maître-détail et à la grille 7 × 5 sur grand écran |
| Retrait de l'app Qt | Après une période de double usage et une vérification des `COUNT(*)` |

### Dépendances entre phases

```
Phase 0  ──┬─> Phase 1 ──> Phase 2 ──┬─> Phase 3 ──> Phase 4
           │                         │
           └─> (validation FTS5)     └─> Phase 5 ──> Phase 6
```

Les phases 3, 4 et 5 sont **indépendantes entre elles** une fois la phase 2 livrée : elles peuvent
être réordonnées selon l'usage réel. Si l'utilisateur importe surtout des tickets, la phase 5 passe
avant la 4. La seule contrainte forte est **0 → 1 → 2**.

---

## Annexe — Bugs et incohérences relevés dans le code, à trancher avant portage

Liste consolidée des sept inventaires. Chaque ligne est un comportement **observé dans le code**,
pas une hypothèse.

| # | Où | Comportement | Décision suggérée |
|---|---|---|---|
| 1 | `_seed_seasonality` | `lower()` SQLite ASCII-only : `'épinard%'` ne matche aucun `'Épinard%'` (6 lignes en base, 0 saisonnalité) | Corriger via `name_normalized` |
| 2 | `ciqual_loader` | Un re-seed remet à `NULL` marque, prix, poids pièce, poids cuit et saisonnalité | `UPDATE` ciblé sur les seules colonnes CIQUAL |
| 3 | `_search_page` | Un `"` dans la requête casse la syntaxe FTS5 → **erreur 500 déclenchable par une saisie normale** | Échapper `"` → `""` |
| 4 | `RecipeRepo._replace_lines` | `ordinal = line.ordinal or idx` écrase un `ordinal = 0` explicite | Utiliser `??` |
| 5 | `pricing` vs `shopping_service` | Deux arrondis différents (HALF_UP explicite vs HALF_EVEN par défaut) | Harmoniser sur HALF_UP |
| 6 | `recipe_url_import_vm:225` | `_piece` traité comme des grammes (`qty * 1.0`) au lieu de `× piece_weight_g` | Corriger |
| 7 | `upsert_by_source_ref` | Re-fetcher un produit OFF déjà en bibliothèque **efface** `in_personal_library`, prix, poids pièce, catégories | Préserver explicitement, comme le fait le loader CIQUAL |
| 8 | `search_by_name` / `fetch_from_off_and_cache` | Court-circuits incohérents → requête `*:*` sur tout le dataset OFF | Normaliser les filtres `null` |
| 9 | `fetch_from_off_and_cache` | `category_l1` (libellé CIQUAL) envoyé comme `categories_tags` OFF (attend `fr:legumes`) | Table de correspondance ou retrait du filtre |
| 10 | `resolve_ingredient_name` | Branche `elif` : un match exact MANUAL hors bibliothèque perso court-circuite CIQUAL/OFF | Corriger |
| 11 | `find_by_name` | Charge **toute une source** (~3 000 lignes) en mémoire pour comparer en Python | `name_normalized` + index |
| 12 | `nutrition_service.aggregate_entries` | N+1 : une requête par entrée | Batcher |
| 13 | `CategoryRepo.rename/delete` | Cascade **globale** sur le nom, sans scope au parent | Scoper |
| 14 | `CategoryRepo.add` | `rollback()` sur `IntegrityError` annule **toute** la transaction | Ne pas reproduire |
| 15 | `CalendarViewModel.searchOnce` | **Cassé** : appelle `rowCount()` sur une `list` → `AttributeError` | Réécrire (filtrage client) |
| 16 | `CalendarViewModel.saveAsTemplate` | `log.warning` alors que `log` n'est jamais importé → `NameError` sur le chemin d'erreur | Corriger |
| 17 | `RecipeEditorViewModel.updateLineUnit` | Ne marque pas la recette « modifiée » → changement d'unité perdu sans avertissement | Corriger |
| 18 | `cookedTimesThisMonth` | Fenêtre glissante de 30 jours, libellé « ce mois » | Renommer ou changer la logique |
| 19 | `_ing_to_dict` vs rôle `priceEur` | `""` d'un côté, `null` de l'autre | Convention unique : `null` |
| 20 | Replis de catégorie | `"Sans rayon"` / `"Non catégorisé"` / `null` selon l'écran | Harmoniser |
| 21 | `prepTimeMin`, `sourceUrl` | Exposés par le VM d'import URL mais **jamais persistés** (absents de `Recipe`) | Ajouter les colonnes (§2.5) |
| 22 | `MealPlanEntry` | Rien n'interdit `quantity_g` sur une entrée recette ni `portions` sur une entrée ingrédient | `CHECK` renforcé (§2.3) |
| 23 | `IsoWeek._validate` | `int()` tolère les espaces : `"2026-W 5"` passe | Regex stricte |
| 24 | `UnifiedSearchDialog` | ↑/↓ s'arrêtent sur les en-têtes de section, Entrée sans effet | Sauter les en-têtes |
| 25 | `Main.qml` (Ctrl+K) | L'activation d'un ingrédient ignore `payload.id` : rien n'est sélectionné | Utiliser `navigateToIngredient(id)` |
| 26 | `RecipeMatchDialog` | `transientParent` jamais assigné → la navigation vers l'ingrédient **ne fonctionne probablement jamais** | Routeur global |
| 27 | `AddCalendarEntryDialog` | `_slotLabel` ne connaît pas `snack_morning` / `snack_afternoon` → affiche « soir » ; `close()` inconditionnel même sans sélection | Corriger les deux |
| 28 | `PriceHistoryDialog` | `qtyField.value` écrit sur une propriété inexistante → la quantité par défaut n'est **jamais** pré-remplie ; champ prix non validé (texte libre) | Corriger |
| 29 | `PriceHistoryDialog`, `CookingHistoryDialog` | `toISOString()` → propose la **veille** en soirée française | Date locale |
| 30 | `CookingHistoryDialog` | `cookingLogAsList()` ne prend pas de `recipeId` : dépend de la recette chargée dans le VM → désynchronisation possible | Passer l'id explicitement |
| 31 | `ReceiptImportDialog` | DLC invalide **silencieusement ignorée**, sans message ; pluriels approximatifs ; `console.log` de debug en production | Corriger |
| 32 | `ImportIngredientDialog` | Le « chargement différé au premier focus » annoncé n'existe pas ; la sélection est vidée même si l'import échoue | Corriger |
| 33 | `ImportRecipeUrlDialog` | Échec de création manuelle silencieux (message affiché derrière la modale) | Corriger |
| 34 | `receipt_alias.hit_count` | Incrémenté mais **jamais lu** nulle part | Porter avec un tri par fréquence, ou supprimer |
| 35 | `_iso_duration_to_minutes` | Ignore les semaines (`P1W`) et les secondes (`PT30S` → `null`) | Étendre ou documenter |
| 36 | `quantity_parser` | `"2 x 200 g"` non géré ; `"2 à 3 cuillères"` produit `"3 cuillères"` ; commentaire « strip trailing dot » sans code | Documenter les limites |
| 37 | `parse_receipt` | Le watcher accepte `.html`/`.htm`, le parseur les refuse ; détection d'enseigne basée sur le nom du magasin de l'utilisateur | Corriger la détection |
| 38 | `MacrosChart` | Le centre affiche l'énergie **Atwater recalculée**, pas la `kcal` de la base — les deux divergent sur CIQUAL | Décider laquelle fait foi |
| 39 | `MealSlot.qml` | Toutes les entrées de la semaine sont instanciées dans **chacune** des 35 cellules | Ne pas reproduire |
| 40 | `IngredientsPage` | Le prix s'affiche en chaîne brute `"1.2000"` sans virgule ni `€` ; une recherche sans résultat n'affiche **aucun** état vide ; `Suppr` se déclenche même dans un champ texte ; la sélection multiple n'est pas remise à zéro au changement de filtre | Corriger |
