import { describe, expect, it } from 'vitest'

import { interpretQuantites, quantitesQuestion } from './quantitesIA.js'

const RECETTE = {
  titre: 'Poulet crémeux au romarin',
  portions: 2,
  site: 'hellofresh.fr',
  lignes: ['2 Filet de poulet', '1/2 sachet Romarin séché', '1/2 pot Crème liquide', 'Sel, poivre'],
  aEstimer: [
    { index: 1, fiche: 'Romarin séché', contenanceG: null },
    { index: 2, fiche: 'Crème liquide 30 %', contenanceG: 200 },
    { index: 3, fiche: null, contenanceG: null },
  ],
}

describe('quantitesQuestion', () => {
  it('donne toute la recette, numerotee a partir de 1, et les lignes a estimer', () => {
    const q = quantitesQuestion(RECETTE)
    expect(q).toContain('Recette "Poulet crémeux au romarin", pour 2 portions, publiee par hellofresh.fr.')
    expect(q).toContain('1. 2 Filet de poulet')
    expect(q).toContain('2. 1/2 sachet Romarin séché')
    expect(q).toContain('3 (produit retenu : Crème liquide 30 %, vendu par 200 g)')
    // La derniere ligne demandee, sans fiche : son seul numero.
    expect(q.endsWith('\n4')).toBe(true)
    expect(q).toContain('kits a cuisiner')
  })

  it('se passe des portions et du site quand on ne les a pas', () => {
    const q = quantitesQuestion({ ...RECETTE, portions: null, site: null })
    expect(q).toContain('Recette "Poulet crémeux au romarin". Ses lignes')
  })
})

describe('interpretQuantites', () => {
  it('rend les poids par index, arrondis a ce qui se pese', () => {
    const r = interpretQuantites(
      {
        estimations: [
          { ligne: 2, grammes: 2.46 },
          { ligne: 3, grammes: 74.6 },
          { ligne: 4, grammes: 1 },
        ],
      },
      [1, 2, 3],
    )
    expect([...r]).toEqual([
      [1, 2.5],
      [2, 75],
      [3, 1],
    ])
  })

  it('ecarte une ligne non demandee, un doublon, un null, un poids hors bornes', () => {
    const r = interpretQuantites(
      {
        estimations: [
          { ligne: 1, grammes: 300 },
          { ligne: 2, grammes: 5 },
          { ligne: 2, grammes: 900 },
          { ligne: 3, grammes: null },
          { ligne: 4, grammes: 12000 },
          { ligne: 4.5, grammes: 3 },
        ],
      },
      [1, 2, 3],
    )
    expect([...r]).toEqual([[1, 5]])
  })

  it('rend une table vide sur une reponse mal formee', () => {
    expect(interpretQuantites(null, [0]).size).toBe(0)
    expect(interpretQuantites({ estimations: 'beaucoup' }, [0]).size).toBe(0)
  })
})
