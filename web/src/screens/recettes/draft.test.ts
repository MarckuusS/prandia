import { describe, expect, it } from 'vitest'
import { ingredientSchema, type Ingredient } from '@prandia/shared'

import { replaceIngredient, type DraftLine } from './draft.js'

const fiche = (id: number, name: string, extra: Partial<Ingredient> = {}): Ingredient =>
  ingredientSchema.parse({ id, name, source: 'manual', ...extra })

const ligne = (ingredient: Ingredient, quantityG: number | null, unit: string | null): DraftLine => ({
  key: 'l1',
  ingredient,
  quantityG,
  unit,
  notes: 'égoutter',
  ordinal: 3,
})

describe('replaceIngredient', () => {
  it('garde une quantite en grammes, en cuilleres ou en litres telle quelle', () => {
    const margarine = fiche(2, 'Margarine')
    expect(replaceIngredient(ligne(fiche(1, 'Beurre'), 15, 'c_cafe'), margarine)).toMatchObject({
      ingredient: margarine,
      quantityG: 15,
      unit: 'c_cafe',
    })
    expect(replaceIngredient(ligne(fiche(1, 'Crème liquide'), 250, 'cl'), margarine)).toMatchObject({
      quantityG: 250,
      unit: 'cl',
    })
  })

  it('garde le NOMBRE de cuilleres, au poids de la cuillere du nouvel ingredient', () => {
    // Trois cuilleres de farine (8 g) remplacees par du sucre (12 g).
    const farine = fiche(1, 'Farine', { spoonWeightG: 8 })
    const sucre = fiche(2, 'Sucre', { spoonWeightG: 12 })
    expect(replaceIngredient(ligne(farine, 24, 'c_soupe'), sucre)).toMatchObject({
      quantityG: 36,
      unit: 'c_soupe',
    })
    // Sans poids de cuillere, une cuillere compte comme de l'eau.
    expect(replaceIngredient(ligne(farine, 24, 'c_soupe'), fiche(3, 'Eau'))).toMatchObject({ quantityG: 45 })
  })

  it('garde le NOMBRE de pieces, et repese avec la nouvelle piece', () => {
    // Deux oignons remplaces par deux echalotes ne pesent pas pareil.
    const oignon = fiche(1, 'Oignon', { pieceWeightG: 150 })
    const echalote = fiche(2, 'Échalote', { pieceWeightG: 30 })
    expect(replaceIngredient(ligne(oignon, 300, '_piece'), echalote)).toMatchObject({
      quantityG: 60,
      unit: '_piece',
    })
  })

  it('lit une unite absente comme la piece, quand l’ancien ingredient en avait une', () => {
    const oeuf = fiche(1, 'Oeuf', { pieceWeightG: 50 })
    const oeufBio = fiche(2, 'Oeuf bio', { pieceWeightG: 60 })
    expect(replaceIngredient(ligne(oeuf, 100, null), oeufBio)).toMatchObject({ quantityG: 120, unit: '_piece' })
  })

  it('garde la MASSE quand le nouvel ingredient n’a pas de piece', () => {
    const oignon = fiche(1, 'Oignon', { pieceWeightG: 150 })
    expect(replaceIngredient(ligne(oignon, 300, '_piece'), fiche(2, 'Oignon surgelé'))).toMatchObject({
      quantityG: 300,
      unit: 'g',
    })
  })

  it('garde le cuit quand le nouvel ingredient a un rendement, la masse sinon', () => {
    const riz = fiche(1, 'Riz basmati', { cookedWeightPer100gRaw: 300 })
    const rizComplet = fiche(2, 'Riz complet', { cookedWeightPer100gRaw: 250 })
    // 200 g cuits : 66,7 g de basmati cru, 80 g de riz complet cru.
    const remplace = replaceIngredient(ligne(riz, 200 / 3, '_cuit'), rizComplet)
    expect(remplace.unit).toBe('_cuit')
    expect(remplace.quantityG).toBeCloseTo(80, 6)
    expect(replaceIngredient(ligne(riz, 200 / 3, '_cuit'), fiche(3, 'Quinoa'))).toMatchObject({ unit: 'g' })
  })

  it('garde la cle, la note et le rang de la ligne', () => {
    const remplace = replaceIngredient(ligne(fiche(1, 'Beurre'), 15, 'g'), fiche(2, 'Margarine'))
    expect(remplace).toMatchObject({ key: 'l1', notes: 'égoutter', ordinal: 3 })
  })

  it('laisse vide une quantite encore vide', () => {
    const oignon = fiche(1, 'Oignon', { pieceWeightG: 150 })
    expect(replaceIngredient(ligne(oignon, null, '_piece'), fiche(2, 'Échalote', { pieceWeightG: 30 }))).toMatchObject({
      quantityG: null,
      unit: '_piece',
    })
  })
})
