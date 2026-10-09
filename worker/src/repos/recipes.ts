/**
 * Recettes : en-tete, lignes d'ingredients, tags, journal de cuisson.
 *
 * Une recette est sauvegardee d'un bloc. Les lignes et les tags sont
 * REMPLACES integralement, jamais reconcilies ligne a ligne : le formulaire
 * envoie l'etat complet qu'il affiche, et un diff cote serveur reintroduirait
 * les conflits d'ordre que le desktop reglait deja par un remplacement total.
 *
 * ---------------------------------------------------------------------------
 * `recipe_ingredient` ET `recipe_tag` NE PORTENT PAS LE FOYER
 * ---------------------------------------------------------------------------
 * Elles n'existent que par leur recette (migrations/0005_households.sql). Cela
 * ne les protege QUE si la requete parente filtre : une liste d'identifiants
 * de recettes obtenue sans filtre rendrait leurs lignes. Chaque acces a ces
 * deux tables passe donc par un `IN (SELECT id FROM recipe WHERE ... AND
 * household_id = ?)` plutot que par les identifiants bruts de l'appelant.
 */

import { ZERO_NUTRITION, aggregateRecipe, type NutritionTotal, type Recipe, type RecipeWrite } from '@prandia/shared'

import { toRecipeShell, toTag, type RecipeRow, type TagRow } from '../rows.js'
import { IngredientRepo } from './ingredients.js'
import { NOW_SQL, placeholders } from './sql.js'

// La charge utile d'ecriture est definie dans `shared/src/models.ts`, aux
// cotes du schema Zod qui la valide : un seul endroit ou la faire evoluer.
export type { RecipeLineWrite, RecipeWrite } from '@prandia/shared'

export interface RecipeSummary {
  readonly id: number
  readonly name: string
  readonly defaultPortions: number
  readonly imageKey: string | null
  readonly lineCount: number
  readonly prepTimeMin: number | null
  readonly tags: ReadonlyArray<{ id: number; name: string; colorHex: string }>
  readonly lastCookedAt: string | null
  /**
   * Cuissons des 30 derniers jours GLISSANTS.
   *
   * Le libelle doit dire la fenetre. Un total de vie et un compteur mensuel se
   * ressemblent a l'ecran et ne racontent pas la meme chose : « 14 fois » se
   * lit comme une habitude installee, « 14 fois ce mois-ci » comme une lubie.
   */
  readonly cookCount30d: number
  /**
   * Nutrition de la recette ENTIERE, agregee par `aggregateRecipe`.
   *
   * Calculee ici et non en SQL, bien qu'un `SUM` eut suffi : la regle du
   * projet veut qu'une seule fonction produise un total nutritionnel, sans
   * quoi le chiffre du telephone et celui de la liste de courses finiraient
   * par diverger d'un arrondi.
   */
  readonly nutrition: NutritionTotal
  /**
   * Les lignes, reduites a ce que le croisement avec le frigo demande.
   *
   * Deux nombres par ligne, pas la fiche complete de l'ingredient : la liste
   * n'a pas besoin de ses macros, elle a besoin de savoir s'il en manque.
   */
  readonly lines: ReadonlyArray<{ readonly ingredientId: number; readonly quantityG: number }>
}

export class RecipeRepo {
  constructor(
    private readonly db: D1Database,
    private readonly householdId: number,
    private readonly ingredients: IngredientRepo,
  ) {}

  // ------------------------------------------------------------------ lecture

  /**
   * Recettes completes, lignes et tags compris, en 4 requetes quel que soit
   * le nombre de recettes demandees.
   *
   * Les identifiants viennent de l'appelant — donc, en bout de chaine, d'une
   * URL. C'est le point d'entree le plus expose du fichier : les trois requetes
   * ci-dessous se bornent chacune au foyer, y compris celles qui visent des
   * tables enfants sans colonne `household_id`.
   */
  async byIds(ids: Iterable<number>): Promise<Map<number, Recipe>> {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return new Map()
    const marks = placeholders(unique.length)

    // Sous-requete commune aux deux tables enfants : elle reduit les
    // identifiants demandes a ceux qui appartiennent reellement au foyer.
    const ownRecipes = `SELECT id FROM recipe WHERE id IN (${marks}) AND household_id = ?`

    const [recipeRows, lineRows, tagRows] = await Promise.all([
      this.db
        .prepare(`SELECT * FROM recipe WHERE id IN (${marks}) AND household_id = ?`)
        .bind(...unique, this.householdId)
        .all<RecipeRow>(),
      this.db
        .prepare(
          `SELECT recipe_id, ingredient_id, ordinal, quantity_g, notes, unit
           FROM recipe_ingredient WHERE recipe_id IN (${ownRecipes}) ORDER BY recipe_id, ordinal`,
        )
        .bind(...unique, this.householdId)
        .all<{
          recipe_id: number
          ingredient_id: number
          ordinal: number
          quantity_g: number
          notes: string | null
          unit: string | null
        }>(),
      this.db
        .prepare(
          // Le foyer est lie DEUX fois, et l'ordre compte : le premier `?` est
          // celui de la jointure (il precede textuellement), le second celui de
          // la sous-requete du WHERE, apres les identifiants.
          `SELECT rt.recipe_id, t.id, t.name, t.color_hex, t.created_at
           FROM recipe_tag rt JOIN tag t ON t.id = rt.tag_id AND t.household_id = ?
           WHERE rt.recipe_id IN (${ownRecipes}) ORDER BY t.name`,
        )
        .bind(this.householdId, ...unique, this.householdId)
        .all<TagRow & { recipe_id: number }>(),
    ])

    // Les ingredients des lignes, en une requete de plus.
    const ingredients = await this.ingredients.byIds(lineRows.results.map((l) => l.ingredient_id))

    const recipes = new Map(recipeRows.results.map((r) => [r.id, toRecipeShell(r)]))

    for (const l of lineRows.results) {
      const recipe = recipes.get(l.recipe_id)
      const ingredient = ingredients.get(l.ingredient_id)
      // Ligne orpheline : l'ingredient a disparu. On saute plutot que de
      // fabriquer un ingredient vide qui fausserait nutrition et cout.
      if (!recipe || !ingredient) continue
      ;(recipe.lines as Recipe['lines']).push({
        ingredient,
        quantityG: l.quantity_g,
        unit: l.unit,
        notes: l.notes,
        ordinal: l.ordinal,
      })
    }

    for (const t of tagRows.results) {
      recipes.get(t.recipe_id)?.tags.push(toTag(t))
    }

    return recipes
  }

  async get(id: number): Promise<Recipe | null> {
    return (await this.byIds([id])).get(id) ?? null
  }

  /**
   * Liste pour l'ecran principal.
   *
   * `cook_count_30d` est calcule en SQL sur une fenetre glissante de 30 jours
   * — la meme que le desktop. Le faire cote client obligerait a rapatrier tout
   * le journal de cuisson pour n'en afficher qu'un compteur.
   */
  async listSummaries(options: { query?: string | null; tagId?: number | null } = {}): Promise<RecipeSummary[]> {
    const { query = null, tagId = null } = options

    // Le foyer ouvre la clause : la liste des recettes n'est jamais non filtree.
    const where: string[] = ['r.household_id = ?']
    const args: unknown[] = [this.householdId]

    if (query && query.trim()) {
      /*
       * Le nom de la recette OU celui d'un de ses ingredients.
       *
       * « courgette » ne remontait que les recettes dont le titre portait le
       * mot ; c'est pourtant en cherchant un ingredient qu'on ecoule ce qu'on
       * a. Pas de FTS : la table `ingredient_fts` ne couvre que les
       * ingredients, et un LIKE sur les recettes d'un foyer se compte en
       * dizaines de lignes.
       */
      where.push(
        `(LOWER(r.name) LIKE ?
          OR EXISTS (SELECT 1 FROM recipe_ingredient ri
                       JOIN ingredient i ON i.id = ri.ingredient_id
                      WHERE ri.recipe_id = r.id AND LOWER(i.name) LIKE ?))`,
      )
      const motif = `%${query.trim().toLowerCase()}%`
      args.push(motif, motif)
    }
    if (tagId !== null) {
      // `recipe_tag` est couverte par sa recette : la correlation sur `r.id`
      // ne peut designer qu'une recette deja retenue par le WHERE ci-dessus.
      where.push('EXISTS (SELECT 1 FROM recipe_tag rt WHERE rt.recipe_id = r.id AND rt.tag_id = ?)')
      args.push(tagId)
    }

    const clause = `WHERE ${where.join(' AND ')}`

    const [rows, tagRows] = await Promise.all([
      this.db
        .prepare(
          // Les deux `?` des sous-requetes de la liste SELECT precedent ceux du
          // WHERE : ils sont lies en tete, avant `args`.
          // `recipe_ingredient` n'a rien a filtrer — elle est correlee a `r.id`,
          // deja borne.
          `SELECT r.id, r.name, r.default_portions, r.image_key, r.prep_time_min,
                  (SELECT COUNT(*) FROM recipe_ingredient ri WHERE ri.recipe_id = r.id) AS line_count,
                  (SELECT MAX(cooked_at) FROM recipe_cooking_log cl
                    WHERE cl.recipe_id = r.id AND cl.household_id = ?) AS last_cooked_at,
                  (SELECT COUNT(*) FROM recipe_cooking_log cl
                    WHERE cl.recipe_id = r.id AND cl.household_id = ?
                      AND cl.cooked_at >= date('now','-30 day')) AS cook_count_30d
           FROM recipe r ${clause} ORDER BY r.name`,
        )
        .bind(this.householdId, this.householdId, ...args)
        .all<{
          id: number
          name: string
          default_portions: number
          image_key: string | null
          prep_time_min: number | null
          line_count: number
          last_cooked_at: string | null
          cook_count_30d: number
        }>(),
      this.db
        .prepare(
          // Cette requete-ci n'avait AUCUNE clause WHERE : elle balayait les
          // associations recette/tag de toute la base. Les deux bornes sont
          // volontairement redondantes — le tag et la recette doivent l'un et
          // l'autre etre du foyer pour que l'association soit rendue.
          `SELECT rt.recipe_id, t.id, t.name, t.color_hex
           FROM recipe_tag rt JOIN tag t ON t.id = rt.tag_id
           WHERE t.household_id = ?
             AND rt.recipe_id IN (SELECT id FROM recipe WHERE household_id = ?)
           ORDER BY t.name`,
        )
        .bind(this.householdId, this.householdId)
        .all<{ recipe_id: number; id: number; name: string; color_hex: string }>(),
    ])

    const tagsByRecipe = new Map<number, Array<{ id: number; name: string; colorHex: string }>>()
    for (const t of tagRows.results) {
      const list = tagsByRecipe.get(t.recipe_id) ?? []
      list.push({ id: t.id, name: t.name, colorHex: t.color_hex })
      tagsByRecipe.set(t.recipe_id, list)
    }

    /*
     * Les recettes completes des lignes retenues, pour en tirer la nutrition
     * et les lignes compactes. `byIds` est deja ecrit et deja teste ; le
     * reecrire en SQL agrege aurait fait une SECONDE implementation du total
     * nutritionnel, ce que le projet interdit.
     */
    const completes = await this.byIds(rows.results.map((r) => r.id))

    return rows.results.map((r) => {
      const complete = completes.get(r.id)
      const agrege =
        complete === undefined
          ? null
          : aggregateRecipe({ lines: complete.lines, defaultPortions: complete.defaultPortions })
      return {
        id: r.id,
        name: r.name,
        defaultPortions: r.default_portions,
        imageKey: r.image_key,
        lineCount: r.line_count,
        prepTimeMin: r.prep_time_min,
        tags: tagsByRecipe.get(r.id) ?? [],
        lastCookedAt: r.last_cooked_at,
        cookCount30d: r.cook_count_30d,
        nutrition: agrege?.total ?? ZERO_NUTRITION,
        lines: (complete?.lines ?? [])
          .filter((l) => l.ingredient.id !== null)
          .map((l) => ({ ingredientId: l.ingredient.id as number, quantityG: l.quantityG })),
      }
    })
  }

  // ------------------------------------------------------------------ ecriture

  async create(payload: RecipeWrite): Promise<number> {
    const row = await this.db
      .prepare(
        // `image_key` n'est pas dans cette liste : une recette nait sans photo,
        // et seule `setImageKey` ecrit cette colonne. Voir `recipeWriteSchema`.
        `INSERT INTO recipe (household_id, name, instructions, default_portions, source_url, prep_time_min)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(
        this.householdId,
        payload.name,
        payload.instructions,
        payload.defaultPortions,
        payload.sourceUrl,
        payload.prepTimeMin,
      )
      .first<{ id: number }>()

    if (!row) throw new Error("INSERT recipe n'a rien renvoye")
    await this.replaceChildren(row.id, payload)
    return row.id
  }

  /**
   * Ecrit la cle de photo, et elle seule.
   *
   * SEPAREE DE `update` parce que la photo est une sous-ressource : elle
   * s'enregistre toute seule au moment ou on la choisit, sans passer par le
   * tampon d'edition. Voir `recipeWriteSchema` pour les trois raisons.
   *
   * `AND household_id = ?` n'est pas decoratif : c'est le SEUL controle
   * d'appartenance de l'ecriture, et R2 n'en a aucun de son cote.
   *
   * `updated_at` N'EST PAS TOUCHE, volontairement. C'est le jeton de
   * concurrence du contenu, que le PUT remplace en bloc. Le toucher ferait
   * qu'un depot de photo depuis l'editeur invaliderait le jeton de ce meme
   * editeur : `loadedUpdatedAt` est fige au chargement, et l'enregistrement
   * suivant recevrait un 409 avec dialogue de conflit, pour une action que
   * l'utilisateur vient de faire lui-meme. Consequence assumee : la mention
   * "modifiee le" ne bouge pas quand seule la photo change.
   */
  async setImageKey(id: number, key: string | null): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE recipe SET image_key = ? WHERE id = ? AND household_id = ?')
      .bind(key, id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * L'UPDATE fait office de controle d'appartenance : s'il ne touche aucune
   * ligne, la recette n'est pas de ce foyer et `replaceChildren` n'est jamais
   * atteint. C'est ce qui interdit de reecrire les lignes d'une recette
   * etrangere en devinant son numero.
   */
  async update(id: number, payload: RecipeWrite): Promise<boolean> {
    const result = await this.db
      .prepare(
        // `image_key` ABSENTE de ce SET : elle vit hors du tampon d'edition.
        `UPDATE recipe
            SET name = ?, instructions = ?, default_portions = ?,
                source_url = ?, prep_time_min = ?, updated_at = ${NOW_SQL}
          WHERE id = ? AND household_id = ?`,
      )
      .bind(
        payload.name,
        payload.instructions,
        payload.defaultPortions,
        payload.sourceUrl,
        payload.prepTimeMin,
        id,
        this.householdId,
      )
      .run()

    if ((result.meta.changes ?? 0) === 0) return false
    await this.replaceChildren(id, payload)
    return true
  }

  /**
   * Remplace lignes et tags en un seul `batch` atomique.
   *
   * Le DELETE precede les INSERT dans le meme lot : D1 execute les requetes
   * d'un batch dans l'ordre et annule tout en cas d'echec, donc une recette ne
   * peut pas se retrouver amputee de ses lignes si un ingredient a disparu
   * entre-temps.
   */
  private async replaceChildren(recipeId: number, payload: RecipeWrite): Promise<void> {
    // Les DELETE passent par la recette plutot que par `recipe_id` brut : cette
    // methode reste ainsi sure meme si un futur appelant l'atteignait sans
    // avoir verifie l'appartenance au prealable.
    const ownRecipe = 'SELECT id FROM recipe WHERE id = ? AND household_id = ?'
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(`DELETE FROM recipe_ingredient WHERE recipe_id IN (${ownRecipe})`)
        .bind(recipeId, this.householdId),
      this.db
        .prepare(`DELETE FROM recipe_tag WHERE recipe_id IN (${ownRecipe})`)
        .bind(recipeId, this.householdId),
    ]

    // L'ordinal est reattribue depuis la position dans le tableau : c'est
    // l'ordre affiche qui fait foi, pas celui que le client a calcule.
    //
    // L'ingredient n'est PAS reverifie ici : la route l'a fait via
    // `ingredients.byIds`, qui est cloisonne, et repond 422 en nommant la ligne
    // fautive. Le faire ici ne pourrait qu'ecarter la ligne en silence, ce qui
    // amputerait une recette sans rien dire.
    payload.lines.forEach((line, index) => {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO recipe_ingredient (recipe_id, ingredient_id, ordinal, quantity_g, notes, unit)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(recipeId, line.ingredientId, index, line.quantityG, line.notes, line.unit),
      )
    })

    // Les tags, eux, passent par un SELECT : aucune route ne verifie qu'un
    // `tagIds` recu appartient bien au foyer, et un tag inconnu est sans
    // consequence — l'ignorer vaut mieux que de creer une association
    // inter-foyers dans une table qui ne porte pas la colonne.
    for (const tagId of new Set(payload.tagIds)) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO recipe_tag (recipe_id, tag_id)
             SELECT ?, id FROM tag WHERE id = ? AND household_id = ?`,
          )
          .bind(recipeId, tagId, this.householdId),
      )
    }

    await this.db.batch(statements)
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM recipe WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  /** Combien d'entrees du calendrier disparaitraient avec la recette (ON DELETE CASCADE). */
  async plannedCount(id: number): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS c FROM meal_plan_entry WHERE recipe_id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .first<{ c: number }>()
    return row?.c ?? 0
  }

  // -------------------------------------------------------- journal de cuisson

  async listCookingLog(recipeId: number): Promise<
    Array<{ id: number; recipeId: number; cookedAt: string; rating: number | null; notes: string | null; createdAt: string }>
  > {
    const { results } = await this.db
      .prepare(
        `SELECT id, recipe_id, cooked_at, rating, notes, created_at
         FROM recipe_cooking_log WHERE recipe_id = ? AND household_id = ?
         ORDER BY cooked_at DESC, id DESC`,
      )
      .bind(recipeId, this.householdId)
      .all<{ id: number; recipe_id: number; cooked_at: string; rating: number | null; notes: string | null; created_at: string }>()

    return results.map((r) => ({
      id: r.id,
      recipeId: r.recipe_id,
      cookedAt: r.cooked_at,
      rating: r.rating,
      notes: r.notes,
      createdAt: r.created_at,
    }))
  }

  async addCookingLog(entry: {
    recipeId: number
    cookedAt: string
    rating: number | null
    notes: string | null
  }): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO recipe_cooking_log (household_id, recipe_id, cooked_at, rating, notes)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(this.householdId, entry.recipeId, entry.cookedAt, entry.rating, entry.notes)
      .first<{ id: number }>()
    if (!row) throw new Error("INSERT recipe_cooking_log n'a rien renvoye")
    return row.id
  }

  async deleteCookingLog(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM recipe_cooking_log WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  // ------------------------------------------------------------------- tags

  async listTags(): Promise<Array<{ id: number; name: string; colorHex: string; recipeCount: number }>> {
    const { results } = await this.db
      .prepare(
        // Le compteur est borne separement : sans cela il annoncerait le nombre
        // de recettes utilisant ce tag DANS TOUTE LA BASE. Le `?` de la
        // sous-requete precede celui du WHERE.
        `SELECT t.id, t.name, t.color_hex,
                (SELECT COUNT(*) FROM recipe_tag rt
                  WHERE rt.tag_id = t.id
                    AND rt.recipe_id IN (SELECT id FROM recipe WHERE household_id = ?)) AS recipe_count
         FROM tag t WHERE t.household_id = ? ORDER BY t.name`,
      )
      .bind(this.householdId, this.householdId)
      .all<{ id: number; name: string; color_hex: string; recipe_count: number }>()

    return results.map((t) => ({ id: t.id, name: t.name, colorHex: t.color_hex, recipeCount: t.recipe_count }))
  }

  async createTag(name: string, colorHex: string): Promise<number> {
    const row = await this.db
      .prepare('INSERT INTO tag (household_id, name, color_hex) VALUES (?, ?, ?) RETURNING id')
      .bind(this.householdId, name, colorHex)
      .first<{ id: number }>()
    if (!row) throw new Error("INSERT tag n'a rien renvoye")
    return row.id
  }

  async updateTag(id: number, name: string, colorHex: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE tag SET name = ?, color_hex = ? WHERE id = ? AND household_id = ?')
      .bind(name, colorHex, id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async deleteTag(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM tag WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }
}
