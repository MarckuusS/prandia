/**
 * Ingredients : bibliotheque personnelle, catalogue, prix.
 *
 * Le « catalogue » (CIQUAL, OpenFoodFacts) et la « bibliotheque personnelle »
 * sont la MEME table. Seul `in_personal_library` les distingue. Ajouter un
 * ingredient depuis le catalogue ne copie donc rien : cela bascule un drapeau.
 *
 * Le catalogue est DUPLIQUE par foyer (voir migrations/0005_households.sql) :
 * chaque ligne appartient a exactement un foyer, y compris les 4 177 lignes
 * CIQUAL. Il n'existe donc aucune ligne « commune » qu'il faudrait laisser
 * passer — toute requete de ce fichier se filtre sur le foyer, sans exception.
 */

import type { Criterion, Ingredient } from '@prandia/shared'
import { escapeLike, normalizeName, toFtsQuery } from '@prandia/shared'

import { toIngredient, type IngredientRow } from '../rows.js'
import { buildSet, NOW_SQL, placeholders, toInt } from './sql.js'

export const INGREDIENT_COLUMNS = `
  id, name, name_normalized, source, source_ref, brand,
  kcal_per_100g, proteins_g, carbs_g, sugars_g,
  fats_g, saturated_fats_g, fiber_g, salt_g,
  price_eur, price_quantity_g, piece_weight_g, cooked_weight_per_100g_raw,
  in_personal_library, category_l1, category_l2, season_months,
  restock_threshold_g, nutriscore_grade,
  created_at, updated_at`

/** Colonnes modifiables, indexees par le nom camelCase de l'API. */
const WRITABLE = {
  name: 'name',
  source: 'source',
  sourceRef: 'source_ref',
  brand: 'brand',
  kcal: 'kcal_per_100g',
  proteins: 'proteins_g',
  carbs: 'carbs_g',
  sugars: 'sugars_g',
  fats: 'fats_g',
  saturatedFats: 'saturated_fats_g',
  fiber: 'fiber_g',
  salt: 'salt_g',
  priceEur: 'price_eur',
  priceQuantityG: 'price_quantity_g',
  pieceWeightG: 'piece_weight_g',
  cookedWeightPer100gRaw: 'cooked_weight_per_100g_raw',
  inLibrary: 'in_personal_library',
  categoryL1: 'category_l1',
  categoryL2: 'category_l2',
  seasonMonths: 'season_months',
  // Le seuil se regle sur la fiche du produit, a cote de son prix de
  // reference, et non dans une feuille perdue du placard : il appartient au
  // produit, pas au lot.
  restockThresholdG: 'restock_threshold_g',
  // Renseigne par le scan, jamais saisi a la main : c'est une note publiee par
  // OpenFoodFacts, pas une appreciation.
  nutriscoreGrade: 'nutriscore_grade',
} as const

/**
 * Champs acceptes en ecriture.
 *
 * Volontairement en `unknown` : la validation de forme est deja faite par Zod
 * dans la route, et redeclarer ici chacun des vingt types ne ferait que creer
 * un second endroit a maintenir quand le modele bouge.
 */
export type IngredientWrite = { [K in keyof typeof WRITABLE]?: unknown }

/** Ce qui empeche une suppression definitive, et pourquoi. */
export interface IngredientUsage {
  readonly recipes: number
  readonly mealPlan: number
  readonly pantry: number
}

const CRITERION_COLUMNS: Readonly<Record<string, string>> = {
  kcal: 'kcal_per_100g',
  proteins: 'proteins_g',
  carbs: 'carbs_g',
  sugars: 'sugars_g',
  fats: 'fats_g',
  saturatedFats: 'saturated_fats_g',
  fiber: 'fiber_g',
  salt: 'salt_g',
}

export class IngredientRepo {
  constructor(
    private readonly db: D1Database,
    private readonly householdId: number,
  ) {}

  // ------------------------------------------------------------------ lecture

  async count(): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS c FROM ingredient WHERE household_id = ?')
      .bind(this.householdId)
      .first<{ c: number }>()
    return row?.c ?? 0
  }

  /**
   * Chargement en masse par identifiants.
   *
   * Les identifiants arrivent d'ailleurs — lignes de recettes, entrees du
   * calendrier, lots du frigo. Le filtre sur le foyer est donc ce qui rend une
   * reference etrangere INEXISTANTE plutot que lisible : l'appelant recoit une
   * Map sans cette cle, et traite le cas comme un ingredient supprime.
   */
  async byIds(ids: Iterable<number>): Promise<Map<number, Ingredient>> {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return new Map()

    const { results } = await this.db
      .prepare(
        `SELECT ${INGREDIENT_COLUMNS} FROM ingredient
         WHERE id IN (${placeholders(unique.length)}) AND household_id = ?`,
      )
      .bind(...unique, this.householdId)
      .all<IngredientRow>()

    return new Map(results.map((r) => [r.id, toIngredient(r)]))
  }

  async get(id: number): Promise<Ingredient | null> {
    const row = await this.db
      .prepare(`SELECT ${INGREDIENT_COLUMNS} FROM ingredient WHERE id = ? AND household_id = ?`)
      .bind(id, this.householdId)
      .first<IngredientRow>()
    return row ? toIngredient(row) : null
  }

  /**
   * Bibliotheque personnelle, avec recherche optionnelle.
   *
   * La recherche combine deux chemins et fusionne : FTS5 pour le classement
   * par pertinence, et `name_normalized LIKE` pour rattraper ce que le
   * tokenizer ne sait pas faire — les ligatures, « oeuf » ne trouvant pas
   * « Œuf » via FTS5 seul.
   */
  async listPersonal(query: string | null, limit = 500): Promise<Ingredient[]> {
    const fts = toFtsQuery(query)

    if (!fts) {
      const { results } = await this.db
        .prepare(
          `SELECT ${INGREDIENT_COLUMNS} FROM ingredient
           WHERE household_id = ? AND in_personal_library = 1 ORDER BY name LIMIT ?`,
        )
        .bind(this.householdId, limit)
        .all<IngredientRow>()
      return results.map(toIngredient)
    }

    // `ingredient_fts` ne porte PAS le foyer — elle indexe les lignes de tout
    // le monde et ne sait que proposer des rowid. C'est ce SELECT-ci qui
    // cloisonne, via `i.household_id` : le MATCH peut rendre l'identifiant
    // d'un ingredient du voisin, la jointure ne le retiendra pas.
    const { results } = await this.db
      .prepare(
        `SELECT ${prefixed('i')}
         FROM ingredient i
         WHERE i.household_id = ?
           AND i.in_personal_library = 1
           AND (i.id IN (SELECT rowid FROM ingredient_fts WHERE ingredient_fts MATCH ?)
                OR i.name_normalized LIKE ? ESCAPE '\\')
         ORDER BY i.name
         LIMIT ?`,
      )
      .bind(this.householdId, fts, `%${escapeLike(normalizeName(query))}%`, limit)
      .all<IngredientRow>()
    return results.map(toIngredient)
  }

  /**
   * Catalogue complet — c'est ce que parcourt la fenetre « Importer ».
   *
   * Contrairement a `listPersonal`, aucun filtre sur `in_personal_library` :
   * on cherche justement ce qui n'y est pas encore. Les lignes deja presentes
   * dans la bibliotheque restent visibles (le front les marque d'une etoile)
   * plutot que d'etre masquees, sinon rechercher un ingredient qu'on possede
   * deja donnerait « aucun resultat », ce qui est deroutant.
   */
  /**
   * Champs chiffrables du catalogue, et leur colonne.
   *
   * Le prix au kilo et le poids unitaire n'y sont pas : ils existent dans la
   * bibliotheque personnelle, pas dans un catalogue de reference. Un champ
   * inconnu est ignore plutot que rejete — c'est la meme tolerance que
   * `parseCriteria`.
   */
  static readonly COLUMNS = CRITERION_COLUMNS

  async searchCatalog(
    query: string | null,
    options: {
      source?: string | null
      categoryL1?: string | null
      criteria?: readonly Criterion[]
      limit?: number
      offset?: number
    } = {},
  ): Promise<{ items: Ingredient[]; totalCount: number }> {
    const { source = null, categoryL1 = null, criteria = [], limit = 50, offset = 0 } = options
    const fts = toFtsQuery(query)

    // Le foyer ouvre la liste, donc la clause n'est JAMAIS vide : sans requete
    // ni filtre, ce catalogue rendait autrefois toute la table. Il rend
    // desormais le catalogue de ce foyer, et rien d'autre.
    const where: string[] = ['i.household_id = ?']
    const args: unknown[] = [this.householdId]

    if (fts) {
      // Meme remarque que dans `listPersonal` : le MATCH n'est pas cloisonne,
      // c'est le `i.household_id` ci-dessus qui borne le resultat.
      where.push(`(i.id IN (SELECT rowid FROM ingredient_fts WHERE ingredient_fts MATCH ?) OR i.name_normalized LIKE ? ESCAPE '\\')`)
      args.push(fts, `%${escapeLike(normalizeName(query))}%`)
    }
    if (source) {
      where.push('i.source = ?')
      args.push(source)
    }
    if (categoryL1) {
      where.push('i.category_l1 = ?')
      args.push(categoryL1)
    }

    // Les bornes filtrent A LA SOURCE, et c'est le point : filtrer une page de
    // dix resultats cote client mentirait sur les 3 474 autres.
    //
    // `IS NOT NULL` est explicite plutot que laisse a SQL : une comparaison
    // avec NULL rend NULL, donc la ligne serait deja ecartee — mais l'ecrire
    // dit que c'est VOULU. Une fiche sans valeur ne satisfait aucune borne,
    // pas meme une borne haute, exactement comme dans la bibliotheque.
    for (const c of criteria) {
      const column = CRITERION_COLUMNS[c.field]
      if (!column) continue
      where.push(`(i.${column} IS NOT NULL AND i.${column} ${c.bound === 'min' ? '>=' : '<='} ?)`)
      args.push(c.value)
    }

    const clause = `WHERE ${where.join(' AND ')}`

    const [page, total] = await Promise.all([
      this.db
        .prepare(`SELECT ${prefixed('i')} FROM ingredient i ${clause} ORDER BY i.name LIMIT ? OFFSET ?`)
        .bind(...args, limit, offset)
        .all<IngredientRow>(),
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM ingredient i ${clause}`)
        .bind(...args)
        .first<{ c: number }>(),
    ])

    return { items: page.results.map(toIngredient), totalCount: total?.c ?? 0 }
  }

  /** Rayons connus, pour alimenter le filtre par categorie. */
  async listCategories(): Promise<Array<{ l1: string; count: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT category_l1 AS l1, COUNT(*) AS count
         FROM ingredient
         WHERE household_id = ? AND category_l1 IS NOT NULL AND category_l1 <> ''
         GROUP BY category_l1 ORDER BY category_l1`,
      )
      .bind(this.householdId)
      .all<{ l1: string; count: number }>()
    return results
  }

  /**
   * Retrouve une fiche par son identifiant d'origine.
   *
   * Cle du scan par code-barres : un produit deja connu localement doit rendre
   * SA fiche — avec le prix releve et le poids a la piece que l'utilisateur a
   * saisis — et non la version brute d'OpenFoodFacts, qui les ecraserait.
   */
  async findBySourceRef(source: string, sourceRef: string): Promise<Ingredient | null> {
    const row = await this.db
      .prepare(
        `SELECT ${INGREDIENT_COLUMNS} FROM ingredient
         WHERE household_id = ? AND source = ? AND source_ref = ? LIMIT 1`,
      )
      .bind(this.householdId, source, sourceRef)
      .first<IngredientRow>()
    return row ? toIngredient(row) : null
  }

  /**
   * Recherche un doublon exact sur le nom normalise, hors ligne `exceptId`.
   *
   * Le foyer n'est pas seulement une question de confidentialite ici : sans
   * lui, scanner un produit que le voisin possede deja repondrait « ce nom
   * existe déjà » en designant une fiche que l'on ne peut ni ouvrir ni
   * modifier.
   *
   * `inLibraryOnly` repond au meme probleme, d'un cran plus subtil : la table
   * `ingredient` porte AUSSI les 3 500 lignes du catalogue CIQUAL et les fiches
   * OpenFoodFacts mises en cache, qui n'apparaissent nulle part dans la
   * bibliotheque tant que `in_personal_library` vaut 0. Chercher un doublon sur
   * toute la table refusait donc de creer un ingredient nomme comme une entree
   * de catalogue jamais importee, en designant une fiche invisible : une
   * impasse, sans aucun moyen d'en sortir depuis l'ecran. Le desktop, lui, ne
   * comparait qu'aux ingredients de source `manual`.
   */
  async findByNormalizedName(
    name: string,
    exceptId: number | null = null,
    { inLibraryOnly = false }: { inLibraryOnly?: boolean } = {},
  ): Promise<Ingredient | null> {
    const row = await this.db
      .prepare(
        `SELECT ${INGREDIENT_COLUMNS} FROM ingredient
         WHERE household_id = ? AND name_normalized = ? AND (? IS NULL OR id <> ?)
           AND (? = 0 OR in_personal_library = 1) LIMIT 1`,
      )
      .bind(this.householdId, normalizeName(name), exceptId, exceptId, inLibraryOnly ? 1 : 0)
      .first<IngredientRow>()
    return row ? toIngredient(row) : null
  }

  // ------------------------------------------------------------------ ecriture

  async create(payload: IngredientWrite & { name: string }): Promise<number> {
    // `household_id` est pose ICI et non dans `WRITABLE` : il ne doit jamais
    // etre modifiable par un corps de requete, sinon une fiche pourrait etre
    // deposee dans la cuisine d'a cote.
    const columns: string[] = ['household_id', 'name', 'name_normalized']
    const values: unknown[] = [this.householdId, payload.name, normalizeName(payload.name)]

    for (const [key, column] of Object.entries(WRITABLE)) {
      if (key === 'name' || !(key in payload)) continue
      columns.push(column)
      const raw = (payload as Record<string, unknown>)[key]
      values.push(key === 'inLibrary' ? toInt(raw as boolean) ?? 0 : raw ?? null)
    }

    const row = await this.db
      .prepare(
        `INSERT INTO ingredient (${columns.join(', ')}) VALUES (${placeholders(columns.length)})
         RETURNING id`,
      )
      .bind(...values)
      .first<{ id: number }>()

    if (!row) throw new Error("INSERT ingredient n'a rien renvoye")
    return row.id
  }

  /**
   * Mise a jour partielle.
   *
   * `name_normalized` est recalcule des que `name` change : c'est la seule
   * colonne derivee de la table, et un oubli rendrait l'ingredient
   * introuvable par la recherche sans qu'aucune erreur ne le signale.
   */
  async update(id: number, patch: IngredientWrite): Promise<boolean> {
    const normalized: Record<string, unknown> = { ...patch }
    if ('inLibrary' in normalized) normalized['inLibrary'] = toInt(normalized['inLibrary'] as boolean)

    const set = buildSet(normalized, WRITABLE)
    if (!set) return false

    let clause = set.clause
    const values = [...set.values]
    if (typeof patch.name === 'string') {
      clause = `name_normalized = ?, ${clause}`
      values.unshift(normalizeName(patch.name))
    }

    const result = await this.db
      .prepare(`UPDATE ingredient SET ${clause} WHERE id = ? AND household_id = ?`)
      .bind(...values, id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  /** Bascule l'appartenance a la bibliotheque personnelle. */
  async setInLibrary(id: number, inLibrary: boolean): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE ingredient SET in_personal_library = ?, updated_at = ${NOW_SQL}
          WHERE id = ? AND household_id = ?`,
      )
      .bind(inLibrary ? 1 : 0, id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * Ou l'ingredient est-il utilise.
   *
   * `recipe_ingredient` porte un ON DELETE RESTRICT : sans cette verification
   * prealable, la suppression echouerait sur une contrainte SQLite dont le
   * message ne dit pas QUELLE recette bloque.
   */
  async usage(id: number): Promise<IngredientUsage> {
    const row = await this.db
      .prepare(
        // `recipe_ingredient` ne porte pas le foyer : on le borne par sa
        // recette, qui le porte. Compter sans cette jointure ferait remonter
        // l'usage chez le voisin — un « utilise par 3 recettes » sans qu'aucune
        // recette visible ne l'utilise, donc une suppression impossible a
        // expliquer.
        `SELECT
           (SELECT COUNT(DISTINCT ri.recipe_id) FROM recipe_ingredient ri
              JOIN recipe r ON r.id = ri.recipe_id AND r.household_id = ?
             WHERE ri.ingredient_id = ?) AS recipes,
           (SELECT COUNT(*) FROM meal_plan_entry WHERE ingredient_id = ? AND household_id = ?) AS meal_plan,
           (SELECT COUNT(*) FROM pantry_stock    WHERE ingredient_id = ? AND household_id = ?) AS pantry`,
      )
      .bind(this.householdId, id, id, this.householdId, id, this.householdId)
      .first<{ recipes: number; meal_plan: number; pantry: number }>()

    return { recipes: row?.recipes ?? 0, mealPlan: row?.meal_plan ?? 0, pantry: row?.pantry ?? 0 }
  }

  /**
   * Noms des recettes qui utilisent l'ingredient — pour un message d'erreur utile.
   *
   * Ces noms partent dans un message affiche : le filtre sur `r.household_id`
   * est ce qui empeche le message d'erreur de reciter les recettes du voisin.
   */
  async recipeNamesUsing(id: number, limit = 5): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT r.name FROM recipe r
         JOIN recipe_ingredient ri ON ri.recipe_id = r.id
         WHERE ri.ingredient_id = ? AND r.household_id = ? ORDER BY r.name LIMIT ?`,
      )
      .bind(id, this.householdId, limit)
      .all<{ name: string }>()
    return results.map((r) => r.name)
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM ingredient WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  // ------------------------------------------------------------------- prix

  async listPriceHistory(ingredientId: number): Promise<
    Array<{ id: number; ingredientId: number; priceEur: string; quantityG: number; store: string | null; recordedAt: string; notes: string | null; createdAt: string }>
  > {
    const { results } = await this.db
      .prepare(
        `SELECT id, ingredient_id, price_eur, quantity_g, store, recorded_at, notes, created_at
         FROM ingredient_price_history WHERE ingredient_id = ? AND household_id = ?
         ORDER BY recorded_at DESC, id DESC`,
      )
      .bind(ingredientId, this.householdId)
      .all<{
        id: number
        ingredient_id: number
        price_eur: string
        quantity_g: number
        store: string | null
        recorded_at: string
        notes: string | null
        created_at: string
      }>()

    return results.map((r) => ({
      id: r.id,
      ingredientId: r.ingredient_id,
      priceEur: r.price_eur,
      quantityG: r.quantity_g,
      store: r.store,
      recordedAt: r.recorded_at,
      notes: r.notes,
      createdAt: r.created_at,
    }))
  }

  /**
   * Enregistre une observation de prix et rafraichit le cache de l'ingredient.
   *
   * `ingredient.price_eur` est une denormalisation de la DERNIERE observation.
   * Les deux ecritures partent dans un `batch` : si la seconde echouait seule,
   * la fiche afficherait un prix que l'historique ne justifie pas.
   *
   * Le cache n'est mis a jour que si l'observation est la plus recente —
   * saisir un releve ancien ne doit pas faire reculer le prix courant.
   */
  async addPriceObservation(entry: {
    ingredientId: number
    priceEur: string
    quantityG: number
    store: string | null
    recordedAt: string
    notes: string | null
  }): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO ingredient_price_history
             (household_id, ingredient_id, price_eur, quantity_g, store, recorded_at, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          this.householdId,
          entry.ingredientId,
          entry.priceEur,
          entry.quantityG,
          entry.store,
          entry.recordedAt,
          entry.notes,
        ),
      this.db
        .prepare(
          // Le NOT EXISTS est borne lui aussi : un releve plus recent chez le
          // voisin empecherait sinon la mise a jour du prix courant ici, sans
          // qu'aucune ligne visible ne l'explique.
          `UPDATE ingredient
              SET price_eur = ?, price_quantity_g = ?, updated_at = ${NOW_SQL}
            WHERE id = ? AND household_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM ingredient_price_history
                 WHERE ingredient_id = ? AND household_id = ? AND recorded_at > ?)`,
        )
        .bind(
          entry.priceEur,
          entry.quantityG,
          entry.ingredientId,
          this.householdId,
          entry.ingredientId,
          this.householdId,
          entry.recordedAt,
        ),
    ])
  }

  /**
   * Enseignes deja rencontrees, les plus frequentes d'abord.
   *
   * Sert a proposer le magasin a l'ouverture d'une session de courses. La
   * source est l'historique de prix, donc partagee ENTRE LES TELEPHONES D'UN
   * MEME FOYER : le telephone de l'un propose les enseignes saisies par
   * l'autre. Le partage s'arrete la — les enseignes d'un autre foyer disent ou
   * il fait ses courses, ce qui ne le regarde pas.
   */
  async listStores(limit = 12): Promise<Array<{ store: string; count: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT store, COUNT(*) AS count
         FROM ingredient_price_history
         WHERE household_id = ? AND store IS NOT NULL AND TRIM(store) <> ''
         GROUP BY store ORDER BY count DESC, store LIMIT ?`,
      )
      .bind(this.householdId, limit)
      .all<{ store: string; count: number }>()
    return results
  }

  /**
   * Supprime une observation, puis RECALCULE le prix courant.
   *
   * L'oubli du recalcul est la faute qui ne se voit pas : effacer le releve le
   * plus recent laissait la fiche afficher un prix que plus aucune ligne de
   * l'historique ne justifie. Le cache doit toujours refleter le dernier
   * releve restant — ou redevenir vide quand il n'en reste aucun.
   */
  async deletePriceObservation(id: number): Promise<boolean> {
    // La lecture prealable est aussi le controle d'appartenance : un releve
    // d'un autre foyer ne rend rien, et l'on repart sur un 404 plutot que de
    // supprimer chez lui.
    const row = await this.db
      .prepare('SELECT ingredient_id FROM ingredient_price_history WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .first<{ ingredient_id: number }>()
    if (!row) return false

    await this.db.batch([
      this.db
        .prepare('DELETE FROM ingredient_price_history WHERE id = ? AND household_id = ?')
        .bind(id, this.householdId),
      // Les deux sous-requetes s'evaluent APRES le DELETE : D1 execute les
      // requetes d'un batch dans l'ordre. Sans ligne restante, elles rendent
      // NULL et le prix s'efface, ce qui est le comportement voulu — encore
      // faut-il qu'elles ne voient que l'historique de ce foyer, sinon le prix
      // repris serait celui du voisin.
      this.db
        .prepare(
          `UPDATE ingredient SET
             price_eur = (SELECT price_eur FROM ingredient_price_history
                           WHERE ingredient_id = ? AND household_id = ?
                           ORDER BY recorded_at DESC, id DESC LIMIT 1),
             price_quantity_g = (SELECT quantity_g FROM ingredient_price_history
                                  WHERE ingredient_id = ? AND household_id = ?
                                  ORDER BY recorded_at DESC, id DESC LIMIT 1),
             updated_at = ${NOW_SQL}
           WHERE id = ? AND household_id = ?`,
        )
        .bind(
          row.ingredient_id,
          this.householdId,
          row.ingredient_id,
          this.householdId,
          row.ingredient_id,
          this.householdId,
        ),
    ])

    return true
  }
}

/** `id, name, ...` -> `i.id, i.name, ...` pour les requetes avec alias. */
function prefixed(alias: string): string {
  return INGREDIENT_COLUMNS.split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ')
}
