import { describe, expect, it } from 'vitest'
import type { ArticleLu } from '@prandia/shared'

import { appliquerArticle, emptyDraft, type ItemDraft } from './sessionDraft.js'

const AUJOURDHUI = '2026-10-13'

/** Un fromage blanc scanne : nom et contenance d'OpenFoodFacts, rien d'autre. */
const scanne: ItemDraft = {
  ...emptyDraft('3033490004743'),
  name: 'Fromage blanc nature',
  brand: 'Danone',
  quantityG: 500,
  pieceWeightG: 500,
}

const rien: ArticleLu = {
  prixEur: null,
  nombre: null,
  contenanceG: null,
  pese: false,
  dateTexte: null,
  nom: null,
  marque: null,
  autreProduit: false,
}

describe('appliquerArticle, ce que Savarin a lu sur les photos', () => {
  it('pose prix, lot et date, et dit lesquels pour les encadrer', () => {
    const lu = { ...rien, prixEur: 2.19, nombre: 4, contenanceG: 125, dateTexte: '17.10' }
    const { draft, champs } = appliquerArticle(scanne, scanne, lu, AUJOURDHUI)
    expect(draft).toMatchObject({ priceEur: 2.19, quantityG: 500, pieceWeightG: 125, expiryDate: '2026-10-17' })
    expect(champs).toEqual(['quantityG', 'priceEur', 'expiryDate'])
  })

  it('remplace la contenance d’OpenFoodFacts restee intacte : le poids a ete photographie pour etre pris', () => {
    const { draft } = appliquerArticle(scanne, scanne, { ...rien, contenanceG: 450 }, AUJOURDHUI)
    expect(draft.quantityG).toBe(450)
  })

  it('garde ce que la personne a touche apres l’envoi des photos', () => {
    const touche: ItemDraft = { ...scanne, priceEur: 1.99, quantityG: 1000 }
    const lu = { ...rien, prixEur: 2.19, contenanceG: 125, nombre: 1, dateTexte: '17/10/26' }
    const { draft, champs } = appliquerArticle(touche, scanne, lu, AUJOURDHUI)
    expect(draft).toMatchObject({ priceEur: 1.99, quantityG: 1000, pieceWeightG: 500, expiryDate: '2026-10-17' })
    expect(champs).toEqual(['expiryDate'])
  })

  it('ne remplit le nom et la marque que vides', () => {
    const lu = { ...rien, nom: 'Faisselle', marque: 'Rians' }
    expect(appliquerArticle(scanne, scanne, lu, AUJOURDHUI).champs).toEqual([])
    const sansNom = { ...emptyDraft(null), quantityG: 200 }
    const { draft, champs } = appliquerArticle(sansNom, sansNom, lu, AUJOURDHUI)
    expect(draft).toMatchObject({ name: 'Faisselle', brand: 'Rians' })
    expect(champs).toEqual(['name', 'brand'])
  })

  it('lit une etiquette de balance comme un poids pese, plus rien a peser en caisse', () => {
    const vrac: ItemDraft = { ...emptyDraft(null), name: 'Comté', aPeser: true }
    const { draft } = appliquerArticle(vrac, vrac, { ...rien, contenanceG: 734, pese: true, prixEur: 13.2 }, AUJOURDHUI)
    expect(draft).toMatchObject({ quantityG: 734, pieceWeightG: null, aPeser: false, priceEur: 13.2 })
  })

  it('ignore une date illisible au lieu de vider le champ', () => {
    const avecDate: ItemDraft = { ...scanne, expiryDate: '2026-10-20' }
    const { draft, champs } = appliquerArticle(avecDate, avecDate, { ...rien, dateTexte: 'L2861' }, AUJOURDHUI)
    expect(draft.expiryDate).toBe('2026-10-20')
    expect(champs).toEqual([])
  })
})

describe('appliquerArticle, la face avant montre un autre produit', () => {
  // OpenFoodFacts rangeait le code de ces tenders sous "Mini saucissons" (2026-10-15).
  const scanneFaux: ItemDraft = {
    ...emptyDraft('3770018078854'),
    name: 'Mini saucissons',
    quantityG: 192,
    macros: { kcal: 400, proteins: 20 },
  }
  const lu = { ...rien, autreProduit: true, nom: 'Tenders croustillants', marque: 'La Vie' }

  it('prend le nom et la marque de la photo, et ecarte les valeurs du mauvais produit', () => {
    const { draft, champs } = appliquerArticle(scanneFaux, scanneFaux, lu, AUJOURDHUI)
    expect(draft).toMatchObject({ name: 'Tenders croustillants', brand: 'La Vie', macros: null, ean: '3770018078854' })
    expect(champs).toEqual(['name', 'brand'])
  })

  it('laisse un produit de la bibliotheque, et un nom corrige a la main', () => {
    const connu = { ...scanneFaux, ingredientId: 12 }
    expect(appliquerArticle(connu, connu, lu, AUJOURDHUI).draft.name).toBe('Mini saucissons')
    const retouche = { ...scanneFaux, name: 'Tenders' }
    expect(appliquerArticle(retouche, scanneFaux, lu, AUJOURDHUI).draft.name).toBe('Tenders')
  })
})
