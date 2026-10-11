import { describe, expect, it } from 'vitest'

import { completionQuestion, completionTool, interpretCompletion, moisCsv, saisonLisible } from './completion.js'

const RAYONS = ['Fruits et légumes', 'Produits laitiers & oeufs', 'Epicerie', 'Boucherie']

type Schema = {
  properties: { fiches: { items: { properties: Record<string, { enum?: unknown[] }>; required: string[] } } }
}

describe('completionTool', () => {
  it('ferme le rayon sur les rayons de la cuisine, ou null', () => {
    const schema = completionTool(RAYONS).input_schema as Schema
    expect(schema.properties.fiches.items.properties['rayon']?.enum).toEqual([...RAYONS, null])
    expect(schema.properties.fiches.items.required).toEqual(['id', 'poids_cuit', 'mois_saison', 'rayon'])
  })

  it('ne demande pas de rayon a une cuisine qui n’en a pas', () => {
    const schema = completionTool([]).input_schema as Schema
    expect(schema.properties.fiches.items.properties['rayon']).toBeUndefined()
    expect(schema.properties.fiches.items.required).toEqual(['id', 'poids_cuit', 'mois_saison'])
  })
})

describe('completionTool, fiche relue', () => {
  it('demande en plus le poids d’une piece', () => {
    const schema = completionTool(RAYONS, { relue: true }).input_schema as Schema
    expect(schema.properties.fiches.items.required).toEqual(['id', 'poids_cuit', 'mois_saison', 'poids_piece', 'rayon'])
  })
})

describe('completionQuestion', () => {
  it('liste les rayons et les produits avec leur identifiant et leur marque', () => {
    const q = completionQuestion(RAYONS, [
      { id: 7, nom: 'Riz basmati', marque: 'Taureau Ailé' },
      { id: 9, nom: 'Courgette', marque: null },
    ])
    expect(q).toContain('- Epicerie')
    expect(q).toContain('7 : Riz basmati (Taureau Ailé)')
    expect(q).toContain('9 : Courgette')
    expect(q).toContain('Dans le doute, null')
  })

  it('dit que ", crue" designe l’aliment avant cuisson, celui dont on veut le poids cuit', () => {
    expect(completionQuestion(RAYONS, [{ id: 1, nom: 'Echalote, crue', marque: null }])).toContain('", crue"')
  })

  it('prudent sans relecture, meilleure estimation quand la personne relira', () => {
    const prudent = completionQuestion(RAYONS, [{ id: 1, nom: 'Riz', marque: null }])
    const relue = completionQuestion(RAYONS, [{ id: 1, nom: 'Riz', marque: null }], { relue: true })
    expect(prudent).toContain('Dans le doute, null')
    expect(prudent).not.toContain('poids_piece')
    expect(relue).toContain('meilleure estimation')
    expect(relue).toContain('poids_piece')
    expect(relue).not.toContain('Dans le doute, null')
  })

  it('ne parle pas de rayon sans rayon', () => {
    expect(completionQuestion([], [{ id: 1, nom: 'Riz', marque: null }])).not.toContain('rayon :')
  })
})

describe('interpretCompletion', () => {
  it('garde un rayon de la liste sous son nom exact, un poids et des mois dans leurs bornes', () => {
    const r = interpretCompletion(
      {
        fiches: [
          { id: 7, rayon: 'epicerie', poids_cuit: 300, mois_saison: null },
          { id: 9, rayon: 'Fruits et légumes', poids_cuit: null, mois_saison: [9, 6, 7, 8, 7] },
        ],
      },
      RAYONS,
      [7, 9],
    )
    expect(r.get(7)).toEqual({ rayon: 'Epicerie', poidsCuitG: 300, moisSaison: null, poidsPieceG: null })
    expect(r.get(9)).toEqual({ rayon: 'Fruits et légumes', poidsCuitG: null, moisSaison: [6, 7, 8, 9], poidsPieceG: null })
  })

  it('ecarte un rayon invente, un poids hors bornes ou sans ecart, une saison de douze mois', () => {
    const r = interpretCompletion(
      {
        fiches: [
          { id: 1, rayon: 'Conserves', poids_cuit: 1200, mois_saison: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
          { id: 2, rayon: null, poids_cuit: 102, mois_saison: [0, 13, 2.5] },
          { id: 3, rayon: 'Boucherie', poids_cuit: 74.96, mois_saison: [] },
        ],
      },
      RAYONS,
      [1, 2, 3],
    )
    // Rendu quand meme : le modele a repondu, on ne le reinterrogera pas.
    expect(r.get(1)).toEqual({ rayon: null, poidsCuitG: null, moisSaison: null, poidsPieceG: null })
    expect(r.get(2)).toEqual({ rayon: null, poidsCuitG: null, moisSaison: null, poidsPieceG: null })
    expect(r.get(3)).toEqual({ rayon: 'Boucherie', poidsCuitG: 75, moisSaison: null, poidsPieceG: null })
  })

  it('ignore un identifiant non demande, un doublon, et une reponse mal formee', () => {
    const r = interpretCompletion(
      {
        fiches: [
          { id: 12, rayon: 'Epicerie', poids_cuit: 300, mois_saison: null },
          { id: 7, rayon: 'Epicerie', poids_cuit: null, mois_saison: null },
          { id: 7, rayon: 'Boucherie', poids_cuit: 75, mois_saison: null },
        ],
      },
      RAYONS,
      [7],
    )
    expect([...r.keys()]).toEqual([7])
    expect(r.get(7)?.rayon).toBe('Epicerie')
    expect(interpretCompletion(null, RAYONS, [1]).size).toBe(0)
    expect(interpretCompletion({ fiches: 'Epicerie' }, RAYONS, [1]).size).toBe(0)
  })
})

describe('interpretCompletion, poids d’une piece', () => {
  it('garde un poids plausible, ecarte le reste', () => {
    const r = interpretCompletion(
      {
        fiches: [
          { id: 1, rayon: null, poids_cuit: null, mois_saison: null, poids_piece: 30 },
          { id: 2, rayon: null, poids_cuit: null, mois_saison: null, poids_piece: 0.1 },
          { id: 3, rayon: null, poids_cuit: null, mois_saison: null, poids_piece: 12000 },
        ],
      },
      RAYONS,
      [1, 2, 3],
    )
    expect(r.get(1)?.poidsPieceG).toBe(30)
    expect(r.get(2)?.poidsPieceG).toBeNull()
    expect(r.get(3)?.poidsPieceG).toBeNull()
  })
})

describe('moisCsv', () => {
  it('ecrit la colonne season_months, jamais une chaine vide', () => {
    expect(moisCsv([6, 7, 8, 9])).toBe('6,7,8,9')
    expect(moisCsv([])).toBeNull()
    expect(moisCsv(null)).toBeNull()
  })
})

describe('saisonLisible', () => {
  it('dit une plage, y compris a cheval sur l’annee', () => {
    expect(saisonLisible([6, 7, 8, 9])).toBe('de juin à septembre')
    expect(saisonLisible([10, 11, 12, 1, 2, 3])).toBe('d’octobre à mars')
    expect(saisonLisible([4, 5, 6])).toBe('d’avril à juin')
  })

  it('enumere des mois qui ne se suivent pas, et nomme un mois seul', () => {
    expect(saisonLisible([3, 4, 10])).toBe('mars, avril, octobre')
    expect(saisonLisible([8])).toBe('en août')
    expect(saisonLisible([])).toBe('')
  })
})
