import { describe, expect, it } from 'vitest'
import type { Ingredient, PantryStock, StorageSpace } from '@prandia/shared'

import { buildLots, type Lot } from './lots.js'
import {
  espaceLabel,
  espaceParDefaut,
  formatDepuis,
  joursDepuisEntree,
  lotsOf,
  onglets,
} from './espaces.js'

const AUJOURDHUI = new Date(2026, 7, 14)

const lot = (
  id: number,
  storage: StorageSpace | null,
  patch: Partial<PantryStock> = {},
): Lot => {
  const stock = {
    id,
    ingredientId: id,
    quantityG: 100,
    expiryDate: null,
    storage,
    storageSince: null,
    unit: null,
    notes: null,
    addedAt: null,
    updatedAt: null,
    ...patch,
  } as PantryStock
  const ing = { id, name: `Produit ${id}` } as unknown as Ingredient
  return buildLots([stock], { [String(id)]: ing }, AUJOURDHUI)[0] as Lot
}

describe('lotsOf', () => {
  it('separe les quatre espaces, `null` compris', () => {
    const tous = [lot(1, 'frigo'), lot(2, 'placard'), lot(3, 'congelateur'), lot(4, null)]
    expect(lotsOf(tous, 'frigo')).toHaveLength(1)
    expect(lotsOf(tous, null)).toHaveLength(1)
    expect(lotsOf(tous, null)[0]?.id).toBe(4)
  })
})

describe('onglets', () => {
  it("N'AFFICHE PAS 'A ranger' quand il est vide", () => {
    // Un onglet permanent et vide se lirait comme une fonction cassee. C'est
    // aussi l'etat NORMAL : tout est range.
    const tous = [lot(1, 'frigo'), lot(2, 'placard')]
    expect(onglets(tous).map((o) => o.espace)).toEqual(['frigo', 'placard', 'congelateur'])
  })

  it("met 'A ranger' EN PREMIER des qu il contient quelque chose", () => {
    // C'est une file d'attente, pas une categorie, et une file qu'on ne voit
    // pas ne se vide jamais.
    const tous = [lot(1, 'frigo'), lot(2, null)]
    expect(onglets(tous).map((o) => o.espace)).toEqual([null, 'frigo', 'placard', 'congelateur'])
  })

  it('garde les trois espaces meme vides, eux', () => {
    // Ils sont des lieux : un frigo vide reste un frigo, et l'onglet dit ou
    // ranger. La difference avec "A ranger" est de nature.
    expect(onglets([]).map((o) => o.espace)).toEqual(['frigo', 'placard', 'congelateur'])
    expect(onglets([]).every((o) => o.count === 0)).toBe(true)
  })

  it('compte les lots de chaque espace', () => {
    const tous = [lot(1, 'frigo'), lot(2, 'frigo'), lot(3, 'placard')]
    expect(onglets(tous).map((o) => o.count)).toEqual([2, 1, 0])
  })
})

describe('espaceParDefaut', () => {
  it('ouvre sur ce qui ATTEND une action, quand il y en a', () => {
    // C'est l'etat dans lequel on arrive apres des courses.
    expect(espaceParDefaut([lot(1, 'frigo'), lot(2, null)])).toBeNull()
  })

  it('ouvre sur le frigo sinon, la ou les choses se perdent', () => {
    expect(espaceParDefaut([lot(1, 'placard')])).toBe('frigo')
    expect(espaceParDefaut([])).toBe('frigo')
  })
})

describe('joursDepuisEntree', () => {
  it("compte depuis la date d ENTREE, pas depuis l achat", () => {
    /*
     * Un lot achete en mai et descendu au congelateur en juillet doit compter
     * depuis juillet : c'est precisement ce que le congelateur affiche.
     */
    const l = lot(1, 'congelateur', {
      addedAt: '2026-05-01T10:00:00Z',
      storageSince: '2026-08-08T10:00:00Z',
    })
    expect(joursDepuisEntree(l, AUJOURDHUI)).toBe(6)
  })

  it("retombe sur la date d ajout pour les lots anterieurs a la migration", () => {
    const l = lot(1, 'congelateur', { addedAt: '2026-08-04T10:00:00Z' })
    expect(joursDepuisEntree(l, AUJOURDHUI)).toBe(10)
  })

  it('rend null quand on ne sait pas, plutot que zero', () => {
    // "Depuis 0 jour" affirmerait une entree du jour meme.
    expect(joursDepuisEntree(lot(1, 'congelateur'), AUJOURDHUI)).toBeNull()
    expect(joursDepuisEntree(lot(1, 'congelateur', { addedAt: 'n importe quoi' }), AUJOURDHUI)).toBeNull()
  })

  it('ne rend jamais de negatif sur une date future', () => {
    const l = lot(1, 'congelateur', { storageSince: '2026-12-01T10:00:00Z' })
    expect(joursDepuisEntree(l, AUJOURDHUI)).toBe(0)
  })
})

describe('formatDepuis', () => {
  it('MESURE le temps passe, ne PROJETTE jamais une duree restante', () => {
    /*
     * Le mockup annonce "3 mois" comme ce qu'il reste. Celle-ci est le temps
     * ecoule, qu'on sait. "Encore 3 mois" supposerait une table de durees par
     * aliment que personne ne publie.
     */
    expect(formatDepuis(0)).toBe("Rangé aujourd'hui")
    expect(formatDepuis(1)).toBe('Rangé hier')
    expect(formatDepuis(6)).toBe('Depuis 6 jours')
  })

  it('bascule en mois au-dela de huit semaines', () => {
    expect(formatDepuis(55)).toBe('Depuis 55 jours')
    expect(formatDepuis(60)).toBe('Depuis 2 mois')
    expect(formatDepuis(90)).toBe('Depuis 3 mois')
  })

  it('n ecrit rien quand la date manque', () => {
    expect(formatDepuis(null)).toBeNull()
  })
})

describe('espaceLabel', () => {
  it('nomme les quatre, dont celui qui n est pas un lieu', () => {
    expect(espaceLabel(null)).toBe('À ranger')
    expect(espaceLabel('congelateur')).toBe('Congélo')
  })
})
