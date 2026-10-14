import { describe, expect, it } from 'vitest'

import {
  apportsDuPlat,
  estUnPlat,
  lignesPourParts,
  nomDuPlat,
  poidsCuitEstime,
  preparationWriteSchema,
  sortiesDuFrigo,
} from './preparation.js'

const macros = (kcal: number | null, proteins: number | null, carbs: number | null, fats: number | null) => ({
  kcal,
  proteins,
  carbs,
  sugars: 0,
  fats,
  saturatedFats: 0,
  fiber: 0,
  salt: 0,
})

describe('apportsDuPlat', () => {
  it('ramene le total des vrais ingredients a 100 g de plat cuit', () => {
    // 200 g de riz cru (360 kcal/100 g) et 100 g de sauce (80 kcal/100 g), 800 g cuits.
    const { total, pour100g, inconnues } = apportsDuPlat(
      [
        { ingredient: macros(360, 7, 78, 1), quantityG: 200 },
        { ingredient: macros(80, 2, 10, 3), quantityG: 100 },
      ],
      800,
    )
    expect(total.kcal).toBeCloseTo(800)
    expect(pour100g.kcal).toBeCloseTo(100)
    expect(pour100g.proteins).toBeCloseTo((14 + 2) / 8)
    expect(inconnues).toBe(0)
  })

  it('compte zero pour une macro inconnue, et le dit', () => {
    const { pour100g, inconnues } = apportsDuPlat([{ ingredient: macros(null, null, 10, 1), quantityG: 100 }], 100)
    expect(pour100g.kcal).toBe(0)
    expect(inconnues).toBe(1)
  })
})

describe('poidsCuitEstime et lignesPourParts', () => {
  it('estime le plat cuit par le rendement de chaque ligne', () => {
    expect(
      poidsCuitEstime([
        { ingredient: { cookedWeightPer100gRaw: 300 }, quantityG: 100 },
        { ingredient: { cookedWeightPer100gRaw: null }, quantityG: 400 },
      ]),
    ).toBe(700)
  })

  it('ramene une recette de 4 portions a 6 parts', () => {
    const lignes = lignesPourParts({ defaultPortions: 4, lines: [{ quantityG: 400, nom: 'pelees' }] }, 6)
    expect(lignes).toEqual([{ quantityG: 600, nom: 'pelees' }])
  })
})

describe('nomDuPlat et estUnPlat', () => {
  it('nomme le plat par sa recette et son jour', () => {
    expect(nomDuPlat(' Chili con carne ', '2026-10-13')).toBe('Chili con carne du 13/10')
  })

  it('reconnait la fiche d’un plat a sa reference', () => {
    expect(estUnPlat({ source: 'manual', sourceRef: 'plat:12' })).toBe(true)
    expect(estUnPlat({ source: 'manual', sourceRef: null })).toBe(false)
    expect(estUnPlat({ source: 'openfoodfacts', sourceRef: 'plat:12' })).toBe(false)
  })
})

describe('sortiesDuFrigo', () => {
  const lot = (id: number, ingredientId: number, quantityG: number, expiryDate: string | null) => ({
    id,
    ingredientId,
    quantityG,
    expiryDate,
  })

  it('prend d’abord ce qui perime le plus tot, sans date en dernier', () => {
    const sorties = sortiesDuFrigo(
      [{ ingredientId: 1, quantityG: 300 }],
      [lot(10, 1, 200, null), lot(11, 1, 200, '2026-10-20'), lot(12, 1, 200, '2026-10-15')],
    )
    expect(sorties).toEqual([
      { lotId: 12, ingredientId: 1, quantityG: 200, vide: true },
      { lotId: 11, ingredientId: 1, quantityG: 100, vide: false },
    ])
  })

  it('additionne deux lignes du meme ingredient, et ne sort jamais plus que le frigo', () => {
    const sorties = sortiesDuFrigo(
      [
        { ingredientId: 1, quantityG: 150 },
        { ingredientId: 1, quantityG: 150 },
        { ingredientId: 2, quantityG: 5 },
      ],
      [lot(10, 1, 250, '2026-10-15')],
    )
    expect(sorties).toEqual([{ lotId: 10, ingredientId: 1, quantityG: 250, vide: true }])
  })

  it('finit un lot dont il ne resterait que l’arrondi d’une conversion', () => {
    const [sortie] = sortiesDuFrigo([{ ingredientId: 1, quantityG: 199.6 }], [lot(10, 1, 200, null)])
    expect(sortie?.vide).toBe(true)
  })
})

describe('preparationWriteSchema', () => {
  const base = {
    name: 'Chili du 13/10',
    cookedOn: '2026-10-13',
    cookedWeightG: 1200,
    lines: [{ ingredientId: 1, quantityG: 400 }],
  }

  it('accepte un plat minimal, et met les defauts', () => {
    expect(preparationWriteSchema.parse(base)).toMatchObject({ recipeId: null, entryId: null, parts: null, myPartG: null })
  })

  it('refuse une part plus grosse que le plat, ou une part sans repas', () => {
    expect(preparationWriteSchema.safeParse({ ...base, entryId: 4, myPartG: 1300 }).success).toBe(false)
    expect(preparationWriteSchema.safeParse({ ...base, myPartG: 400 }).success).toBe(false)
    expect(preparationWriteSchema.safeParse({ ...base, entryId: 4, myPartG: 400 }).success).toBe(true)
  })

  it('refuse un plat sans ingredient', () => {
    expect(preparationWriteSchema.safeParse({ ...base, lines: [] }).success).toBe(false)
  })
})
