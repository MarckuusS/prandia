/**
 * Portage de tests/test_pricing.py — mêmes valeurs, mêmes attendus.
 * Les cas d'arrondi sont ceux qui garantissent que les totaux affiches sur le
 * web seront identiques au centime pres a ceux du desktop.
 */

import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { ingredientSchema, recipeSchema, type Ingredient, type Recipe } from './models.js'
import {
  formatEuros,
  ingredientCost,
  lastPaidPrice,
  mealPlanEntryCost,
  mealPlanEntryCostDetail,
  pricePerG,
  recipeCost,
} from './pricing.js'

const priced = (name: string, priceEur: string, qtyRefG: number): Ingredient =>
  ingredientSchema.parse({ name, source: 'manual', priceEur, priceQuantityG: qtyRefG })

const unpriced = (name: string): Ingredient =>
  ingredientSchema.parse({ name, source: 'manual' })

const recipeOf = (name: string, portions: number, lines: Recipe['lines']): Recipe =>
  recipeSchema.parse({ name, defaultPortions: portions, lines })

describe('recipeCost', () => {
  it('somme les couts de lignes', () => {
    const flour = priced('Flour', '1.00', 1000) // 0,001 €/g
    const butter = priced('Butter', '4.00', 250) // 0,016 €/g
    const cake = recipeOf('Cake', 4, [
      { ingredient: flour, quantityG: 500, unit: null, notes: null, ordinal: 0 }, // 0,50
      { ingredient: butter, quantityG: 250, unit: null, notes: null, ordinal: 1 }, // 4,00
    ])
    const { total, missing } = recipeCost(cake)
    expect(total.toFixed(2)).toBe('4.50')
    expect(missing).toEqual([])
  })

  it('divise par le nombre de portions', () => {
    const flour = priced('Flour', '1.00', 1000)
    const bread = recipeOf('Bread', 4, [
      { ingredient: flour, quantityG: 400, unit: null, notes: null, ordinal: 0 }, // 0,40
    ])
    expect(recipeCost(bread).perPortion.toFixed(2)).toBe('0.10')
  })

  it('signale les lignes sans prix au lieu de les compter a zero', () => {
    const bread = recipeOf('Bread', 1, [
      { ingredient: priced('Flour', '1.00', 1000), quantityG: 500, unit: null, notes: null, ordinal: 0 },
      { ingredient: unpriced('Salt'), quantityG: 10, unit: null, notes: null, ordinal: 1 },
    ])
    const { total, missing } = recipeCost(bread)
    expect(total.toFixed(2)).toBe('0.50')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.ingredient.name).toBe('Salt')
  })

  it('rend zero sur une recette vide', () => {
    const { total, perPortion } = recipeCost(recipeOf('Vide', 4, []))
    expect(total.toFixed(2)).toBe('0.00')
    expect(perPortion.toFixed(2)).toBe('0.00')
  })
})

describe('ingredientCost', () => {
  it('rend null quand l ingredient n a pas de prix', () => {
    expect(ingredientCost(unpriced('Salt'), 100)).toBeNull()
  })

  it('arrondit au centime en ROUND_HALF_UP', () => {
    // 80 x 3,99 / 250 = 1,2768 -> 1,28
    expect(ingredientCost(priced('Cheese', '3.99', 250), 80)?.toFixed(2)).toBe('1.28')
  })

  it('arrondit 0,125 vers le haut, pas vers le pair', () => {
    // Le coeur de l'annexe #5 : en HALF_EVEN (defaut Python) ce serait 0,12.
    // Le desktop appliquait les deux modes selon le module appele.
    expect(ingredientCost(priced('X', '0.25', 200), 100)?.toFixed(2)).toBe('0.13')
  })

  it('traite une quantite de reference nulle comme un prix absent', () => {
    // Comportement du Python (`not self.price_quantity_g`) : pas de division par zero.
    const weird = ingredientSchema.parse({ name: 'Bizarre', priceEur: '1.00' })
    expect(pricePerG(weird)).toBeNull()
    expect(ingredientCost(weird, 100)).toBeNull()
  })
})

describe('pricePerG', () => {
  it('ne perd pas de precision avant la multiplication', () => {
    // 3,99 / 250 = 0,01596 : arrondir ici donnerait 0,02 €/g, soit +25 % sur 80 g.
    expect(pricePerG(priced('Cheese', '3.99', 250))?.toString()).toBe('0.01596')
  })
})

describe('formatEuros', () => {
  // Trois espaces differentes se croisent dans un montant francais formate.
  // Les nommer est le seul moyen d'ecrire un attendu relisible : a l'oeil nu
  // elles sont identiques, pour `===` elles ne le sont pas.
  const NBSP = ' ' // espace insecable, avant le symbole monetaire
  const NNBSP = ' ' // espace FINE insecable, separateur de milliers choisi par Intl en fr-FR

  it('formate a la francaise', () => {
    expect(formatEuros(new Decimal('12.5'))).toBe(`12,50${NBSP}€`)
    expect(formatEuros('0')).toBe(`0,00${NBSP}€`)
    expect(formatEuros(null)).toBe('—')
  })

  it('separe les milliers par une espace fine insecable', () => {
    expect(formatEuros('1234.567')).toBe(`1${NNBSP}234,57${NBSP}€`)
    // Et surtout PAS avec une espace ordinaire : c'est l'erreur qu'on ne voit
    // pas en relisant, et qui fait echouer une comparaison de chaines.
    expect(formatEuros('1234.567')).not.toBe(`1 234,57 €`)
  })
})

describe('mealPlanEntryCostDetail', () => {
  const flour = priced('Flour', '1.00', 1000) // 0,001 EUR/g
  const butter = priced('Butter', '4.00', 250) // 0,016 EUR/g

  /**
   * Le cas qui a motive la correction : une recette partiellement valorisee.
   *
   * L'ancien code ne rendait que le montant. Comme il n'etait pas `null`,
   * l'ecran Semaine concluait que le cout etait complet, affichait
   * "0 repas sans prix" et presentait un budget sous-estime comme sur.
   */
  it('compte les LIGNES sans prix, meme quand le cout est chiffrable', () => {
    const cake = recipeOf('Cake', 4, [
      { ingredient: flour, quantityG: 500, unit: null, notes: null, ordinal: 0 }, // 0,50
      { ingredient: butter, quantityG: 250, unit: null, notes: null, ordinal: 1 }, // 4,00
      { ingredient: unpriced('Vanille'), quantityG: 5, unit: null, notes: null, ordinal: 2 },
      { ingredient: unpriced('Sel'), quantityG: 2, unit: null, notes: null, ordinal: 3 },
    ])
    const detail = mealPlanEntryCostDetail(
      { portions: 4, quantityG: null },
      { kind: 'recipe', recipe: cake },
    )
    expect(detail.cost?.toFixed(2)).toBe('4.50')
    expect(detail.missingLines).toBe(2)
  })

  it('rend un cout complet et zero ligne manquante quand tout est valorise', () => {
    const bread = recipeOf('Bread', 4, [
      { ingredient: flour, quantityG: 400, unit: null, notes: null, ordinal: 0 },
    ])
    const detail = mealPlanEntryCostDetail(
      { portions: 2, quantityG: null },
      { kind: 'recipe', recipe: bread },
    )
    expect(detail.cost?.toFixed(2)).toBe('0.20') // 0,40 x 2/4
    expect(detail.missingLines).toBe(0)
  })

  it('rend un cout nul et toutes les lignes quand pas une seule na de prix', () => {
    const soup = recipeOf('Soupe', 2, [
      { ingredient: unpriced('Eau'), quantityG: 500, unit: null, notes: null, ordinal: 0 },
      { ingredient: unpriced('Herbes'), quantityG: 10, unit: null, notes: null, ordinal: 1 },
    ])
    const detail = mealPlanEntryCostDetail(
      { portions: 1, quantityG: null },
      { kind: 'recipe', recipe: soup },
    )
    expect(detail.cost).toBeNull()
    expect(detail.missingLines).toBe(2)
  })

  it('compte une entree ingredient sans prix pour une ligne', () => {
    const detail = mealPlanEntryCostDetail(
      { portions: null, quantityG: 150 },
      { kind: 'ingredient', ingredient: unpriced('Pomme') },
    )
    expect(detail.cost).toBeNull()
    expect(detail.missingLines).toBe(1)
  })

  it('laisse mealPlanEntryCost inchange pour les appelants existants', () => {
    const cake = recipeOf('Cake', 2, [
      { ingredient: flour, quantityG: 500, unit: null, notes: null, ordinal: 0 },
      { ingredient: unpriced('Vanille'), quantityG: 5, unit: null, notes: null, ordinal: 1 },
    ])
    const target = { kind: 'recipe', recipe: cake } as const
    expect(mealPlanEntryCost({ portions: 2, quantityG: null }, target)?.toFixed(2)).toBe(
      mealPlanEntryCostDetail({ portions: 2, quantityG: null }, target).cost?.toFixed(2),
    )
  })
})

describe('lastPaidPrice', () => {
  // Dans l'ordre de l'API : le plus recent d'abord.
  const historique = [
    { priceEur: '2.10', quantityG: 500, store: 'Carrefour', recordedAt: '2026-10-02' },
    { priceEur: '1.89', quantityG: 500, store: 'Lidl', recordedAt: '2026-09-20' },
    { priceEur: '1.79', quantityG: 500, store: 'Lidl', recordedAt: '2026-08-01' },
  ]

  it('prend le dernier prix du MEME magasin, casse et accents ignores', () => {
    const p = lastPaidPrice(historique, { store: ' lidl ', quantityG: 500 })
    expect(p).toMatchObject({ priceEur: '1.89', sameStore: true })
    expect(p?.from.recordedAt).toBe('2026-09-20')
  })

  it('retombe sur le dernier prix tous magasins, en le disant', () => {
    expect(lastPaidPrice(historique, { store: 'Intermarché', quantityG: 500 })).toMatchObject({
      priceEur: '2.10',
      sameStore: false,
    })
    expect(lastPaidPrice(historique, { store: null, quantityG: 500 })?.priceEur).toBe('2.10')
  })

  it('ramene le montant a la quantite demandee', () => {
    expect(lastPaidPrice(historique, { store: 'Lidl', quantityG: 1000 })?.priceEur).toBe('3.78')
    expect(lastPaidPrice(historique, { store: 'Lidl', quantityG: 250 })?.priceEur).toBe('0.95')
  })

  it('garde la quantite du releve quand aucune n’est demandee', () => {
    expect(lastPaidPrice(historique, { store: 'Lidl', quantityG: null })?.priceEur).toBe('1.89')
  })

  it('ne suit pas l’ordre recu mais la date du releve', () => {
    const melange = [historique[2], historique[0], historique[1]].filter((e) => e !== undefined)
    expect(lastPaidPrice(melange, { store: 'Lidl', quantityG: 500 })?.from.recordedAt).toBe('2026-09-20')
  })

  it('rend null sans historique', () => {
    expect(lastPaidPrice([], { store: 'Lidl', quantityG: 500 })).toBeNull()
  })
})
