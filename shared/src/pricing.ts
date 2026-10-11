/**
 * Calculs de cout. Decimal partout — jamais de float sur des euros.
 *
 * Portage de app/domain/pricing.py.
 *
 * Deux points de fidelite qui ne se voient pas mais changent les totaux :
 *
 *   1. L'arrondi se fait LIGNE PAR LIGNE au centime, puis on somme. Arrondir
 *      seulement le total donnerait des ecarts d'un centime par rapport a ce
 *      que le desktop affiche aujourd'hui.
 *
 *   2. ROUND_HALF_UP, pas le mode par defaut. Python arrondit au pair le plus
 *      proche (banker's rounding) par defaut, si bien que `pricing.py` et
 *      `shopping_service.py` n'arrondissaient PAS pareil — 0,125 € devenait
 *      0,13 € d'un cote et 0,12 € de l'autre (annexe #5 de la spec).
 *      Tout est harmonise sur HALF_UP ici.
 */

import Decimal from 'decimal.js'
import type { Ingredient, Recipe, RecipeLine } from './models.js'
import { normalizeName } from './text.js'

const CENTS = 2
const HALF_UP = Decimal.ROUND_HALF_UP

/** Arrondit au centime, ROUND_HALF_UP. */
export function toCents(value: Decimal): Decimal {
  return value.toDecimalPlaces(CENTS, HALF_UP)
}

/** Serialise un montant pour l'API : chaine a 2 decimales. */
export function formatAmount(value: Decimal): string {
  return toCents(value).toFixed(CENTS)
}

/**
 * Formate un montant pour l'affichage francais : « 12,50 € ».
 *
 * L'espace avant le symbole est INSECABLE (U+00A0) : sans elle, un montant en
 * fin de ligne se coupe entre le nombre et le « € ». Le separateur de milliers,
 * lui, est choisi par Intl et vaut U+202F en fr-FR — une espace FINE insecable,
 * qui n'est ni l'une ni l'autre des deux precedentes. Ne jamais comparer une
 * chaine formatee a un litteral tape a la main : elles se ressemblent a l'oeil
 * et different pour `===`.
 */
export function formatEuros(value: Decimal | string | null): string {
  if (value === null) return '—'
  const d = typeof value === 'string' ? new Decimal(value) : value
  const amount = toCents(d).toNumber().toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${amount} €`
}

/**
 * Prix au gramme, en pleine precision (aucun arrondi ici — arrondir avant de
 * multiplier fausserait tout).
 *
 * Retourne `null` si le prix ou la quantite de reference manquent. Attention,
 * comportement repris du Python (`not self.price_quantity_g`) : une quantite
 * de reference a 0 est traitee comme absente, pas comme une division par zero.
 */
export function pricePerG(
  ingredient: Pick<Ingredient, 'priceEur' | 'priceQuantityG'>,
): Decimal | null {
  if (ingredient.priceEur === null) return null
  if (!ingredient.priceQuantityG) return null
  return new Decimal(ingredient.priceEur).div(new Decimal(ingredient.priceQuantityG))
}

/** Cout d'une quantite d'ingredient, arrondi au centime. `null` si pas de prix. */
export function ingredientCost(
  ingredient: Pick<Ingredient, 'priceEur' | 'priceQuantityG'>,
  quantityG: number,
): Decimal | null {
  const perG = pricePerG(ingredient)
  if (perG === null) return null
  return toCents(perG.mul(new Decimal(quantityG)))
}

export function lineCost(line: Pick<RecipeLine, 'ingredient' | 'quantityG'>): Decimal | null {
  return ingredientCost(line.ingredient, line.quantityG)
}

export interface RecipeCost {
  readonly total: Decimal
  readonly perPortion: Decimal
  /** Lignes sans prix : exclues du total mais comptees, pour que l'UI le dise. */
  readonly missing: readonly RecipeLine[]
}

/**
 * Cout d'une recette. Les lignes sans prix sont ignorees dans le total et
 * renvoyees a part — un total de 3 € sur une recette dont la moitie des
 * ingredients n'ont pas de prix serait trompeur sans cette information.
 */
export function recipeCost(recipe: Pick<Recipe, 'lines' | 'defaultPortions'>): RecipeCost {
  let total = new Decimal(0)
  const missing: RecipeLine[] = []

  for (const line of recipe.lines) {
    const cost = lineCost(line)
    if (cost === null) missing.push(line)
    else total = total.plus(cost)
  }

  const rounded = toCents(total)
  const portions = Math.max(recipe.defaultPortions, 1)
  return {
    total: rounded,
    perPortion: toCents(rounded.div(new Decimal(portions))),
    missing,
  }
}

/** Ce que designe une entree de calendrier, une fois resolue. */
export type MealPlanTarget =
  | { readonly kind: 'recipe'; readonly recipe: Pick<Recipe, 'lines' | 'defaultPortions'> }
  | {
      readonly kind: 'ingredient'
      readonly ingredient: Pick<Ingredient, 'priceEur' | 'priceQuantityG'>
    }

export interface MealPlanEntryCost {
  /** Cout de l'entree. PARTIEL des que `missingLines > 0`. `null` = rien de chiffrable. */
  readonly cost: Decimal | null
  /**
   * Nombre de LIGNES d'ingredient sans prix, pas d'entrees.
   *
   * C'est toute la difference : une recette de cinq ingredients dont deux n'ont
   * pas de prix rend un cout non nul, donc l'appelant qui se contentait de
   * tester `cost === null` la comptait comme entierement connue et affichait un
   * budget sous-estime en le presentant comme sur. Le desktop, lui, comptait
   * bien les lignes (`shopping_service`). Une entree ingredient sans prix vaut
   * une ligne.
   */
  readonly missingLines: number
}

/**
 * Cout d'une entree de calendrier, avec le detail de ce qui manque.
 * Recette : cout total x (portions servies / portions par defaut).
 * Ingredient : cout de la quantite.
 */
export function mealPlanEntryCostDetail(
  entry: { readonly portions: number | null; readonly quantityG: number | null },
  target: MealPlanTarget,
): MealPlanEntryCost {
  if (target.kind === 'recipe') {
    const { total, missing } = recipeCost(target.recipe)
    if (missing.length > 0 && total.isZero()) {
      return { cost: null, missingLines: missing.length }
    }
    const ratio = new Decimal(entry.portions ?? 1).div(
      new Decimal(Math.max(target.recipe.defaultPortions, 1)),
    )
    return { cost: toCents(total.mul(ratio)), missingLines: missing.length }
  }
  const cost = ingredientCost(target.ingredient, entry.quantityG ?? 0)
  return { cost, missingLines: cost === null ? 1 : 0 }
}

/**
 * Cout seul d'une entree de calendrier.
 *
 * Garde-fou : ce raccourci perd l'information de cout partiel. Ne l'utiliser
 * que la ou un seul montant est affiche sans commentaire. Pour un total qui
 * doit dire ce qu'il ignore, passer par `mealPlanEntryCostDetail`.
 */
export function mealPlanEntryCost(
  entry: { readonly portions: number | null; readonly quantityG: number | null },
  target: MealPlanTarget,
): Decimal | null {
  return mealPlanEntryCostDetail(entry, target).cost
}

/** Un releve de l'historique, tel que l'API le rend (le plus recent d'abord). */
export interface PaidPriceEntry {
  readonly priceEur: string
  readonly quantityG: number
  readonly store: string | null
  readonly recordedAt: string
}

export interface PaidPriceSuggestion {
  /** Montant ramene a la quantite demandee, au centime. */
  readonly priceEur: string
  /** Le releve d'ou il vient, pour le dire a l'ecran. */
  readonly from: PaidPriceEntry
  /** Vrai quand le releve vient du MEME magasin. */
  readonly sameStore: boolean
}

/**
 * Le prix a proposer pour un achat : TON dernier prix paye, pas une moyenne.
 *
 * Dans le meme magasin d'abord, parce qu'un meme produit change de prix d'une
 * enseigne a l'autre bien plus que d'une semaine a l'autre ; a defaut, le
 * dernier releve tous magasins confondus. Le montant est ramene a la quantite
 * demandee : 1,89 EUR les 500 g proposent 3,78 EUR pour deux paquets.
 *
 * Une PROPOSITION, toujours dite comme telle a l'ecran avec sa source : le
 * prix d'une etiquette change, et c'est elle qui fait foi.
 */
export function lastPaidPrice(
  history: readonly PaidPriceEntry[],
  wanted: { readonly store: string | null; readonly quantityG: number | null },
): PaidPriceSuggestion | null {
  const magasin = normalizeName(wanted.store)
  // Tri stable : a date egale, l'ordre de l'API (le dernier saisi d'abord) tient.
  const parDate = [...history].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0))
  const ici = magasin === '' ? undefined : parDate.find((e) => normalizeName(e.store) === magasin)
  const from = ici ?? parDate[0]
  if (from === undefined || !(from.quantityG > 0)) return null

  const quantite = wanted.quantityG !== null && wanted.quantityG > 0 ? wanted.quantityG : from.quantityG
  const montant = toCents(new Decimal(from.priceEur).times(quantite).dividedBy(from.quantityG))
  if (montant.lte(0)) return null
  return { priceEur: formatAmount(montant), from, sameStore: ici !== undefined }
}
