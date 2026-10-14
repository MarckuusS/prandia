import { describe, expect, it } from 'vitest'

import {
  ARTICLE_TOOL,
  SCAN_QUESTIONS,
  interpretArticle,
  interpretScan,
  isEmptyArticle,
  isEmptyScan,
  isScanKind,
} from './scan.js'

describe('interpretScan, date', () => {
  it('rend la date telle que lue, sans la transformer', () => {
    // C'est `parseExpiryText`, cote ecran, qui la comprend : le meme chemin
    // que la saisie au clavier et que la lecture de l'iPhone.
    expect(interpretScan('date', { texte: ' 30.06.2028 ' })).toEqual({ kind: 'date', texte: '30.06.2028' })
  })

  it('rend null sur une reponse vide ou mal formee', () => {
    expect(interpretScan('date', { texte: null })).toEqual({ kind: 'date', texte: null })
    expect(interpretScan('date', null)).toEqual({ kind: 'date', texte: null })
    expect(interpretScan('date', { texte: 42 })).toEqual({ kind: 'date', texte: null })
  })
})

describe('interpretScan, prix', () => {
  it('arrondit au centime et garde le texte lu', () => {
    expect(interpretScan('prix', { prix: 2.494, texte_lu: '2,49 €' })).toEqual({
      kind: 'prix',
      prixEur: 2.49,
      texte: '2,49 €',
    })
  })

  it('accepte une virgule decimale', () => {
    expect(interpretScan('prix', { prix: '1,89', texte_lu: null })).toMatchObject({ prixEur: 1.89 })
  })

  it('vide un prix absurde plutot que de le proposer', () => {
    expect(interpretScan('prix', { prix: 0, texte_lu: null })).toMatchObject({ prixEur: null })
    expect(interpretScan('prix', { prix: 1249, texte_lu: '12,49' })).toMatchObject({ prixEur: null })
    expect(interpretScan('prix', { prix: null, texte_lu: null })).toMatchObject({ prixEur: null })
  })
})

describe('interpretScan, quantite', () => {
  it('lit un lot et ramene la contenance en grammes', () => {
    expect(interpretScan('quantite', { nombre: 12, contenance: 125, unite: 'g', texte_lu: '12 x 125 g' })).toEqual({
      kind: 'quantite',
      nombre: 12,
      contenanceG: 125,
      prixEur: null,
      texte: '12 x 125 g',
    })
    expect(interpretScan('quantite', { nombre: 6, contenance: 33, unite: 'cl', texte_lu: null })).toMatchObject({
      nombre: 6,
      contenanceG: 330,
    })
    expect(interpretScan('quantite', { nombre: 1, contenance: 1.5, unite: 'kg', texte_lu: null })).toMatchObject({
      contenanceG: 1500,
    })
  })

  it('compte une unite quand le nombre manque', () => {
    expect(interpretScan('quantite', { nombre: null, contenance: 500, unite: 'g', texte_lu: null })).toMatchObject({
      nombre: 1,
      contenanceG: 500,
    })
  })

  it('vide une contenance sans unite connue ou absurde', () => {
    expect(interpretScan('quantite', { nombre: 1, contenance: 500, unite: 'oz', texte_lu: null })).toMatchObject({
      contenanceG: null,
    })
    expect(interpretScan('quantite', { nombre: 1, contenance: 125, unite: 'kg', texte_lu: null })).toMatchObject({
      contenanceG: null,
    })
    expect(interpretScan('quantite', { nombre: 500, contenance: 1, unite: 'g', texte_lu: null })).toMatchObject({
      nombre: null,
    })
  })
})

describe('interpretScan, quantite sur une etiquette de balance', () => {
  it('rend le poids net ET le prix a payer, imprime a cote', () => {
    expect(
      interpretScan('quantite', { nombre: 1, contenance: 0.734, unite: 'kg', prix_balance: 2.19, texte_lu: '0,734 kg' }),
    ).toEqual({ kind: 'quantite', nombre: 1, contenanceG: 734, prixEur: 2.19, texte: '0,734 kg' })
  })

  it('garde le prix seul quand le poids est illisible, et vide un prix absurde', () => {
    expect(interpretScan('quantite', { nombre: null, contenance: null, unite: null, prix_balance: 3.4 })).toMatchObject({
      contenanceG: null,
      prixEur: 3.4,
    })
    expect(interpretScan('quantite', { nombre: 1, contenance: 412, unite: 'g', prix_balance: 900 })).toMatchObject({
      contenanceG: 412,
      prixEur: null,
    })
  })
})

describe('interpretScan, nom et marque', () => {
  it('rend chacun seul, borne et nettoye', () => {
    expect(interpretScan('nom', { nom: '  Thon à l’huile d’olive ' })).toEqual({ kind: 'nom', nom: 'Thon à l’huile d’olive' })
    expect(interpretScan('marque', { marque: 'Nixe' })).toEqual({ kind: 'marque', marque: 'Nixe' })
    expect(interpretScan('nom', { nom: '' })).toEqual({ kind: 'nom', nom: null })
    expect(interpretScan('marque', {})).toEqual({ kind: 'marque', marque: null })
  })
})

describe('interpretScan, nutrition', () => {
  it('rend les huit valeurs pour 100 g', () => {
    expect(
      interpretScan('nutrition', {
        energie_kcal: 181,
        matieres_grasses: 9.5,
        acides_gras_satures: 1.6,
        glucides: 0,
        sucres: 0,
        fibres: 0,
        proteines: 24,
        sel: 1.1,
      }),
    ).toEqual({
      kind: 'nutrition',
      kcal: 181,
      fats: 9.5,
      saturatedFats: 1.6,
      carbs: 0,
      sugars: 0,
      fiber: 0,
      proteins: 24,
      salt: 1.1,
    })
  })

  it('vide une sous-ligne plus grande que sa ligne, et une valeur impossible', () => {
    const r = interpretScan('nutrition', {
      energie_kcal: 2500,
      matieres_grasses: 3,
      acides_gras_satures: 12,
      glucides: 10,
      sucres: 45,
      fibres: null,
      proteines: 5,
      sel: 0.2,
    })
    expect(r).toMatchObject({ kcal: null, saturatedFats: null, sugars: null, fats: 3, carbs: 10 })
  })
})

describe('isEmptyScan', () => {
  it('dit qu’une lecture n’a rien rendu d’utilisable', () => {
    expect(isEmptyScan(interpretScan('date', { texte: null }))).toBe(true)
    expect(isEmptyScan(interpretScan('quantite', { contenance: null, prix_balance: 2.1 }))).toBe(false)
    expect(isEmptyScan(interpretScan('quantite', { contenance: null, prix_balance: null }))).toBe(true)
    expect(isEmptyScan(interpretScan('nutrition', {}))).toBe(true)
    expect(isEmptyScan(interpretScan('nom', { nom: 'Yaourt nature' }))).toBe(false)
    expect(isEmptyScan(interpretScan('marque', { marque: null }))).toBe(true)
  })
})

describe('les questions', () => {
  it('ont chacune un outil dont le schema exige ses champs', () => {
    for (const { tool } of Object.values(SCAN_QUESTIONS)) {
      expect(tool.input_schema['type']).toBe('object')
      expect(Array.isArray(tool.input_schema['required'])).toBe(true)
    }
  })

  it('reconnaissent leurs six noms et rien d’autre', () => {
    expect(['date', 'prix', 'quantite', 'nom', 'marque', 'nutrition'].every(isScanKind)).toBe(true)
    // "pesee" est devenue la lecture du poids, "produit" un champ a la fois.
    expect(['pesee', 'produit', 'poids'].some(isScanKind)).toBe(false)
    expect(isScanKind(null)).toBe(false)
  })
})

describe('interpretArticle, plusieurs photos d’un meme article', () => {
  it('rend prix, lot, date, nom et marque lus sur des photos differentes', () => {
    expect(
      interpretArticle({
        prix: 2.19,
        nombre: 4,
        contenance: 125,
        unite: 'g',
        pese: false,
        date: '17.10',
        nom: 'Fromage blanc nature',
        marque: 'Danone',
      }),
    ).toEqual({
      prixEur: 2.19,
      nombre: 4,
      contenanceG: 125,
      pese: false,
      dateTexte: '17.10',
      nom: 'Fromage blanc nature',
      marque: 'Danone',
    })
  })

  it('lit une etiquette de balance comme un poids pese', () => {
    const lu = interpretArticle({ prix: '3,47', nombre: 1, contenance: 0.734, unite: 'kg', pese: true, date: null, nom: null, marque: null })
    expect(lu).toMatchObject({ prixEur: 3.47, contenanceG: 734, pese: true })
  })

  it('applique les bornes d’un champ seul, et ne croit pas "pese" sans poids', () => {
    const lu = interpretArticle({ prix: 1200, nombre: 1, contenance: 30, unite: 'kg', pese: true, date: '', nom: '  ', marque: 42 })
    expect(lu).toEqual({ prixEur: null, nombre: null, contenanceG: null, pese: false, dateTexte: null, nom: null, marque: null })
    expect(isEmptyArticle(lu)).toBe(true)
  })

  it('tient une reponse vide ou absente', () => {
    expect(isEmptyArticle(interpretArticle(undefined))).toBe(true)
    expect(isEmptyArticle(interpretArticle({ date: '03/2027' }))).toBe(false)
  })

  it('exige chacun de ses champs dans son outil', () => {
    expect(ARTICLE_TOOL.input_schema['required']).toEqual(Object.keys(ARTICLE_TOOL.input_schema['properties'] as object))
  })
})
