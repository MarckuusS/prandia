/**
 * Le reapprovisionnement du placard : ce qui est descendu sous son seuil.
 *
 * LE SEUIL EST UN PLANCHER, PAS UNE CIBLE, et toute la logique de ce module en
 * decoule. Un stock exactement au seuil ne declenche rien : le seuil dit "en
 * dessous de ca, je n'en ai plus assez", pas "je veux toujours en avoir tant".
 * La nuance evite qu'un produit maintenu pile a son seuil reapparaisse a chaque
 * liste de courses sans qu'on comprenne pourquoi.
 *
 * CALCULE EN DIRECT, JAMAIS STOCKE. Un seuil recopie dans une liste de courses
 * divergerait du seuil du produit des la premiere modification, et l'on aurait
 * deux verites pour un meme chiffre. Meme regle que les cibles nutritionnelles
 * du profil, qui se recalculent au lieu d'etre ecrites.
 *
 * Ce module ne connait NI la liste de courses NI le planning : il repond a la
 * seule question "de quoi manque-t-il au placard". Le croisement avec ce que la
 * semaine demande se fait ailleurs, sinon un produit sous son seuil ET prevu
 * jeudi serait compte deux fois.
 */

import type { Ingredient } from './models.js'

/** Ce que le calcul lit d'un ingredient : le Worker n'a pas a charger la fiche entiere. */
export type RestockSource = Pick<Ingredient, 'id' | 'name' | 'categoryL1' | 'restockThresholdG'>

export interface RestockLine {
  readonly ingredientId: number
  readonly name: string
  readonly categoryL1: string | null
  /** Ce qu'on a, tous lots confondus. */
  readonly inStockG: number
  readonly thresholdG: number
  /** Ce qu'il faut pour revenir au seuil. Toujours strictement positif. */
  readonly missingG: number
}

// Le meme collator que `aggregateShoppingList` : deux tris differents pour deux
// listes qui s'affichent l'une sous l'autre se verraient tout de suite.
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true })

/**
 * Les produits passes sous leur seuil.
 *
 * `pantryByIngredient` porte la masse TOTALE par ingredient, tous lots
 * confondus : un seuil s'apprecie sur ce qu'on a, pas sur le pot le plus
 * recent.
 *
 * Un ingredient sans seuil ne produit JAMAIS de ligne. `null` veut dire "ce
 * produit n'est pas suivi", ce qui est le cas de la quasi-totalite de la
 * bibliotheque : rendre une ligne pour chacun noierait les quelques produits
 * reellement suivis.
 */
export function restockLines(
  ingredients: readonly RestockSource[],
  pantryByIngredient: ReadonlyMap<number, number>,
): RestockLine[] {
  const lignes: RestockLine[] = []

  for (const ingredient of ingredients) {
    const seuil = ingredient.restockThresholdG
    if (seuil === null || seuil === undefined || seuil <= 0) continue
    if (ingredient.id === null) continue

    const stock = pantryByIngredient.get(ingredient.id) ?? 0
    // STRICTEMENT sous le seuil : voir l'en-tete, le seuil est un plancher.
    if (stock >= seuil) continue

    lignes.push({
      ingredientId: ingredient.id,
      name: ingredient.name,
      categoryL1: ingredient.categoryL1,
      inStockG: stock,
      thresholdG: seuil,
      missingG: seuil - stock,
    })
  }

  return lignes.sort((a, b) => collator.compare(a.name, b.name))
}

/**
 * La part du seuil encore couverte, entre 0 et 1.
 *
 * SERT A DESSINER UNE BARRE, ET ELLE SE LIT PAR RAPPORT AU SEUIL, jamais par
 * rapport a un "plein" que personne n'a saisi. C'est la difference avec le
 * pourcentage de remplissage des maquettes : pour dire "70 % plein", il
 * faudrait connaitre la contenance du paquet neuf, que rien ne porte. Ici la
 * barre repond a une question qui a une reponse : "ou en suis-je de mon seuil".
 *
 * Bornee a 1 : un stock au-dessus du seuil remplit la barre, il ne la deborde
 * pas.
 */
export function restockRatio(inStockG: number, thresholdG: number): number {
  if (thresholdG <= 0) return 0
  return Math.max(0, Math.min(1, inStockG / thresholdG))
}
