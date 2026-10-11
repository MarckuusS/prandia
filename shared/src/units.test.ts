/**
 * Portage de tests/test_units.py, plus la couverture de l'unite « piece » que
 * le desktop laissait a un composant QML (et que l'import par URL calculait
 * faux — annexe #6 de la spec).
 */

import { describe, expect, it } from 'vitest'
import { cookedWeightG } from './nutrition.js'
import {
  COOKED_UNIT_CODE,
  CUILLERE_SOUPE_G,
  DEFAULT_UNIT_CODE,
  PIECE_UNIT_CODE,
  UNITS,
  UNIT_BY_CODE,
  UnknownUnitError,
  formatGrams,
  fromGrams,
  isKnownUnit,
  labelFor,
  toGrams,
} from './units.js'

describe('table des unites', () => {
  it('a le gramme pour unite par defaut', () => {
    expect(DEFAULT_UNIT_CODE).toBe('g')
    expect(UNIT_BY_CODE.get('g')?.gramsPerUnit).toBe(1.0)
  })

  it("n'a pas de code en double", () => {
    const codes = UNITS.map((u) => u.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('conserve 11 unites, dans l ordre d affichage', () => {
    expect(UNITS.map((u) => u.code)).toEqual([
      'g', 'kg', 'mg', 'ml', 'cl', 'dl', 'L', 'c_cafe', 'c_soupe', 'tasse', 'pincee',
    ])
  })
})

describe('toGrams', () => {
  it('convertit les cas de base', () => {
    expect(toGrams(1, 'g')).toBe(1.0)
    expect(toGrams(1, 'kg')).toBe(1000.0)
    expect(toGrams(500, 'mg')).toBe(0.5)
    expect(toGrams(1, 'L')).toBe(1000.0)
    expect(toGrams(25, 'cl')).toBe(250.0)
    expect(toGrams(1, 'c_soupe')).toBe(15.0)
    expect(toGrams(2, 'tasse')).toBe(500.0)
  })

  it('suppose une densite de 1 g/ml', () => {
    expect(toGrams(100, 'ml')).toBe(toGrams(100, 'g'))
  })
})

describe('fromGrams', () => {
  it('inverse toGrams', () => {
    expect(fromGrams(1000, 'kg')).toBe(1.0)
    expect(fromGrams(0.5, 'mg')).toBe(500.0)
    expect(fromGrams(250, 'cl')).toBe(25.0)
  })

  it('fait un aller-retour fidele pour toutes les unites', () => {
    for (const u of UNITS) {
      for (const v of [1.0, 12.5, 0.1, 1000.0]) {
        expect(fromGrams(toGrams(v, u.code), u.code)).toBeCloseTo(v, 9)
      }
    }
  })
})

describe('unite piece', () => {
  it('convertit via le poids unitaire de l ingredient', () => {
    expect(toGrams(3, PIECE_UNIT_CODE, 60)).toBe(180) // 3 oeufs de 60 g
    expect(fromGrams(180, PIECE_UNIT_CODE, 60)).toBe(3)
  })

  it('refuse de convertir sans poids unitaire', () => {
    // Le desktop traitait ce cas comme des grammes (qty x 1.0) et sous-estimait
    // silencieusement d'un facteur 60 sur les oeufs.
    expect(() => toGrams(3, PIECE_UNIT_CODE)).toThrow(UnknownUnitError)
    expect(() => toGrams(3, PIECE_UNIT_CODE, 0)).toThrow(UnknownUnitError)
    expect(() => toGrams(3, PIECE_UNIT_CODE, null)).toThrow(UnknownUnitError)
  })

  it('affiche le poids dans son libelle', () => {
    expect(labelFor(PIECE_UNIT_CODE, 60)).toBe('pièce (60 g)')
    expect(labelFor(PIECE_UNIT_CODE)).toBe('pièce')
  })
})

describe('libelles et validation', () => {
  it('rend les libelles francais', () => {
    expect(labelFor('g')).toBe('g')
    expect(labelFor('c_soupe')).toBe('c. à soupe')
    expect(labelFor('tasse')).toBe('tasse')
  })

  it('leve sur une unite inconnue', () => {
    expect(() => toGrams(1, 'parsec')).toThrow(UnknownUnitError)
    expect(() => fromGrams(1, 'parsec')).toThrow(UnknownUnitError)
    expect(isKnownUnit('parsec')).toBe(false)
    expect(isKnownUnit('c_cafe')).toBe(true)
    expect(isKnownUnit(PIECE_UNIT_CODE)).toBe(true)
  })
})

describe('formatGrams', () => {
  it('bascule en kg au-dela de 1000 g et utilise la virgule', () => {
    // Espace INSECABLE avant l'unite (U+00A0), d'ou l'echappement explicite.
    expect(formatGrams(250)).toBe('250 g')
    expect(formatGrams(1000)).toBe('1 kg')
    expect(formatGrams(1500)).toBe('1,5 kg')
    expect(formatGrams(12.5)).toBe('12,5 g')
  })

  // Regression : `formatGrams` a longtemps arrondi a UNE decimale partout,
  // ce qui affichait 1250 g en "1,3 kg". 50 g d'ecart sur une ligne de
  // courses. Ces cas verrouillent la regle du desktop, qu'aucun test ne
  // gardait jusqu'ici.
  it('garde deux decimales sous 10 kg, une seule au-dela', () => {
    expect(formatGrams(1250)).toBe('1,25 kg')
    expect(formatGrams(2450)).toBe('2,45 kg')
    expect(formatGrams(9990)).toBe('9,99 kg')
    expect(formatGrams(12500)).toBe('12,5 kg')
    expect(formatGrams(12550)).toBe('12,6 kg')
  })

  it('ne laisse jamais de zero de fin', () => {
    expect(formatGrams(2000)).toBe('2 kg')
    expect(formatGrams(1200)).toBe('1,2 kg')
    expect(formatGrams(60)).toBe('60 g')
  })

  it('reste plus fin que le desktop sous 100 g', () => {
    // Le QML arrondissait a l'entier des 10 g. On garde la decimale :
    // plus precis, et aucune lecture n'en devient fausse.
    expect(formatGrams(12.5)).toBe('12,5 g')
    expect(formatGrams(250.4)).toBe('250 g')
  })
})

describe('l unite g cuits', () => {
  // Riz : 100 g crus donnent 300 g cuits.
  const RIZ = 300

  it('enregistre la masse CRUE de ce qu on a saisi cuit', () => {
    expect(toGrams(300, COOKED_UNIT_CODE, null, RIZ)).toBe(100)
    expect(toGrams(200, COOKED_UNIT_CODE, null, RIZ)).toBeCloseTo(66.667, 3)
  })

  it('relit le cuit depuis le cru, comme le fait la fiche', () => {
    expect(fromGrams(100, COOKED_UNIT_CODE, null, RIZ)).toBe(300)
    // Le champ et la fiche ne doivent jamais lire deux poids differents.
    for (const crus of [12.5, 66.667, 100, 250]) {
      expect(fromGrams(crus, COOKED_UNIT_CODE, null, RIZ)).toBeCloseTo(
        cookedWeightG({ cookedWeightPer100gRaw: RIZ }, crus),
        9,
      )
    }
  })

  it('fait l aller-retour sans derive', () => {
    expect(fromGrams(toGrams(200, COOKED_UNIT_CODE, null, RIZ), COOKED_UNIT_CODE, null, RIZ)).toBeCloseTo(200, 9)
  })

  it('refuse de convertir sans rendement', () => {
    expect(() => toGrams(200, COOKED_UNIT_CODE)).toThrow(UnknownUnitError)
    expect(() => fromGrams(200, COOKED_UNIT_CODE, 60, null)).toThrow(UnknownUnitError)
    expect(() => toGrams(200, COOKED_UNIT_CODE, null, 0)).toThrow(UnknownUnitError)
  })

  it('a son libelle, et la piece ne s en trouve pas changee', () => {
    expect(labelFor(COOKED_UNIT_CODE)).toBe('g cuits')
    expect(isKnownUnit(COOKED_UNIT_CODE)).toBe(true)
    expect(toGrams(2, PIECE_UNIT_CODE, 60, RIZ)).toBe(120)
  })
})

describe('le poids d’une cuillere', () => {
  it('corrige la cuillere a soupe et la cuillere a cafe, qui en vaut le tiers', () => {
    expect(toGrams(2, 'c_soupe', null, null, 8)).toBe(16)
    expect(toGrams(3, 'c_cafe', null, null, 9)).toBeCloseTo(9)
    expect(fromGrams(16, 'c_soupe', null, null, 8)).toBe(2)
  })

  it('laisse les litres, les grammes et la pincee a leur valeur', () => {
    expect(toGrams(25, 'cl', null, null, 8)).toBe(250)
    expect(toGrams(100, 'g', null, null, 8)).toBe(100)
    expect(toGrams(1, 'pincee', null, null, 8)).toBe(1)
  })

  it('compte une cuillere comme de l’eau quand l’ingredient n’en dit rien', () => {
    expect(toGrams(2, 'c_soupe')).toBe(2 * CUILLERE_SOUPE_G)
    expect(toGrams(2, 'c_soupe', null, null, null)).toBe(30)
    expect(toGrams(2, 'c_soupe', null, null, 0)).toBe(30)
  })

  it('dit son poids dans le libelle, comme la piece', () => {
    expect(labelFor('c_soupe', null, 8)).toBe('c. à soupe (8\u00a0g)')
    expect(labelFor('c_soupe')).toBe('c. à soupe')
    expect(labelFor('cl', null, 8)).toBe('cl')
  })
})
