/**
 * Les plats cuisines (migration 0022, shared/src/preparation.ts).
 *
 * Cuisiner ecrit a beaucoup d'endroits a la fois : le plat et ses lignes, la
 * reference de sa fiche, son lot au frigo, les ingredients qui en sortent, le
 * repas qui devient une part, le journal de la recette. D1 n'a pas de
 * transaction interactive, mais un `batch` s'execute EN UNE transaction : tout
 * part, ou rien. Seule la fiche du plat est creee avant (il faut son
 * identifiant), et retiree par l'appelant si le lot echoue.
 */

import { PLAT_REF_PREFIXE, type SortieDuFrigo } from '@prandia/shared'

import { NOW_SQL } from './sql.js'

export interface PlatAEnregistrer {
  /** La fiche du plat, deja creee. */
  readonly ingredientId: number
  readonly recipeId: number | null
  readonly cookedOn: string
  readonly cookedWeightG: number
  readonly parts: number | null
  readonly lignes: ReadonlyArray<{
    readonly ingredientId: number
    readonly name: string
    readonly quantityG: number
    readonly unit: string | null
  }>
  /** Ce qui reste du plat, au frigo ; `null` quand tout est mange tout de suite. */
  readonly lot: { readonly quantityG: number; readonly expiryDate: string | null } | null
  readonly sorties: readonly SortieDuFrigo[]
  /** Le repas du planning qui devient une part du plat. */
  readonly part: { readonly entryId: number; readonly quantityG: number; readonly unit: string | null } | null
}

export class PreparationRepo {
  constructor(
    private readonly db: D1Database,
    private readonly householdId: number,
  ) {}

  async enregistrer(plat: PlatAEnregistrer): Promise<number> {
    const h = this.householdId
    // L'identifiant du plat n'existe qu'une fois insere : les ecritures
    // suivantes le retrouvent par sa fiche, qui est UNIQUE.
    const idDuPlat = '(SELECT id FROM preparation WHERE ingredient_id = ? AND household_id = ?)'
    const ecritures: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO preparation (household_id, ingredient_id, recipe_id, cooked_on, cooked_weight_g, parts)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(h, plat.ingredientId, plat.recipeId, plat.cookedOn, plat.cookedWeightG, plat.parts),
      ...plat.lignes.map((l, ordinal) =>
        this.db
          .prepare(
            `INSERT INTO preparation_line (preparation_id, ingredient_id, name, quantity_g, unit, ordinal)
             VALUES (${idDuPlat}, ?, ?, ?, ?, ?)`,
          )
          .bind(plat.ingredientId, h, l.ingredientId, l.name, l.quantityG, l.unit, ordinal),
      ),
      // La fiche se reconnait comme un plat (`estUnPlat`), et sa place est le frigo.
      this.db
        .prepare(
          `UPDATE ingredient SET source_ref = '${PLAT_REF_PREFIXE}' || ${idDuPlat}, usual_storage = 'frigo'
            WHERE id = ? AND +household_id = ?`,
        )
        .bind(plat.ingredientId, h, plat.ingredientId, h),
    ]

    if (plat.lot !== null) {
      ecritures.push(
        this.db
          .prepare(
            `INSERT INTO pantry_stock (household_id, ingredient_id, quantity_g, expiry_date, storage, storage_since)
             VALUES (?, ?, ?, ?, 'frigo', ${NOW_SQL})`,
          )
          .bind(h, plat.ingredientId, plat.lot.quantityG, plat.lot.expiryDate),
      )
    }

    // Ce qui a servi sort du frigo, avec son motif : consomme.
    for (const s of plat.sorties) {
      ecritures.push(
        this.db
          .prepare("INSERT INTO pantry_movement (household_id, ingredient_id, quantity_g, reason) VALUES (?, ?, ?, 'consomme')")
          .bind(h, s.ingredientId, s.quantityG),
        s.vide
          ? this.db.prepare('DELETE FROM pantry_stock WHERE id = ? AND household_id = ?').bind(s.lotId, h)
          : this.db
              .prepare(
                `UPDATE pantry_stock SET quantity_g = quantity_g - ?, updated_at = ${NOW_SQL}
                  WHERE id = ? AND household_id = ? AND quantity_g > ?`,
              )
              .bind(s.quantityG, s.lotId, h, s.quantityG),
      )
    }

    // Le repas qui a lance la cuisson devient une part du plat. Le CHECK XOR de
    // la table tient : recette retiree, ingredient et grammes poses ensemble.
    if (plat.part !== null) {
      ecritures.push(
        this.db
          .prepare(
            `UPDATE meal_plan_entry
                SET recipe_id = NULL, portions = NULL, ingredient_id = ?, quantity_g = ?, unit = ?
              WHERE id = ? AND household_id = ? AND recipe_id IS NOT NULL`,
          )
          .bind(plat.ingredientId, plat.part.quantityG, plat.part.unit, plat.part.entryId, h),
      )
    }

    // Le journal de la recette garde la date, comme "J'ai cuisine" le faisait.
    if (plat.recipeId !== null) {
      ecritures.push(
        this.db
          .prepare('INSERT INTO recipe_cooking_log (household_id, recipe_id, cooked_at) VALUES (?, ?, ?)')
          .bind(h, plat.recipeId, plat.cookedOn),
      )
    }

    await this.db.batch(ecritures)
    const row = await this.db
      .prepare('SELECT id FROM preparation WHERE ingredient_id = ? AND household_id = ?')
      .bind(plat.ingredientId, h)
      .first<{ id: number }>()
    if (!row) throw new Error("Le plat n'a pas ete enregistre")
    return row.id
  }
}
