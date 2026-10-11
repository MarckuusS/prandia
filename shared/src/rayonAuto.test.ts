import { describe, expect, it } from 'vitest'

import { interpretClassement, rayonQuestion, rayonTool } from './rayonAuto.js'

const RAYONS = ['Fruits et légumes', 'Produits laitiers & oeufs', 'Epicerie', 'Boucherie']

describe('rayonTool', () => {
  it('ferme la reponse sur les rayons de la cuisine, ou null', () => {
    const schema = rayonTool(RAYONS).input_schema as {
      properties: { classement: { items: { properties: { rayon: { enum: unknown[] } } } } }
    }
    expect(schema.properties.classement.items.properties.rayon.enum).toEqual([...RAYONS, null])
  })
})

describe('rayonQuestion', () => {
  it('liste les rayons et les produits avec leur identifiant et leur marque', () => {
    const q = rayonQuestion(RAYONS, [
      { id: 7, nom: 'Thon à l’huile', marque: 'Nixe' },
      { id: 9, nom: 'Crème liquide', marque: null },
    ])
    expect(q).toContain('- Epicerie')
    expect(q).toContain('7 : Thon à l’huile (Nixe)')
    expect(q).toContain('9 : Crème liquide')
  })
})

describe('interpretClassement', () => {
  it('garde un rayon de la liste, rendu sous son nom exact', () => {
    const r = interpretClassement(
      { classement: [{ id: 7, rayon: 'epicerie' }, { id: 9, rayon: 'Produits laitiers & oeufs' }] },
      RAYONS,
      [7, 9],
    )
    expect([...r]).toEqual([
      [7, 'Epicerie'],
      [9, 'Produits laitiers & oeufs'],
    ])
  })

  it('ecarte un rayon invente, un null, et un identifiant non demande', () => {
    const r = interpretClassement(
      {
        classement: [
          { id: 7, rayon: 'Conserves' },
          { id: 9, rayon: null },
          { id: 12, rayon: 'Epicerie' },
        ],
      },
      RAYONS,
      [7, 9],
    )
    expect(r.size).toBe(0)
  })

  it('rend une table vide sur une reponse mal formee', () => {
    expect(interpretClassement(null, RAYONS, [1]).size).toBe(0)
    expect(interpretClassement({ classement: 'Epicerie' }, RAYONS, [1]).size).toBe(0)
  })
})
