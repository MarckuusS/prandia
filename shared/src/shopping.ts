/**
 * Agregation d'une semaine de planning en liste de courses.
 *
 * Portage de app/services/shopping_service.py. La fonction est PURE : elle
 * recoit les donnees deja chargees et ne connait ni base ni reseau. C'est
 * l'appelant (le Worker) qui fait les quatre requetes.
 *
 * Degradation silencieuse, reprise du desktop : une entree qui pointe vers une
 * recette ou un ingredient supprime est ignoree, jamais une erreur. Une liste
 * de courses incomplete reste utilisable en magasin ; un ecran d'erreur, non.
 */

import Decimal from 'decimal.js'

import type { Ingredient, MealPlanEntry, Recipe } from './models.js'
import { formatAmount, ingredientCost, toCents } from './pricing.js'
import { formatGrams } from './units.js'

export interface ShoppingItem {
  readonly ingredientId: number
  readonly name: string
  readonly source: string
  readonly quantityG: number
  readonly pieceWeightG: number | null
  readonly categoryL1: string | null
  /** Chaine decimale, ou `null` si l'ingredient n'a pas de prix. */
  readonly costEur: string | null
  /** Quantite deja presente au frigo, tous lots confondus. */
  readonly inPantryG: number
  /**
   * Vrai si le stock couvre le besoin.
   *
   * LA CASE N'EST PAS PRE-COCHEE, contrairement a ce que disait ce commentaire.
   * Le pre-cochage venait du desktop et a ete retire apres incident : sur
   * telephone, une case cochee qu'on n'a pas cochee soi-meme se lit comme une
   * erreur, et l'utilisateur croyait avoir coche par megarde. L'ecran PROPOSE
   * de cocher, en un geste, et n'ecrit rien tout seul.
   */
  readonly isCoveredByPantry: boolean
  /** Nombre de pieces approximatif, quand l'ingredient a une taille naturelle. */
  readonly pieceCount: number | null
}

export interface ShoppingList {
  readonly isoWeek: string
  readonly items: readonly ShoppingItem[]
  readonly totalEur: string
  /** Ingredients sans prix : exclus du total mais comptes, pour que l'UI le dise. */
  readonly missingPriceCount: number
}

export interface AggregateInput {
  readonly isoWeek: string
  readonly entries: readonly MealPlanEntry[]
  readonly recipesById: ReadonlyMap<number, Recipe>
  readonly ingredientsById: ReadonlyMap<number, Ingredient>
  /** Totaux du frigo par ingredient, deja sommes sur les lots. */
  readonly pantryByIngredient: ReadonlyMap<number, number>
}

export function aggregateShoppingList(input: AggregateInput): ShoppingList {
  const { isoWeek, entries, recipesById, ingredientsById, pantryByIngredient } = input

  // 1. Cumul des quantites par ingredient.
  const quantityByIngredient = new Map<number, number>()
  const add = (id: number, grams: number) =>
    quantityByIngredient.set(id, (quantityByIngredient.get(id) ?? 0) + grams)

  for (const entry of entries) {
    if (entry.recipeId !== null) {
      const recipe = recipesById.get(entry.recipeId)
      if (!recipe) continue // reference orpheline : recette supprimee
      // Mise a l'echelle : 2 portions servies d'une recette qui en fait 4
      // n'utilisent que la moitie des ingredients.
      const ratio = (entry.portions ?? 1) / Math.max(recipe.defaultPortions, 1)
      for (const line of recipe.lines) {
        if (line.ingredient.id === null) continue
        add(line.ingredient.id, line.quantityG * ratio)
      }
    } else if (entry.ingredientId !== null) {
      add(entry.ingredientId, entry.quantityG ?? 0)
    }
  }

  // 2. Hydratation et couts.
  const items: ShoppingItem[] = []
  let total = new Decimal(0)
  let missingPriceCount = 0

  for (const [ingredientId, quantityG] of quantityByIngredient) {
    const ingredient = ingredientsById.get(ingredientId)
    if (!ingredient) continue // reference orpheline : ingredient supprime

    const cost = ingredientCost(ingredient, quantityG)
    if (cost === null) missingPriceCount++
    else total = total.plus(cost)

    const inPantryG = pantryByIngredient.get(ingredientId) ?? 0
    items.push({
      ingredientId,
      name: ingredient.name,
      source: ingredient.source,
      quantityG,
      pieceWeightG: ingredient.pieceWeightG,
      categoryL1: ingredient.categoryL1,
      costEur: cost === null ? null : formatAmount(cost),
      inPantryG,
      isCoveredByPantry: quantityG > 0 && inPantryG >= quantityG,
      pieceCount: ingredient.pieceWeightG ? quantityG / ingredient.pieceWeightG : null,
    })
  }

  // 3. Tri : rayons renseignes d'abord, puis rayon, puis nom.
  //
  // localeCompare et non une comparaison de points de code : le desktop triait
  // « Œuf » apres « Zeste » parce que Œ vaut U+0152, au-dela de Z. En rayon,
  // on cherche « Œuf » a la lettre O.
  const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true })
  items.sort((a, b) => {
    const aUncategorized = a.categoryL1 === null
    const bUncategorized = b.categoryL1 === null
    if (aUncategorized !== bUncategorized) return aUncategorized ? 1 : -1
    const byCategory = collator.compare(a.categoryL1 ?? '', b.categoryL1 ?? '')
    return byCategory !== 0 ? byCategory : collator.compare(a.name, b.name)
  })

  return { isoWeek, items, totalEur: formatAmount(toCents(total)), missingPriceCount }
}

/** Regroupe la liste par rayon, en conservant l'ordre de tri. */
export interface ShoppingSection {
  readonly category: string
  readonly items: readonly ShoppingItem[]
}

export const UNCATEGORIZED_LABEL = 'Non catégorisé'

export function groupByCategory(items: readonly ShoppingItem[]): ShoppingSection[] {
  const sections: ShoppingSection[] = []
  let current: { category: string; items: ShoppingItem[] } | null = null

  for (const item of items) {
    const category = item.categoryL1 ?? UNCATEGORIZED_LABEL
    if (!current || current.category !== category) {
      current = { category, items: [] }
      sections.push(current)
    }
    current.items.push(item)
  }
  return sections
}

/**
 * Quantite lisible en rayon : « 1,5 kg », « 250 g », et le nombre de pieces
 * quand il a un sens (« ≈ 6 œufs » est plus actionnable que « 360 g »).
 */
export function formatShoppingQuantity(
  item: Pick<ShoppingItem, 'quantityG' | 'pieceCount'>,
  /** "part" pour un plat cuisine (preparation.ts), dont la piece est une part. */
  nomPiece = 'pièce',
): string {
  const base = formatGrams(item.quantityG)
  if (item.pieceCount === null) return base
  const rounded = Math.round(item.pieceCount * 10) / 10
  const plural = rounded > 1 ? 's' : ''
  return `${base} · ≈ ${rounded.toLocaleString('fr-FR')} ${nomPiece}${plural}`
}

/**
 * Rendu texte, pour le partage et le presse-papiers.
 *
 * Le desktop alignait sur 40 colonnes a chasse fixe. Inutile ici : la
 * destination est une application de messagerie ou de notes sur telephone,
 * en police proportionnelle, ou le remplissage produit des colonnes bancales.
 */
export function formatAsText(list: ShoppingList): string {
  if (list.items.length === 0) {
    return `Liste de courses — ${list.isoWeek}\n\n(aucun ingrédient)\n`
  }

  const lines: string[] = [`Liste de courses — ${list.isoWeek}`, '']
  for (const section of groupByCategory(list.items)) {
    lines.push(`— ${section.category} —`)
    for (const item of section.items) {
      const cost = item.costEur ? ` (${item.costEur.replace('.', ',')} €)` : ''
      lines.push(`☐ ${item.name} · ${formatShoppingQuantity(item)}${cost}`)
    }
    lines.push('')
  }

  const total = list.totalEur.replace('.', ',')
  lines.push(
    list.missingPriceCount > 0
      ? `Total : ${total} € · ${list.missingPriceCount} ingrédient(s) sans prix`
      : `Total : ${total} €`,
  )
  return lines.join('\n') + '\n'
}
