/**
 * Cuisiner une recette : le plat tel qu'on l'a VRAIMENT fait (decision du
 * 2026-10-14).
 *
 * Une recette se suit rarement a la lettre : une autre marque de creme, de la
 * sauce tomate faute de pelees, deux gousses d'ail au lieu d'une. Et un plat
 * se cuisine souvent pour deux, et pour plusieurs jours. La recette reste le
 * MODELE, jamais retouchee ; ce qu'on a cuisine devient un PLAT, une fiche
 * maison dont les apports pour 100 g sont calcules UNE FOIS, a la cuisson, sur
 * les vrais ingredients. On en mange ensuite des parts ou des grammes, comme
 * de n'importe quel aliment ; les semaines passees ne bougent plus quand la
 * recette change.
 *
 * Ce module, pur, tient les regles : les apports du plat, son poids estime, les
 * lignes d'une recette ramenees au nombre de parts, et ce qui sort du frigo.
 */

import { z } from 'zod'

import type { Ingredient, NutritionTotal, PantryStock } from './models.js'
import { addNutrition, divideNutrition, macrosFor, recipeCookedWeightG, ZERO_NUTRITION } from './nutrition.js'

/**
 * Le plat se garde trois jours au frigo, par defaut, et la feuille le dit : ce
 * n'est pas une date imprimee qu'on lirait, c'est une proposition qu'on
 * change d'un toucher. C'est l'usage courant pour des restes cuisines.
 */
export const PLAT_A_FINIR_JOURS = 3

/**
 * La fiche d'un plat porte `source = 'manual'` et `sourceRef = 'plat:<id de la
 * preparation>'` : aucune migration de la contrainte sur `source` (SQLite ne
 * sait pas modifier un CHECK), et l'ecran reconnait un plat sans requete de
 * plus.
 */
export const PLAT_REF_PREFIXE = 'plat:'

export const estUnPlat = (ingredient: Pick<Ingredient, 'source' | 'sourceRef'>): boolean =>
  ingredient.source === 'manual' && (ingredient.sourceRef?.startsWith(PLAT_REF_PREFIXE) ?? false)

const jour = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.')

export const preparationLineWriteSchema = z.object({
  ingredientId: z.number().int().positive(),
  quantityG: z.number().positive('Une quantité doit être strictement positive.').max(20_000),
  unit: z.string().max(20).nullable().default(null),
})

export const preparationWriteSchema = z
  .object({
    /** La recette d'origine ; `null` pour un plat improvise. */
    recipeId: z.number().int().positive().nullable().default(null),
    /** Le repas du planning qui a lance la cuisson : il devient une part du plat. */
    entryId: z.number().int().positive().nullable().default(null),
    name: z.string().trim().min(1, 'Donne un nom au plat.').max(120),
    cookedOn: jour,
    cookedWeightG: z.number().positive('Indique le poids du plat cuit.').max(50_000),
    /** En combien de parts le plat se partage : `null`, il se mange en grammes. */
    parts: z.number().positive().max(100).nullable().default(null),
    /** A finir avant ; `null`, le plat ne porte pas de date. */
    expiryDate: jour.nullable().default(null),
    /** Ce que la personne mange au repas qui a lance la cuisson, en grammes. */
    myPartG: z.number().positive().nullable().default(null),
    lines: z.array(preparationLineWriteSchema).min(1, 'Un plat a au moins un ingrédient.').max(60),
  })
  .refine((p) => p.myPartG === null || p.myPartG <= p.cookedWeightG, {
    message: 'Ta part ne peut pas dépasser le plat.',
    path: ['myPartG'],
  })
  .refine((p) => p.myPartG === null || p.entryId !== null, {
    message: 'Une part se prend sur un repas du planning.',
    path: ['myPartG'],
  })
export type PreparationWrite = z.infer<typeof preparationWriteSchema>

type Macros = Pick<Ingredient, 'kcal' | 'proteins' | 'carbs' | 'sugars' | 'fats' | 'saturatedFats' | 'fiber' | 'salt'>

/**
 * Les apports du plat : le total de ses vrais ingredients, et ce total ramene a
 * 100 g de plat CUIT, la valeur que porte sa fiche. Une macro inconnue compte
 * zero (regle du domaine, comme pour une recette) ; `inconnues` dit combien de
 * lignes en manquent, pour que l'ecran le signale.
 */
export function apportsDuPlat(
  lignes: ReadonlyArray<{ readonly ingredient: Macros; readonly quantityG: number }>,
  poidsCuitG: number,
): { readonly total: NutritionTotal; readonly pour100g: NutritionTotal; readonly inconnues: number } {
  const total = lignes.reduce((somme, l) => addNutrition(somme, macrosFor(l.ingredient, l.quantityG)), ZERO_NUTRITION)
  const inconnues = lignes.filter(
    (l) => l.ingredient.kcal === null || l.ingredient.proteins === null || l.ingredient.carbs === null || l.ingredient.fats === null,
  ).length
  return { total, pour100g: poidsCuitG > 0 ? divideNutrition(total, poidsCuitG / 100) : ZERO_NUTRITION, inconnues }
}

/**
 * Le poids du plat cuit, ESTIME : chaque ligne avec son rendement (le riz
 * triple), le reste a poids egal. L'eau qui s'evapore n'y est pas : peser la
 * casserole donne mieux, et la feuille le propose.
 */
export const poidsCuitEstime = (
  lignes: ReadonlyArray<{ readonly ingredient: Pick<Ingredient, 'cookedWeightPer100gRaw'>; readonly quantityG: number }>,
): number => Math.round(recipeCookedWeightG(lignes))

/** Les lignes d'une recette ramenees a `parts` parts (la recette en fait `defaultPortions`). */
export function lignesPourParts<L extends { readonly quantityG: number }>(
  recette: { readonly defaultPortions: number; readonly lines: readonly L[] },
  parts: number,
): L[] {
  const facteur = parts / Math.max(recette.defaultPortions, 1)
  return recette.lines.map((l) => ({ ...l, quantityG: l.quantityG * facteur }))
}

/** "Chili con carne du 13/10" : le plat se reconnait a sa date au frigo et au planning. */
export function nomDuPlat(nomRecette: string, cuitLe: string): string {
  const [, mois, jourDuMois] = cuitLe.split('-')
  return `${nomRecette.trim()} du ${jourDuMois}/${mois}`
}

export interface SortieDuFrigo {
  readonly lotId: number
  readonly ingredientId: number
  readonly quantityG: number
  /** Le lot est vide apres la sortie : il disparait (la table refuse un lot a zero). */
  readonly vide: boolean
}

/** En dessous, le reste d'un lot n'est que l'arrondi d'une conversion : le lot est fini. */
const RESTE_NEGLIGEABLE_G = 1

/**
 * Ce qui sort du frigo pour cuisiner : chaque ingredient pris dans ses lots,
 * CEUX QUI PERIMENT LE PLUS TOT D'ABORD (sans date en dernier), jamais plus que
 * ce qu'ils contiennent. Ce qui manque au frigo (le sel, l'huile, ce qu'on n'y
 * a jamais range) ne sort de nulle part : rien n'empeche de cuisiner.
 */
export function sortiesDuFrigo(
  lignes: ReadonlyArray<{ readonly ingredientId: number; readonly quantityG: number }>,
  lots: ReadonlyArray<Pick<PantryStock, 'id' | 'ingredientId' | 'quantityG' | 'expiryDate'>>,
): SortieDuFrigo[] {
  const besoin = new Map<number, number>()
  for (const l of lignes) besoin.set(l.ingredientId, (besoin.get(l.ingredientId) ?? 0) + l.quantityG)

  const ordonnes = [...lots].sort(
    (a, b) =>
      Number(a.expiryDate === null) - Number(b.expiryDate === null) ||
      (a.expiryDate ?? '').localeCompare(b.expiryDate ?? '') ||
      (a.id ?? 0) - (b.id ?? 0),
  )
  const sorties: SortieDuFrigo[] = []
  for (const lot of ordonnes) {
    const reste = besoin.get(lot.ingredientId) ?? 0
    if (lot.id === null || reste <= 0) continue
    const pris = Math.min(reste, lot.quantityG)
    besoin.set(lot.ingredientId, reste - pris)
    sorties.push({
      lotId: lot.id,
      ingredientId: lot.ingredientId,
      quantityG: pris,
      vide: lot.quantityG - pris < RESTE_NEGLIGEABLE_G,
    })
  }
  return sorties
}
