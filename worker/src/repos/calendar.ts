/**
 * Planificateur de semaine.
 *
 * La cle naturelle est la semaine ISO (`'2026-W18'`) plus le jour (0 = lundi),
 * jamais une date. Ce choix survit aux changements d'heure et rend « cette
 * semaine » calculable sans fuseau horaire.
 */

import type { MealPlanEntry } from '@prandia/shared'

import { toMealPlanEntry, type MealPlanEntryRow } from '../rows.js'
import { NOW_SQL } from './sql.js'

const ENTRY_COLUMNS =
  'id, iso_week, day_of_week, slot, recipe_id, ingredient_id, quantity_g, portions, unit, ordinal'

export interface EntryWrite {
  readonly isoWeek: string
  readonly dayOfWeek: number
  readonly slot: string
  readonly recipeId: number | null
  readonly ingredientId: number | null
  readonly quantityG: number | null
  readonly unit: string | null
  readonly portions: number | null
}

export class CalendarRepo {
  constructor(
    private readonly db: D1Database,
    private readonly householdId: number,
  ) {}

  async listWeek(isoWeek: string): Promise<MealPlanEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM meal_plan_entry
          WHERE household_id = ? AND iso_week = ? ORDER BY day_of_week, ordinal`,
      )
      .bind(this.householdId, isoWeek)
      .all<MealPlanEntryRow>()
    return results.map(toMealPlanEntry)
  }

  /**
   * L'identifiant vient de l'URL. C'est par cette methode que les routes
   * verifient l'existence d'une entree avant de la modifier ou de la
   * supprimer : sans le filtre, deviner un numero suffirait a lire — puis a
   * effacer — le repas d'un autre foyer.
   */
  async getEntry(id: number): Promise<MealPlanEntry | null> {
    const row = await this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM meal_plan_entry WHERE id = ? AND household_id = ?`)
      .bind(id, this.householdId)
      .first<MealPlanEntryRow>()
    return row ? toMealPlanEntry(row) : null
  }

  /**
   * Ajoute une entree en fin de creneau.
   *
   * L'ordinal est calcule en SQL (`MAX + 1` sur le creneau) plutot que fourni
   * par le client : deux telephones ajoutant au meme repas produiraient sinon
   * le meme ordinal, et l'ordre d'affichage deviendrait arbitraire.
   */
  async addEntry(entry: EntryWrite): Promise<number> {
    const row = await this.db
      .prepare(
        // La sous-requete de l'ordinal est bornee elle aussi : compter les
        // entrees de tous les foyers sur ce creneau laisserait des trous dans
        // la numerotation, et revelerait au passage combien de repas le voisin
        // a prevus mardi midi.
        `INSERT INTO meal_plan_entry
           (household_id, iso_week, day_of_week, slot, recipe_id, ingredient_id, quantity_g, portions, unit, ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM meal_plan_entry
             WHERE household_id = ? AND iso_week = ? AND day_of_week = ? AND slot = ?))
         RETURNING id`,
      )
      .bind(
        this.householdId,
        entry.isoWeek,
        entry.dayOfWeek,
        entry.slot,
        entry.recipeId,
        entry.ingredientId,
        entry.quantityG,
        entry.portions,
        entry.unit,
        this.householdId,
        entry.isoWeek,
        entry.dayOfWeek,
        entry.slot,
      )
      .first<{ id: number }>()

    if (!row) throw new Error("INSERT meal_plan_entry n'a rien renvoye")
    return row.id
  }

  /** Change la quantite ou le nombre de portions d'une entree existante. */
  async updateAmount(
    id: number,
    quantityG: number | null,
    portions: number | null,
    unit: string | null,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        'UPDATE meal_plan_entry SET quantity_g = ?, portions = ?, unit = ? WHERE id = ? AND household_id = ?',
      )
      .bind(quantityG, portions, unit, id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  /** Deplace une entree vers un autre jour ou creneau, en fin de destination. */
  async moveEntry(id: number, dayOfWeek: number, slot: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        // Meme remarque que pour `addEntry` sur le calcul de l'ordinal.
        `UPDATE meal_plan_entry
            SET day_of_week = ?, slot = ?,
                ordinal = (SELECT COALESCE(MAX(ordinal), -1) + 1 FROM meal_plan_entry m
                            WHERE m.household_id = ?
                              AND m.iso_week = meal_plan_entry.iso_week
                              AND m.day_of_week = ? AND m.slot = ? AND m.id <> ?)
          WHERE id = ? AND household_id = ?`,
      )
      .bind(dayOfWeek, slot, this.householdId, dayOfWeek, slot, id, id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async deleteEntry(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM meal_plan_entry WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async clearDay(isoWeek: string, dayOfWeek: number): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM meal_plan_entry WHERE household_id = ? AND iso_week = ? AND day_of_week = ?')
      .bind(this.householdId, isoWeek, dayOfWeek)
      .run()
    return result.meta.changes ?? 0
  }

  async clearWeek(isoWeek: string): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM meal_plan_entry WHERE household_id = ? AND iso_week = ?')
      .bind(this.householdId, isoWeek)
      .run()
    return result.meta.changes ?? 0
  }

  /**
   * Recopie une semaine vers une autre.
   *
   * La destination est videe d'abord, dans le meme batch : sans cela, copier
   * deux fois de suite doublerait tous les repas.
   */
  async copyWeek(from: string, to: string): Promise<number> {
    const source = await this.listWeek(from)
    if (source.length === 0) return 0

    // Le DELETE de la destination est borne : recopier une semaine ne doit pas
    // vider celle du voisin.
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare('DELETE FROM meal_plan_entry WHERE household_id = ? AND iso_week = ?')
        .bind(this.householdId, to),
    ]

    for (const e of source) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO meal_plan_entry
               (household_id, iso_week, day_of_week, slot, recipe_id, ingredient_id, quantity_g, portions, unit, ordinal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            this.householdId,
            to,
            e.dayOfWeek,
            e.slot,
            e.recipeId,
            e.ingredientId,
            e.quantityG,
            e.portions,
            e.unit,
            e.ordinal,
          ),
      )
    }

    await this.db.batch(statements)
    return source.length
  }

  // -------------------------------------------------------------- modeles

  async listTemplates(): Promise<Array<{ id: number; name: string; entryCount: number; updatedAt: string }>> {
    const { results } = await this.db
      .prepare(
        `SELECT id, name, snapshot_json, updated_at FROM meal_plan_template
          WHERE household_id = ? ORDER BY name`,
      )
      .bind(this.householdId)
      .all<{ id: number; name: string; snapshot_json: string; updated_at: string }>()

    return results.map((t) => {
      let entryCount = 0
      try {
        const parsed: unknown = JSON.parse(t.snapshot_json)
        entryCount = Array.isArray(parsed) ? parsed.length : 0
      } catch {
        // Un instantane illisible ne doit pas faire echouer la liste entiere.
        entryCount = 0
      }
      return { id: t.id, name: t.name, entryCount, updatedAt: t.updated_at }
    })
  }

  /** Enregistre la semaine courante comme modele reutilisable. */
  async saveTemplate(name: string, isoWeek: string): Promise<number> {
    const entries = await this.listWeek(isoWeek)
    const snapshot = entries.map((e) => ({
      dayOfWeek: e.dayOfWeek,
      slot: e.slot,
      recipeId: e.recipeId,
      ingredientId: e.ingredientId,
      quantityG: e.quantityG,
      portions: e.portions,
      ordinal: e.ordinal,
    }))

    const row = await this.db
      .prepare(
        // La cible du ON CONFLICT suit l'index `ix_template_unique`, devenu
        // (household_id, name) en 0005 : deux foyers doivent pouvoir nommer
        // « Semaine type » chacun le leur. Laisser `(name)` seul ferait echouer
        // la requete — SQLite exige que la cible corresponde a une contrainte.
        `INSERT INTO meal_plan_template (household_id, name, snapshot_json) VALUES (?, ?, ?)
         ON CONFLICT(household_id, name) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = ${NOW_SQL}
         RETURNING id`,
      )
      .bind(this.householdId, name, JSON.stringify(snapshot))
      .first<{ id: number }>()

    if (!row) throw new Error("INSERT meal_plan_template n'a rien renvoye")
    return row.id
  }

  /** Applique un modele sur une semaine, en remplacant son contenu. */
  async applyTemplate(id: number, isoWeek: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT snapshot_json FROM meal_plan_template WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .first<{ snapshot_json: string }>()
    if (!row) return -1

    let snapshot: Array<Record<string, unknown>> = []
    try {
      const parsed: unknown = JSON.parse(row.snapshot_json)
      if (Array.isArray(parsed)) snapshot = parsed as Array<Record<string, unknown>>
    } catch {
      return -1
    }

    const statements: D1PreparedStatement[] = [
      this.db
        .prepare('DELETE FROM meal_plan_entry WHERE household_id = ? AND iso_week = ?')
        .bind(this.householdId, isoWeek),
    ]

    for (const e of snapshot) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO meal_plan_entry
               (household_id, iso_week, day_of_week, slot, recipe_id, ingredient_id, quantity_g, portions, unit, ordinal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            this.householdId,
            isoWeek,
            e['dayOfWeek'] ?? 0,
            e['slot'] ?? 'noon',
            e['recipeId'] ?? null,
            e['ingredientId'] ?? null,
            e['quantityG'] ?? null,
            e['portions'] ?? null,
            typeof e['unit'] === 'string' ? e['unit'] : null,
            e['ordinal'] ?? 0,
          ),
      )
    }

    await this.db.batch(statements)
    return snapshot.length
  }

  async deleteTemplate(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM meal_plan_template WHERE id = ? AND household_id = ?')
      .bind(id, this.householdId)
      .run()
    return (result.meta.changes ?? 0) > 0
  }
}
