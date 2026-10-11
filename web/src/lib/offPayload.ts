/**
 * Creer la fiche d'un produit OpenFoodFacts : ce qu'il faut envoyer, ECRIT UNE
 * FOIS.
 *
 * Un candidat OpenFoodFacts n'existe pas en base (`id` nul) : l'adopter, c'est
 * le creer, macros comprises. Ce calque vivait en deux copies (import de la
 * bibliotheque, scan vers le frigo), et les deux oubliaient la contenance du
 * paquet : un produit de 500 g arrivait sans piece, et se dosait a 100 g. Une
 * troisieme copie allait naitre pour l'import de recette ; il n'y en a plus
 * qu'une.
 */

import type { Ingredient } from '@prandia/shared'

export const offCreatePayload = (candidate: Ingredient): Partial<Ingredient> & { name: string } => ({
  name: candidate.name,
  source: candidate.source,
  sourceRef: candidate.sourceRef,
  brand: candidate.brand,
  kcal: candidate.kcal,
  proteins: candidate.proteins,
  carbs: candidate.carbs,
  sugars: candidate.sugars,
  fats: candidate.fats,
  saturatedFats: candidate.saturatedFats,
  fiber: candidate.fiber,
  salt: candidate.salt,
  // La contenance du paquet : c'est la "piece" d'un produit emballe.
  pieceWeightG: candidate.pieceWeightG,
  nutriscoreGrade: candidate.nutriscoreGrade,
})
