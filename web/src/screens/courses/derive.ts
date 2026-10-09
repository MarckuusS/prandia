/**
 * Ce que l'ecran Courses DEDUIT de sa liste : un total, des candidats, un
 * denominateur, un filtre qui se desarme.
 *
 * Ces quatre calculs vivaient dans le corps de `ShoppingScreen`, melanges au
 * rendu. Ils en sortent SANS CHANGER UN SIGNE : c'est un deplacement, pas une
 * reecriture. La raison est qu'ils vont survivre au remplacement de l'ecran par
 * une maquette, et qu'un calcul enfoui dans un composant qu'on remplace part
 * avec lui sans que personne ne s'en apercoive.
 *
 * Pur : ni requete, ni composant, ni etat. C'est ce qui les rend testables.
 */

import type { ShoppingItem } from '@prandia/shared'

/**
 * Montant en centimes ENTIERS.
 *
 * Le front n'embarque pas de bibliotheque decimale, et les couts arrivent deja
 * arrondis au centime par le serveur : additionner des flottants d'euros
 * ferait apparaitre des 0,30000000000000004.
 *
 * `null` VEUT DIRE PRIX INCONNU, et ne compte pas pour zero euro. La nuance
 * n'est pas theorique : un article sans prix ne rend pas la liste moins chere,
 * il rend le total incomplet, ce que l'ecran dit ailleurs.
 */
export function cents(amount: string | null): number {
  return amount === null ? 0 : Math.round(Number(amount) * 100)
}

/** La somme, en centimes entiers, des lignes qui ont un prix. */
export function sumCents(items: readonly Pick<ShoppingItem, 'costEur'>[]): number {
  return items.reduce((somme, item) => somme + cents(item.costEur), 0)
}

/**
 * Les lignes deja couvertes par le frigo et pas encore cochees.
 *
 * ELLES NE SONT PAS PRE-COCHEES, et c'est une decision prise apres incident :
 * sur telephone, une case cochee qu'on n'a pas cochee soi-meme se lit comme une
 * erreur, et l'utilisateur croyait avoir coche par megarde. L'ecran les propose,
 * il ne les coche pas.
 */
export function pantryCandidates(
  items: readonly ShoppingItem[],
  checked: ReadonlySet<number>,
): ShoppingItem[] {
  return items.filter((item) => item.isCoveredByPantry && !checked.has(item.ingredientId))
}

/** Ce qui reste a mettre dans le panier. */
export function remainingItems(
  items: readonly ShoppingItem[],
  checked: ReadonlySet<number>,
): ShoppingItem[] {
  return items.filter((item) => !checked.has(item.ingredientId))
}

/**
 * Le filtre "sans prix" est-il REELLEMENT actif ?
 *
 * Il se desarme tout seul quand il n'y a plus rien a filtrer : sinon,
 * renseigner le dernier prix manquant laisserait une liste vide et muette,
 * sans que rien n'explique pourquoi.
 */
export function isFiltering(onlyMissingPrice: boolean, missingPriceCount: number): boolean {
  return onlyMissingPrice && missingPriceCount > 0
}

/** Les lignes a afficher, une fois le filtre applique. */
export function visibleItems(
  items: readonly ShoppingItem[],
  filtering: boolean,
): readonly ShoppingItem[] {
  return filtering ? items.filter((item) => item.costEur === null) : items
}
