import { describe, expect, it } from 'vitest'

import { SCAN_QUESTIONS, interpretScan, isEmptyScan, isScanKind } from './scan.js'

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

describe('interpretScan, pesee', () => {
  it('lit le poids net et le prix a payer', () => {
    expect(interpretScan('pesee', { poids: 0.734, unite: 'kg', prix: 2.19, texte_lu: '0,734 kg 2,19 €' })).toEqual({
      kind: 'pesee',
      poidsG: 734,
      prixEur: 2.19,
      texte: '0,734 kg 2,19 €',
    })
  })

  it('garde ce qui est lisible quand l’autre valeur manque', () => {
    expect(interpretScan('pesee', { poids: 412, unite: 'g', prix: null, texte_lu: null })).toMatchObject({
      poidsG: 412,
      prixEur: null,
    })
  })
})

describe('interpretScan, produit', () => {
  it('rend nom, marque et quantite', () => {
    expect(
      interpretScan('produit', { nom: 'Thon à l’huile d’olive', marque: 'Nixe', nombre: 3, contenance: 80, unite: 'g' }),
    ).toEqual({ kind: 'produit', nom: 'Thon à l’huile d’olive', marque: 'Nixe', nombre: 3, contenanceG: 80 })
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
    expect(isEmptyScan(interpretScan('pesee', { poids: null, unite: null, prix: 2.1 }))).toBe(false)
    expect(isEmptyScan(interpretScan('nutrition', {}))).toBe(true)
    expect(isEmptyScan(interpretScan('produit', { nom: 'Yaourt nature' }))).toBe(false)
  })
})

describe('les questions', () => {
  it('ont chacune un outil dont le schema exige ses champs', () => {
    for (const { tool } of Object.values(SCAN_QUESTIONS)) {
      expect(tool.input_schema['type']).toBe('object')
      expect(Array.isArray(tool.input_schema['required'])).toBe(true)
    }
  })

  it('reconnaissent leurs trois noms et rien d’autre', () => {
    expect(['date', 'prix', 'quantite', 'pesee', 'produit', 'nutrition'].every(isScanKind)).toBe(true)
    expect(isScanKind('poids')).toBe(false)
    expect(isScanKind(null)).toBe(false)
  })
})
