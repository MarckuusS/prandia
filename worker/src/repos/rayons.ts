/**
 * Rayons : lecture et ecriture de `category_definition`.
 *
 * DEUX FAITS A GARDER EN TETE, sans quoi ce fichier parait tortueux :
 *
 * 1. `ingredient.category_l1` est du TEXTE, pas une cle etrangere. Le lien
 *    entre un ingredient et son rayon est le NOM, ce qui vient du desktop et
 *    n'a pas ete change au portage. Consequence directe : renommer un rayon
 *    oblige a repercuter le nouveau nom sur les ingredients, et supprimer un
 *    rayon oblige a effacer le leur. Aucune contrainte de base ne le fera a
 *    notre place.
 *
 * 2. La table porte encore `parent_id`, heritage de la hierarchie L1/L2 des
 *    seeds CIQUAL. L'interface n'expose QUE les racines (`parent_id IS NULL`).
 *    Les sous-categories heritees dorment en base sans gener personne ; les
 *    effacer ferait perdre l'information sans rien apporter.
 */

import type { D1Database } from '@cloudflare/workers-types'

import { NOW_SQL } from './sql.js'

export interface RayonRow {
  readonly id: number
  readonly name: string
  readonly icon: string | null
  readonly colorHex: string | null
  readonly ordinal: number
  /** Nombre d'ingredients qui portent ce nom de rayon. */
  readonly ingredientCount: number
}

export class RayonRepo {
  constructor(
    private readonly db: D1Database,
    private readonly householdId: number,
  ) {}

  /**
   * Les NOMS des rayons racine, et rien d'autre : ce que la completion par
   * l'IA leur demande. `list()` compte en plus les ingredients de chaque
   * rayon, ce qu'une question a Claude n'a pas a payer (voir 0021).
   */
  async noms(): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT name FROM category_definition
          WHERE household_id = ? AND parent_id IS NULL
          ORDER BY ordinal, name`,
      )
      .bind(this.householdId)
      .all<{ name: string }>()
    return results.map((r) => r.name)
  }

  /**
   * Les rayons racine, avec leur effectif.
   *
   * Le compte est une sous-requete bornee au foyer : sans le `household_id`
   * interne, il annoncerait les ingredients de toutes les cuisines. Meme piege
   * que dans `listTags`, et meme reponse.
   */
  async list(): Promise<RayonRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color_hex, c.ordinal,
                (SELECT COUNT(*) FROM ingredient i
                  WHERE i.household_id = ? AND i.category_l1 = c.name) AS ingredient_count
           FROM category_definition c
          WHERE c.household_id = ? AND c.parent_id IS NULL
          ORDER BY c.ordinal, c.name`,
      )
      .bind(this.householdId, this.householdId)
      .all<{
        id: number
        name: string
        icon: string | null
        color_hex: string | null
        ordinal: number
        ingredient_count: number
      }>()

    return results.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      colorHex: r.color_hex,
      ordinal: r.ordinal,
      ingredientCount: r.ingredient_count,
    }))
  }

  /** Un rayon racine portant ce nom, quel que soit son identifiant. */
  async findByName(name: string): Promise<{ id: number; name: string } | null> {
    return await this.db
      .prepare(
        `SELECT id, name FROM category_definition
          WHERE household_id = ? AND parent_id IS NULL AND name = ?`,
      )
      .bind(this.householdId, name)
      .first<{ id: number; name: string }>()
  }

  async create(name: string, icon: string | null, colorHex: string | null, ordinal: number): Promise<number> {
    const row = await this.db
      .prepare(
        `INSERT INTO category_definition (household_id, name, parent_id, ordinal, icon, color_hex)
         VALUES (?, ?, NULL, ?, ?, ?) RETURNING id`,
      )
      .bind(this.householdId, name, ordinal, icon, colorHex)
      .first<{ id: number }>()
    if (!row) throw new Error("INSERT category_definition n'a rien renvoye")
    return row.id
  }

  /** Nom actuel d'un rayon racine, ou `null` s'il n'existe pas dans ce foyer. */
  async nameOf(id: number): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT name FROM category_definition
          WHERE id = ? AND household_id = ? AND parent_id IS NULL`,
      )
      .bind(id, this.householdId)
      .first<{ name: string }>()
    return row?.name ?? null
  }

  /**
   * Met a jour un rayon et REPERCUTE le renommage sur les ingredients.
   *
   * Les deux ecritures partent en lot : D1 execute un `batch` dans une seule
   * transaction implicite. Les separer laisserait, en cas de coupure entre les
   * deux, un rayon renomme dont plus aucun ingredient ne porte le nom — donc
   * une section vide et des ingredients orphelins.
   */
  async update(
    id: number,
    previousName: string,
    next: { name: string; icon: string | null; colorHex: string | null; ordinal: number },
  ): Promise<void> {
    const statements = [
      this.db
        .prepare(
          `UPDATE category_definition SET name = ?, icon = ?, color_hex = ?, ordinal = ?
            WHERE id = ? AND household_id = ?`,
        )
        .bind(next.name, next.icon, next.colorHex, next.ordinal, id, this.householdId),
    ]

    if (next.name !== previousName) {
      statements.push(
        this.db
          .prepare('UPDATE ingredient SET category_l1 = ? WHERE household_id = ? AND category_l1 = ?')
          .bind(next.name, this.householdId, previousName),
      )
    }

    await this.db.batch(statements)
  }

  /**
   * Supprime un rayon et laisse ses ingredients SANS rayon.
   *
   * Reprise telle quelle du desktop (`CategoryRepo.delete`) : aucun ingredient
   * n'est supprime, ils retombent sur la cagette. Le `DELETE` emporte au
   * passage les sous-categories heritees, par la cascade de `parent_id`.
   */
  async remove(id: number, name: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare('UPDATE ingredient SET category_l1 = NULL WHERE household_id = ? AND category_l1 = ?')
        .bind(this.householdId, name),
      this.db
        .prepare('DELETE FROM category_definition WHERE id = ? AND household_id = ?')
        .bind(id, this.householdId),
    ])
  }

  /**
   * Cree un rayon ET y range des produits de la bibliotheque, en un lot :
   * D1 execute un `batch` dans une seule transaction, et un rayon cree sans
   * ses produits laisserait une section vide sans rien pour dire pourquoi.
   * Seuls les produits de la BIBLIOTHEQUE bougent : un identifiant du
   * catalogue ou d'une autre cuisine ne trouve aucune ligne.
   */
  async creerAvecProduits(name: string, ordinal: number, ids: readonly number[]): Promise<{ id: number; ranges: number }> {
    const [cree, range] = await this.db.batch<{ id: number }>([
      this.db
        .prepare(
          `INSERT INTO category_definition (household_id, name, parent_id, ordinal, icon, color_hex)
           VALUES (?, ?, NULL, ?, NULL, NULL) RETURNING id`,
        )
        .bind(this.householdId, name, ordinal),
      // `+household_id` : la cle primaire d'abord, comme `byIds` (0021).
      this.db
        .prepare(
          `UPDATE ingredient SET category_l1 = ?, updated_at = ${NOW_SQL}
            WHERE id IN (${ids.map(() => '?').join(', ')}) AND +household_id = ? AND in_personal_library = 1
            RETURNING id`,
        )
        .bind(name, ...ids, this.householdId),
    ])
    const id = cree?.results[0]?.id
    if (id === undefined) throw new Error("INSERT category_definition n'a rien renvoye")
    // Les lignes RENDUES, pas `meta.changes` : en local il comptait aussi les
    // ecritures des declencheurs de l'index de recherche (5 pour un produit).
    return { id, ranges: range?.results.length ?? 0 }
  }

  /** Rang le plus eleve, pour poser un nouveau rayon a la fin. */
  async maxOrdinal(): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS m FROM category_definition
          WHERE household_id = ? AND parent_id IS NULL`,
      )
      .bind(this.householdId)
      .first<{ m: number }>()
    return row?.m ?? -1
  }
}
