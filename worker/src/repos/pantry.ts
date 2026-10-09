/**
 * Frigo et cellier.
 *
 * Un ingredient peut avoir PLUSIEURS lots, chacun avec sa peremption : deux
 * briques de lait ouvertes a une semaine d'ecart ne sont pas interchangeables.
 * Les totaux par ingredient (pour la liste de courses) agregent donc les lots.
 */

import type { PantryMovementReason, PantryStock, StorageSpace } from '@prandia/shared'

import { toPantryStock, type PantryStockRow } from '../rows.js'
import { NOW_SQL } from './sql.js'

const STOCK_COLUMNS =
  'id, ingredient_id, quantity_g, expiry_date, storage, storage_since, unit, notes, added_at, updated_at'

export class PantryRepo {
  constructor(
    private readonly db: D1Database,
    private readonly householdId: number,
  ) {}

  async list(): Promise<PantryStock[]> {
    const { results } = await this.db
      .prepare(
        // NULL en dernier : un stock sans date de peremption n'est pas urgent.
        `SELECT ${STOCK_COLUMNS} FROM pantry_stock
          WHERE household_id = ? ORDER BY (expiry_date IS NULL), expiry_date, id`,
      )
      .bind(this.householdId)
      .all<PantryStockRow>()
    return results.map(toPantryStock)
  }

  async get(id: number): Promise<PantryStock | null> {
    const row = await this.db
      .prepare(`SELECT ${STOCK_COLUMNS} FROM pantry_stock WHERE id = ? AND household_id = ?`)
      .bind(id, this.householdId)
      .first<PantryStockRow>()
    return row ? toPantryStock(row) : null
  }

  /**
   * Totaux par ingredient, tous lots confondus. Alimente le pre-cochage
   * « deja au frigo ».
   *
   * L'agregat porte sur toute la table : sans borne, la liste de courses
   * retrancherait le frigo du voisin de ce qu'il reste a acheter.
   */
  async totalsByIngredient(): Promise<Map<number, number>> {
    const { results } = await this.db
      .prepare(
        `SELECT ingredient_id, SUM(quantity_g) AS total FROM pantry_stock
          WHERE household_id = ? GROUP BY ingredient_id`,
      )
      .bind(this.householdId)
      .all<{ ingredient_id: number; total: number }>()
    return new Map(results.map((r) => [r.ingredient_id, r.total]))
  }

  /**
   * `storage_since` n'est ecrit QUE si le lot arrive quelque part. Un lot pose
   * sans lieu reste a ranger, et dater son sejour n'aurait pas de sens.
   */
  async add(stock: {
    ingredientId: number
    quantityG: number
    expiryDate: string | null
    storage: StorageSpace | null
    unit: string | null
    notes: string | null
  }): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO pantry_stock
           (household_id, ingredient_id, quantity_g, expiry_date, storage, storage_since, unit, notes)
         VALUES (?, ?, ?, ?, ?, ${stock.storage === null ? 'NULL' : NOW_SQL}, ?, ?) RETURNING id`,
      )
      .bind(
        this.householdId,
        stock.ingredientId,
        stock.quantityG,
        stock.expiryDate,
        stock.storage,
        stock.unit,
        stock.notes,
      )
      .first<{ id: number }>()
    if (!row) throw new Error("INSERT pantry_stock n'a rien renvoye")
    return row.id
  }

  /**
   * `storage_since` N'EST REECRIT QUE SI LE LIEU CHANGE.
   *
   * Sans cette condition, corriger une note remettrait a zero le compteur du
   * congelateur, qui est precisement ce que cet ecran affiche. Le lieu courant
   * est donc relu avant d'ecrire.
   */
  async update(
    id: number,
    stock: {
      quantityG: number
      expiryDate: string | null
      storage: StorageSpace | null
      unit: string | null
      notes: string | null
    },
  ): Promise<boolean> {
    const avant = await this.get(id)
    if (!avant) return false
    const lieuChange = avant.storage !== stock.storage

    const result = await this.db
      .prepare(
        `UPDATE pantry_stock
            SET quantity_g = ?, expiry_date = ?, storage = ?, unit = ?, notes = ?,
                storage_since = ${lieuChange ? (stock.storage === null ? 'NULL' : NOW_SQL) : 'storage_since'},
                updated_at = ${NOW_SQL}
          WHERE id = ? AND household_id = ?`,
      )
      .bind(
        stock.quantityG,
        stock.expiryDate,
        stock.storage,
        stock.unit,
        stock.notes,
        id,
        this.householdId,
      )
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * Deplacer un lot, et RIEN D'AUTRE.
   *
   * Sert au rangement en masse depuis l'onglet "A ranger", ou l'on ne veut
   * toucher ni la quantite, ni la date, ni la note, ni l'unite : un rangement
   * n'est pas une modification de fiche.
   */
  async setStorage(id: number, storage: StorageSpace | null): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pantry_stock
            SET storage = ?, storage_since = ${storage === null ? 'NULL' : NOW_SQL}, updated_at = ${NOW_SQL}
          WHERE id = ? AND household_id = ?`,
      )
      .bind(storage, id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  /**
   * Une sortie de stock, avec son motif.
   *
   * ECRITE AVANT la consommation. Si la consommation echoue ensuite, un
   * mouvement de trop vaut mieux qu'un mouvement perdu : aucun ecran ne montre
   * un mouvement isolement, ils ne servent qu'a un total, et un total legerement
   * haut se corrige alors qu'un total muet ne se voit pas.
   */
  async recordMovement(
    ingredientId: number,
    quantityG: number,
    reason: PantryMovementReason,
  ): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO pantry_movement (household_id, ingredient_id, quantity_g, reason) VALUES (?, ?, ?, ?)',
      )
      .bind(this.householdId, ingredientId, quantityG, reason)
      .run()
  }

  /** Le bilan d'une fenetre : une requete, deux nombres. */
  async movementTotals(since: string): Promise<{ consommeG: number; jeteG: number }> {
    const { results } = await this.db
      .prepare(
        `SELECT reason, SUM(quantity_g) AS g FROM pantry_movement
          WHERE household_id = ? AND at >= ? GROUP BY reason`,
      )
      .bind(this.householdId, since)
      .all<{ reason: string; g: number }>()
    const parMotif = new Map(results.map((r) => [r.reason, r.g]))
    return { consommeG: parMotif.get('consomme') ?? 0, jeteG: parMotif.get('jete') ?? 0 }
  }

  /**
   * Consomme une quantite sur un lot.
   *
   * Le lot est supprime si la consommation le vide ou le depasse : la table a
   * un CHECK (quantity_g > 0), donc un UPDATE a zero echouerait. Rend la
   * quantite restante, ou `null` si le lot a disparu.
   *
   * Le `get` prealable est cloisonne : un lot etranger sort ici, avant toute
   * ecriture. Le filtre est repete sur l'UPDATE malgre tout — D1 n'a pas de
   * transaction interactive, donc rien ne garantit que la lecture et
   * l'ecriture voient la meme ligne.
   */
  async consume(id: number, amountG: number): Promise<{ removed: boolean; remainingG: number | null }> {
    const current = await this.get(id)
    if (!current) return { removed: false, remainingG: null }

    const remaining = current.quantityG - amountG
    if (remaining <= 0) {
      await this.delete(id)
      return { removed: true, remainingG: null }
    }

    await this.db
      .prepare(
        `UPDATE pantry_stock SET quantity_g = ?, updated_at = ${NOW_SQL}
          WHERE id = ? AND household_id = ?`,
      )
      .bind(remaining, id, this.householdId)
      .run()
    return { removed: false, remainingG: remaining }
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM pantry_stock WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }
}
