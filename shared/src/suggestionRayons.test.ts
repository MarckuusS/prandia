import { describe, expect, it } from 'vitest'

import {
  SUGGESTION_PRODUITS_MIN,
  interpretSuggestionRayons,
  rayonDejaCouvert,
  suggestionRayonsQuestion,
} from './suggestionRayons.js'

const RAYONS = ['Epicerie', 'Fruits et légumes', 'Produits laitiers & oeufs', 'Frais']
const CONNUS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

const proposition = (nom: string, produits: number[], raison = 'Une raison.') => ({ nom, raison, produits })

describe('rayonDejaCouvert', () => {
  it('reconnait un rayon existant dit autrement', () => {
    expect(rayonDejaCouvert('Produits frais', 'Frais')).toBe(true)
    expect(rayonDejaCouvert('Épicerie', 'Epicerie')).toBe(true)
    expect(rayonDejaCouvert('Oeufs', 'Produits laitiers & oeufs')).toBe(true)
    expect(rayonDejaCouvert('Œufs', 'Produits laitiers & oeufs')).toBe(true)
    expect(rayonDejaCouvert('Fruits et legumes', 'Fruits & légumes')).toBe(true)
  })

  it('laisse passer un rayon qui PRECISE un rayon existant', () => {
    expect(rayonDejaCouvert('Épicerie sucrée', 'Epicerie')).toBe(false)
    expect(rayonDejaCouvert('Fruits secs', 'Fruits et légumes')).toBe(false)
    expect(rayonDejaCouvert('Conserves', 'Epicerie')).toBe(false)
  })
})

describe('interpretSuggestionRayons', () => {
  it('garde une proposition qui tient', () => {
    const rendu = interpretSuggestionRayons(
      { propositions: [proposition('  Conserves ', [1, 2, 3, 4, 5], ' 5 de tes produits  sont des conserves. ')] },
      RAYONS,
      [],
      CONNUS,
    )
    expect(rendu).toEqual([{ nom: 'Conserves', raison: '5 de tes produits sont des conserves.', produits: [1, 2, 3, 4, 5] }])
  })

  it('ecarte un rayon qui existe deja ou qui a ete refuse', () => {
    const rendu = interpretSuggestionRayons(
      { propositions: [proposition('Produits frais', [1, 2, 3, 4]), proposition('Conserves', [5, 6, 7, 8])] },
      RAYONS,
      ['conserves'],
      CONNUS,
    )
    expect(rendu).toEqual([])
  })

  it(`exige ${SUGGESTION_PRODUITS_MIN} produits CONNUS, sans doublon`, () => {
    const rendu = interpretSuggestionRayons(
      { propositions: [proposition('Conserves', [1, 1, 2, 3, 99, 100])] },
      RAYONS,
      [],
      CONNUS,
    )
    expect(rendu).toEqual([])
  })

  it('ne range un produit que dans une seule proposition', () => {
    const rendu = interpretSuggestionRayons(
      {
        propositions: [
          proposition('Conserves', [1, 2, 3, 4]),
          proposition('Pâtes et riz', [4, 5, 6, 7, 8]),
          proposition('Petit-déjeuner', [1, 2, 9, 10]),
        ],
      },
      RAYONS,
      [],
      CONNUS,
    )
    expect(rendu.map((r) => [r.nom, r.produits])).toEqual([
      ['Conserves', [1, 2, 3, 4]],
      ['Pâtes et riz', [5, 6, 7, 8]],
    ])
  })

  it('ne garde pas deux propositions qui disent la meme chose', () => {
    const rendu = interpretSuggestionRayons(
      { propositions: [proposition('Conserves', [1, 2, 3, 4]), proposition('Les conserves', [5, 6, 7, 8])] },
      RAYONS,
      [],
      CONNUS,
    )
    expect(rendu.map((r) => r.nom)).toEqual(['Conserves'])
  })

  it('rend une liste vide pour une reponse vide ou mal formee', () => {
    expect(interpretSuggestionRayons({ propositions: [] }, RAYONS, [], CONNUS)).toEqual([])
    expect(interpretSuggestionRayons(undefined, RAYONS, [], CONNUS)).toEqual([])
    expect(interpretSuggestionRayons({ propositions: [{ nom: 'X' }, 'texte'] }, RAYONS, [], CONNUS)).toEqual([])
    expect(interpretSuggestionRayons({ propositions: [proposition('A', [1, 2, 3, 4])] }, RAYONS, [], CONNUS)).toEqual([])
  })
})

describe('suggestionRayonsQuestion', () => {
  it('range les produits par rayon, dit les rayons vides et les refus', () => {
    const question = suggestionRayonsQuestion(
      ['Epicerie', 'Frais', 'Boissons'],
      [
        { id: 1, nom: 'Thon au naturel', rayon: 'Epicerie' },
        { id: 2, nom: 'Yaourt nature', rayon: 'Frais' },
        { id: 3, nom: 'Sel fin', rayon: null },
      ],
      ['Conserves'],
    )
    expect(question).toContain('## Epicerie (1)\n1 : Thon au naturel')
    expect(question).toContain('## Sans rayon (1)\n3 : Sel fin')
    expect(question).toContain('vides dans la bibliotheque : Boissons')
    expect(question).toContain('deja refuses par la personne : Conserves')
    expect(question.indexOf('## Epicerie')).toBeLessThan(question.indexOf('## Frais'))
    expect(question.indexOf('## Frais')).toBeLessThan(question.indexOf('## Sans rayon'))
  })
})
