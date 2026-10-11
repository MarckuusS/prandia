import { describe, expect, it } from 'vitest'

import { SCAN_QUESTIONS, interpretScan, isScanKind } from './scan.js'

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

describe('les questions', () => {
  it('ont chacune un outil dont le schema exige ses champs', () => {
    for (const { tool } of Object.values(SCAN_QUESTIONS)) {
      expect(tool.input_schema['type']).toBe('object')
      expect(Array.isArray(tool.input_schema['required'])).toBe(true)
    }
  })

  it('reconnaissent leurs trois noms et rien d’autre', () => {
    expect(['date', 'prix', 'quantite'].every(isScanKind)).toBe(true)
    expect(isScanKind('poids')).toBe(false)
    expect(isScanKind(null)).toBe(false)
  })
})
