/**
 * D'ou vient la quantite d'une ligne de courses.
 *
 * La liste agregee ne dit que « 480 g de carottes ». En magasin, devant un
 * sachet de 500 g, la question suivante est toujours la meme : pour quoi
 * faire ? Le desktop ne repondait jamais — la ligne n'y etait pas cliquable et
 * l'inventaire de parite le note comme une occasion propre au web. On
 * redescend donc de la liste agregee vers les repas de la semaine qui la
 * composent.
 *
 * Le calcul se fait ICI, cote client, a partir de la semaine deja chargee
 * (`GET /api/calendar/:week`) : ajouter l'origine de chaque ligne a la reponse
 * de la liste de courses l'alourdirait pour tout le monde alors que le detail
 * n'est consulte que sur une ligne a la fois.
 *
 * DUPLICATION ASSUMEE : la regle de mise a l'echelle par portions
 * (`portions / max(defaultPortions, 1)`) est celle de `aggregateShoppingList`
 * dans shared/src/shopping.ts. Elle est recopiee ici parce que la fonction
 * partagee ne rend que des totaux, sans leur origine. A terme c'est a
 * `@prandia/shared` d'exposer cette decomposition — voir le rapport de portage —
 * pour qu'une seule definition du ratio subsiste.
 */

import { DAY_LABELS, MEAL_SLOTS, MEAL_SLOT_LABELS } from '@prandia/shared'

import type { CalendarResponse } from '../../lib/queries.js'

export interface QuantitySource {
  /** Cle de rendu React. Les entrees non enregistrees n'ont pas d'identifiant. */
  readonly key: string
  /** Nom de la recette, ou mention de l'ingredient pose seul dans le creneau. */
  readonly title: string
  /** « Lundi · Midi · 2 portions ». */
  readonly when: string
  readonly quantityG: number
  /** Non nul quand la ligne vient d'une recette : permet d'ouvrir sa fiche. */
  readonly recipeId: number | null
}

/**
 * Toutes les contributions d'un ingredient sur la semaine, dans l'ordre ou on
 * les mangera.
 *
 * Les references orphelines (recette supprimee depuis la planification) sont
 * ignorees en silence, exactement comme l'agregation cote serveur : mieux vaut
 * un detail incomplet qu'un ecran d'erreur au milieu d'un rayon.
 */
export function explainQuantity(
  ingredientId: number,
  week: CalendarResponse,
): readonly QuantitySource[] {
  // Le rang chronologique voyage a cote de la source : le retrouver apres coup
  // demanderait de rechercher l'entree d'origine, et rien ne garantit qu'elle
  // soit identifiable (une entree tout juste creee n'a pas encore d'id).
  const ranked: Array<{ rank: number; source: QuantitySource }> = []

  for (const [index, entry] of week.entries.entries()) {
    const day = DAY_LABELS[entry.dayOfWeek] ?? '?'
    const when = `${day} · ${MEAL_SLOT_LABELS[entry.slot]}`
    // L'ordre du tableau MEAL_SLOTS EST l'ordre chronologique : trier sur le
    // code du creneau donnerait l'ordre alphabetique, soir avant midi.
    const rank = entry.dayOfWeek * 1000 + MEAL_SLOTS.indexOf(entry.slot) * 10 + entry.ordinal
    const key = entry.id === null ? `index-${index}` : `entry-${entry.id}`

    if (entry.recipeId !== null) {
      const recipe = week.recipes[String(entry.recipeId)]
      if (!recipe) continue

      const portions = entry.portions ?? 1
      const ratio = portions / Math.max(recipe.defaultPortions, 1)
      // Un meme ingredient peut occuper plusieurs lignes d'une recette (oignon
      // emince + oignon du bouillon) : on cumule avant d'afficher, sinon le
      // detail serait plus confus que le total qu'il explique.
      let grams = 0
      for (const line of recipe.lines) {
        if (line.ingredient.id === ingredientId) grams += line.quantityG * ratio
      }
      if (grams === 0) continue

      ranked.push({
        rank,
        source: {
          key,
          title: recipe.name,
          when: `${when} · ${formatPortions(portions)}`,
          quantityG: grams,
          recipeId: entry.recipeId,
        },
      })
    } else if (entry.ingredientId === ingredientId) {
      ranked.push({
        rank,
        source: { key, title: 'Ajouté seul au planning', when, quantityG: entry.quantityG ?? 0, recipeId: null },
      })
    }
  }

  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.source)
}

/** « 2 portions », « 1 portion », « 1,5 portion ». */
function formatPortions(portions: number): string {
  const label = portions.toLocaleString('fr-FR', { maximumFractionDigits: 2 })
  return `${label} portion${portions > 1 ? 's' : ''}`
}
