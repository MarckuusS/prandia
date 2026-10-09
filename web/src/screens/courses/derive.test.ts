/**
 * Le filet, pose AVANT de toucher a l'ecran Courses.
 *
 * Meme raison que `frigo/lots.test.ts` : l'ecran va etre remplace par une
 * maquette, et ces quatre calculs vivaient dans son corps. Un calcul enfoui
 * dans un composant qu'on remplace part avec lui sans que personne ne le voie.
 */

import { describe, expect, it } from 'vitest'
import type { ShoppingItem } from '@prandia/shared'

import {
  cents,
  isFiltering,
  pantryCandidates,
  remainingItems,
  sumCents,
  visibleItems,
} from './derive.js'

const item = (id: number, patch: Partial<ShoppingItem> = {}): ShoppingItem =>
  ({
    ingredientId: id,
    name: `Produit ${id}`,
    quantityG: 100,
    pieceCount: null,
    categoryL1: null,
    costEur: null,
    isCoveredByPantry: false,
    pantryQuantityG: 0,
    sources: [],
    ...patch,
  }) as unknown as ShoppingItem

describe('cents', () => {
  it('convertit en centimes ENTIERS', () => {
    // Additionner des flottants d'euros ferait apparaitre des
    // 0,30000000000000004 : les couts arrivent deja arrondis au centime par le
    // serveur, on reste en entiers.
    expect(cents('1.10')).toBe(110)
    expect(cents('0.10')).toBe(10)
    expect(cents('12.34')).toBe(1234)
  })

  it('un prix INCONNU ne compte pas pour zero euro par hasard', () => {
    // Il ne compte pas du tout. Un article sans prix ne rend pas la liste moins
    // chere, il rend le total incomplet.
    expect(cents(null)).toBe(0)
  })
})

describe('sumCents', () => {
  it('additionne sans erreur de virgule flottante', () => {
    const total = sumCents([
      item(1, { costEur: '0.10' }),
      item(2, { costEur: '0.20' }),
      item(3, { costEur: '0.30' }),
    ])
    expect(total).toBe(60)
    // La preuve par l'absurde : la meme somme en euros derape.
    expect(0.1 + 0.2 + 0.3).not.toBe(0.6)
  })

  it('saute les lignes sans prix plutot que de les compter zero', () => {
    expect(sumCents([item(1, { costEur: '5.00' }), item(2, { costEur: null })])).toBe(500)
  })

  it('rend zero sur une liste vide', () => {
    expect(sumCents([])).toBe(0)
  })
})

describe('pantryCandidates', () => {
  const jeu = [
    item(1, { isCoveredByPantry: true }),
    item(2, { isCoveredByPantry: true }),
    item(3, { isCoveredByPantry: false }),
  ]

  it('ne retient que ce qui est couvert par le frigo ET pas encore coche', () => {
    expect(pantryCandidates(jeu, new Set()).map((i) => i.ingredientId)).toEqual([1, 2])
  })

  it('LES CANDIDATS NE SONT PAS PRE-COCHES : ils sortent de la liste une fois coches', () => {
    /*
     * Decision prise apres incident : sur telephone, une case cochee qu'on n'a
     * pas cochee soi-meme se lit comme une erreur, et l'utilisateur croyait
     * avoir coche par megarde. L'ecran les PROPOSE, il ne les coche pas. Ce
     * test garde le fait que la proposition disparait une fois acceptee.
     */
    expect(pantryCandidates(jeu, new Set([1])).map((i) => i.ingredientId)).toEqual([2])
    expect(pantryCandidates(jeu, new Set([1, 2]))).toEqual([])
  })
})

describe('remainingItems', () => {
  it('donne le denominateur de la progression', () => {
    const jeu = [item(1), item(2), item(3)]
    expect(remainingItems(jeu, new Set([2])).map((i) => i.ingredientId)).toEqual([1, 3])
  })

  it('rend une liste vide quand tout est coche', () => {
    expect(remainingItems([item(1)], new Set([1]))).toEqual([])
  })
})

describe('isFiltering', () => {
  it('LE FILTRE SE DESARME TOUT SEUL quand il n y a plus rien a filtrer', () => {
    // Sinon, renseigner le dernier prix manquant laisserait une liste vide et
    // muette, sans que rien n'explique pourquoi.
    expect(isFiltering(true, 3)).toBe(true)
    expect(isFiltering(true, 0)).toBe(false)
    expect(isFiltering(false, 3)).toBe(false)
  })
})

describe('visibleItems', () => {
  it('ne garde que les lignes SANS PRIX quand le filtre est actif', () => {
    const jeu = [item(1, { costEur: '2.00' }), item(2, { costEur: null })]
    expect(visibleItems(jeu, true).map((i) => i.ingredientId)).toEqual([2])
  })

  it('rend la liste ENTIERE quand il ne l est pas, sans la recopier', () => {
    const jeu = [item(1, { costEur: '2.00' }), item(2)]
    expect(visibleItems(jeu, false)).toBe(jeu)
  })
})
