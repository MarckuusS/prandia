/**
 * Journal d'activite : qui a ajoute, modifie ou supprime quoi.
 *
 * Deux personnes partagent la meme cuisine. Sans trace, une recette qui change
 * ou un stock qui disparait devient une devinette — et une source de friction
 * bien plus surement qu'un bug.
 *
 * Regle a tenir : le `label` est fige AU MOMENT DE L'ACTION. Apres une
 * suppression, `entityId` ne designe plus rien ; rejouer une jointure pour
 * afficher le nom donnerait une ligne vide. « a supprimé Chili con carne »
 * doit rester lisible trois mois plus tard.
 *
 * ---------------------------------------------------------------------------
 * Le journal est cloisonne comme le reste, et pour une raison de plus : ces
 * libelles figes sont des NOMS DE RECETTES ET DE PRODUITS. Un journal commun
 * raconterait a chaque foyer ce que les autres cuisinent, achetent et jettent —
 * l'ecran le plus bavard de l'application.
 *
 * Ces deux fonctions ne passent pas par un repository (elles n'ont besoin que
 * de `env.DB`), le foyer leur est donc passe explicitement. Il vient de
 * `SessionUser`, jamais d'un parametre de requete.
 */

import type { SessionUser } from './auth.js'
import { NO_HOUSEHOLD } from './repos/index.js'

export type ActivityAction = 'create' | 'update' | 'delete'

export type ActivityEntity =
  | 'recipe'
  | 'ingredient'
  | 'pantry_stock'
  | 'meal_plan_entry'
  | 'price_history'
  | 'cooking_log'
  | 'shopping_checked'
  | 'rayon'
  | 'icon'
  /**
   * Une virée de courses, du premier scan a la validation.
   *
   * Journalisee comme un tout et non article par article : trente lignes
   * « a ajouté X » noieraient le reste du journal pour une seule sortie.
   */
  | 'shopping_session'
  /** Un plat cuisine (shared/src/preparation.ts) : un seul geste, journalise comme un tout. */
  | 'preparation'

export interface ActivityEntry {
  readonly id: number
  readonly userId: number | null
  readonly displayName: string | null
  readonly action: ActivityAction
  readonly entity: ActivityEntity
  readonly entityId: number | null
  readonly label: string
  readonly details: string | null
  readonly at: string
}

export interface LogInput {
  readonly action: ActivityAction
  readonly entity: ActivityEntity
  readonly entityId?: number | null
  readonly label: string
  readonly details?: unknown
}

/**
 * Enregistre une action.
 *
 * N'echoue JAMAIS bruyamment : si le journal tombe, l'action metier qui vient
 * de reussir ne doit pas etre signalee comme un echec a l'utilisateur. Une
 * trace manquante est un desagrement ; une suppression qui semble avoir echoue
 * alors qu'elle a eu lieu est bien pire.
 */
export async function logActivity(
  db: D1Database,
  user: SessionUser | null,
  input: LogInput,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO activity_log (household_id, user_id, action, entity, entity_id, label, details)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        // Sans utilisateur, la trace part au foyer 0, que personne ne lit :
        // elle est perdue plutot que versee au journal d'une vraie cuisine.
        user?.householdId ?? NO_HOUSEHOLD,
        user?.id ?? null,
        input.action,
        input.entity,
        input.entityId ?? null,
        input.label.slice(0, 200),
        input.details === undefined ? null : JSON.stringify(input.details),
      )
      .run()
  } catch (error) {
    console.error('journal d’activité indisponible', error)
  }
}

export async function listActivity(
  db: D1Database,
  householdId: number,
  limit = 50,
): Promise<ActivityEntry[]> {
  const { results } = await db
    .prepare(
      // LEFT JOIN : un compte supprime ne doit pas faire disparaitre
      // l'historique de la cuisine. Le foyer est lie DEUX fois — la condition
      // de jointure precede textuellement celle du WHERE. Celle du JOIN est une
      // ceinture de securite : les lignes sont deja les notres, mais un
      // `user_id` errant ferait sinon apparaitre le nom d'un inconnu.
      `SELECT a.id, a.user_id, u.display_name, a.action, a.entity, a.entity_id,
              a.label, a.details, a.at
       FROM activity_log a
       LEFT JOIN user u ON u.id = a.user_id AND u.household_id = ?
       WHERE a.household_id = ?
       ORDER BY a.at DESC, a.id DESC
       LIMIT ?`,
    )
    .bind(householdId, householdId, Math.min(Math.max(limit, 1), 200))
    .all<{
      id: number
      user_id: number | null
      display_name: string | null
      action: ActivityAction
      entity: ActivityEntity
      entity_id: number | null
      label: string
      details: string | null
      at: string
    }>()

  return results.map((r) => ({
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    label: r.label,
    details: r.details,
    at: r.at,
  }))
}
