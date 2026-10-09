/**
 * Le filet, pose AVANT de toucher a l'ecran du frigo.
 *
 * Ce fichier teste le code TEL QU'IL EST, sans le modifier d'une ligne. Il
 * existe parce que l'ecran va etre remplace par une maquette, et qu'un
 * remplacement d'ecran perd des fonctions en silence : personne ne remarque
 * qu'un tri a disparu avant d'en avoir besoin, six semaines plus tard.
 *
 * Il est du gain net meme si le chantier s'arretait ici : ces regles n'etaient
 * gardees par rien.
 */

import { describe, expect, it } from 'vitest'
import type { Ingredient, PantryStock } from '@prandia/shared'

import {
  ORPHAN_NAME,
  buildLots,
  filterLots,
  formatExpiryDate,
  formatExpiryLabel,
  formatLotQuantity,
  groupLots,
  readOption,
  sortLots,
  GROUPS,
  SORTS,
  type Lot,
} from './lots.js'

// ---------------------------------------------------------------------------

/** Une date fixe : « aujourd'hui » ne doit jamais dependre de l'heure du test. */
const AUJOURDHUI = new Date(2026, 7, 14) // 14 aout 2026, en heure locale

const ingredient = (id: number, patch: Partial<Ingredient> = {}): Ingredient =>
  ({
    id,
    name: `Produit ${id}`,
    source: 'manual',
    sourceRef: null,
    brand: null,
    kcal: null,
    proteins: null,
    carbs: null,
    sugars: null,
    fats: null,
    saturatedFats: null,
    fiber: null,
    salt: null,
    priceEur: null,
    priceQuantityG: null,
    pieceWeightG: null,
    cookedWeightPer100gRaw: null,
    inPersonalLibrary: true,
    categoryL1: null,
    categoryL2: null,
    seasonMonths: null,
    createdAt: null,
    updatedAt: null,
    ...patch,
  }) as unknown as Ingredient

const stock = (id: number, ingredientId: number, patch: Partial<PantryStock> = {}): PantryStock =>
  ({
    id,
    ingredientId,
    quantityG: 100,
    expiryDate: null,
    notes: null,
    addedAt: null,
    updatedAt: null,
    ...patch,
  }) as unknown as PantryStock

/** Un jeu de lots construit depuis des stocks et des ingredients. */
const lotsDe = (
  stocks: readonly PantryStock[],
  ingredients: readonly Ingredient[] = [],
): Lot[] => {
  const index: Record<string, Ingredient> = {}
  for (const i of ingredients) index[String(i.id)] = i
  return buildLots(stocks, index, AUJOURDHUI)
}

const noms = (lots: readonly Lot[]): string[] => lots.map((l) => l.name)

// ---------------------------------------------------------------------------

describe('buildLots', () => {
  it('compte la fratrie et cumule la masse par ingredient', () => {
    // Deux briques de lait ouvertes a une semaine d'ecart ont deux peremptions
    // et ne se confondent pas, mais la liste de courses ne voit que le total.
    const lots = lotsDe(
      [stock(1, 7, { quantityG: 200 }), stock(2, 7, { quantityG: 300 }), stock(3, 9)],
      [ingredient(7, { name: 'Lait' }), ingredient(9, { name: 'Riz' })],
    )
    expect(lots[0]?.siblingCount).toBe(2)
    expect(lots[0]?.totalG).toBe(500)
    expect(lots[2]?.siblingCount).toBe(1)
    expect(lots[2]?.totalG).toBe(100)
  })

  it('AFFICHE un lot orphelin plutot que de le cacher', () => {
    // Le desktop les ignorait : ils devenaient invisibles ET indestructibles,
    // tout en comptant dans la couverture de la liste de courses. Les montrer
    // est le seul moyen de les faire disparaitre.
    const lots = lotsDe([stock(1, 404)], [])
    expect(lots).toHaveLength(1)
    expect(lots[0]?.name).toBe(ORPHAN_NAME)
    expect(lots[0]?.ingredient).toBeNull()
  })

  it('ecarte un lot sans identifiant, qui ne serait ni modifiable ni supprimable', () => {
    const lots = lotsDe([{ ...stock(1, 7), id: null } as unknown as PantryStock])
    expect(lots).toHaveLength(0)
  })

  it('calcule les jours restants a partir du jour PASSE EN ARGUMENT', () => {
    // Il est fige par l'ecran et renouvele au retour au premier plan : une PWA
    // laissee ouverte deux jours afficherait sinon des urgences fausses.
    const lots = lotsDe([
      stock(1, 7, { expiryDate: '2026-08-16' }),
      stock(2, 7, { expiryDate: '2026-08-14' }),
      stock(3, 7, { expiryDate: '2026-08-10' }),
      stock(4, 7),
    ])
    expect(lots.map((l) => l.daysLeft)).toEqual([2, 0, -4, null])
  })

  it('range chaque lot dans son seau d urgence', () => {
    const lots = lotsDe([
      stock(1, 7, { expiryDate: '2026-08-16' }),
      stock(2, 7, { expiryDate: '2026-08-25' }),
      stock(3, 7, { expiryDate: '2026-12-01' }),
      stock(4, 7),
    ])
    expect(lots.map((l) => l.bucket)).toEqual(['soon', 'watch', 'stock', 'stock'])
  })
})

describe('filterLots', () => {
  it('plie les accents, ce que le desktop ne faisait pas', () => {
    // Il comparait des casefold bruts, et « creme » ne trouvait pas « crème ».
    const lots = lotsDe([stock(1, 7)], [ingredient(7, { name: 'Crème fraîche' })])
    expect(filterLots(lots, 'creme')).toHaveLength(1)
    expect(filterLots(lots, 'CRÈME')).toHaveLength(1)
  })

  it('rend tout sur une recherche vide, et une COPIE', () => {
    const lots = lotsDe([stock(1, 7)], [ingredient(7)])
    const rendu = filterLots(lots, '')
    expect(rendu).toHaveLength(1)
    expect(rendu).not.toBe(lots)
  })
})

describe('sortLots', () => {
  const jeu = () =>
    lotsDe(
      [
        stock(1, 1, { quantityG: 500, expiryDate: '2026-08-20' }),
        stock(2, 2, { quantityG: 100, expiryDate: '2026-08-16' }),
        stock(3, 3, { quantityG: 900 }),
        stock(4, 4, { quantityG: 300, expiryDate: '2026-08-12' }),
      ],
      [
        ingredient(1, { name: 'Zeste', categoryL1: 'Épicerie' }),
        ingredient(2, { name: 'Ail', categoryL1: 'Légumes' }),
        ingredient(3, { name: 'Œuf', categoryL1: null }),
        ingredient(4, { name: 'Beurre', categoryL1: 'Crèmerie' }),
      ],
    )

  it('les CINQ tris existent, et aucun n est perdu', () => {
    /*
     * L'ENSEMBLE, pas l'ordre. C'est ce que ce test garde : le jour ou l'ecran
     * est passe des menus deroulants aux chips, l'ordre a change pour mettre
     * en avant les deux tris qu'on utilise debout devant le frigo. Ce test a
     * attrape ce changement, ce qui etait son travail ; l'assertion dit
     * desormais ce qu'elle voulait dire.
     */
    expect(new Set(SORTS.map((s) => s.value))).toEqual(
      new Set(['urgence', 'nom', 'quantite', 'peremption', 'rayon']),
    )
    // Le premier est le defaut, et il ne doit pas bouger sans qu'on le sache.
    expect(SORTS[0]?.value).toBe('urgence')
  })

  it('chaque tri a un libelle COURT pour la chip, et un long pour le menu', () => {
    // Une chip fait vingt pixels de haut : "Quantité (décroissant)" y passe a
    // la ligne. Aucun tri n'a ete retire pour tenir dans la place.
    for (const s of SORTS) {
      expect(s.court.length).toBeLessThanOrEqual(20)
      expect(s.label.length).toBeGreaterThan(0)
    }
  })

  it('trie par nom avec un collator francais, pas par point de code', () => {
    // « Œuf » vaut U+0152, au-dela de Z : un tri brut le mettrait apres
    // « Zeste ».
    expect(noms(sortLots(jeu(), 'nom'))).toEqual(['Ail', 'Beurre', 'Œuf', 'Zeste'])
  })

  it('trie par quantite decroissante', () => {
    expect(sortLots(jeu(), 'quantite').map((l) => l.stock.quantityG)).toEqual([900, 500, 300, 100])
  })

  it('met les lots SANS DATE en fin de liste, tri par peremption', () => {
    const rendu = sortLots(jeu(), 'peremption')
    expect(rendu.map((l) => l.daysLeft)).toEqual([-2, 2, 6, null])
  })

  it('met les lots sans date en fin AUSSI par urgence, et departage par nom', () => {
    const rendu = sortLots(jeu(), 'urgence')
    expect(noms(rendu)).toEqual(['Beurre', 'Ail', 'Zeste', 'Œuf'])
  })

  it('met les rayons INCONNUS en dernier, jamais melanges au reste', () => {
    const rendu = sortLots(jeu(), 'rayon')
    expect(rendu.map((l) => l.categoryL1)).toEqual(['Crèmerie', 'Épicerie', 'Légumes', null])
  })

  it('ne modifie jamais le tableau recu', () => {
    const source = jeu()
    const avant = noms(source)
    sortLots(source, 'nom')
    expect(noms(source)).toEqual(avant)
  })
})

describe('groupLots', () => {
  const jeu = () =>
    lotsDe(
      [
        stock(1, 1, { expiryDate: '2026-08-16' }),
        stock(2, 2, { expiryDate: '2026-08-25' }),
        stock(3, 3),
      ],
      [
        ingredient(1, { name: 'Ail', categoryL1: 'Légumes' }),
        ingredient(2, { name: 'Beurre', categoryL1: 'Crèmerie' }),
        ingredient(3, { name: 'Riz', categoryL1: null }),
      ],
    )

  it('les TROIS groupements existent', () => {
    expect(GROUPS.map((g) => g.value)).toEqual(['urgence', 'rayon', 'aucun'])
  })

  it('rend une seule section plate quand le groupement est desactive', () => {
    const sections = groupLots(jeu(), 'aucun')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.title).toBeNull()
  })

  it('rend zero section sur une liste vide', () => {
    expect(groupLots([], 'aucun')).toEqual([])
  })

  it('ORDRE FIXE des sections d urgence, quel que soit le tri actif', () => {
    /*
     * Le defaut du desktop : il triait cote Python puis regroupait cote QML par
     * `section.property`, si bien qu'un tri qui ne suivait pas le groupement
     * faisait reapparaitre trois fois la section « En stock ».
     */
    const parNom = groupLots(sortLots(jeu(), 'nom'), 'urgence')
    const parUrgence = groupLots(sortLots(jeu(), 'urgence'), 'urgence')
    expect(parNom.map((s) => s.key)).toEqual(['soon', 'watch', 'stock'])
    expect(parUrgence.map((s) => s.key)).toEqual(['soon', 'watch', 'stock'])
    // Et une section ne peut pas se repeter.
    expect(new Set(parNom.map((s) => s.key)).size).toBe(parNom.length)
  })

  it('retire les sections d urgence vides', () => {
    const lots = lotsDe([stock(1, 1)], [ingredient(1)])
    expect(groupLots(lots, 'urgence').map((s) => s.key)).toEqual(['stock'])
  })

  it('met le rayon inconnu en DERNIER, jamais melange', () => {
    const sections = groupLots(jeu(), 'rayon')
    expect(sections.map((s) => s.title)).toEqual(['Crèmerie', 'Légumes', 'Non catégorisé'])
  })
})

describe('readOption', () => {
  it('retombe sur le defaut quand l URL porte une valeur inconnue', () => {
    // Une adresse partagee ou tapee a la main ne doit pas casser l'ecran.
    expect(readOption('nawak', SORTS, 'urgence')).toBe('urgence')
    expect(readOption(null, SORTS, 'urgence')).toBe('urgence')
    expect(readOption('rayon', SORTS, 'urgence')).toBe('rayon')
  })
})

describe('formatExpiryLabel', () => {
  it('couvre ses SIX cas', () => {
    expect(formatExpiryLabel(null)).toBe('Pas de date')
    expect(formatExpiryLabel(-3)).toBe('Périmé depuis 3 j')
    expect(formatExpiryLabel(0)).toBe("Périme aujourd'hui")
    expect(formatExpiryLabel(1)).toBe('Périme demain')
    expect(formatExpiryLabel(2)).toBe('Dans 2 jours')
    expect(formatExpiryLabel(30)).toBe('Dans 30 jours')
  })

  it('reste NEUTRE entre 6 et 14 jours, alors que la couleur passe a l orange', () => {
    // La couleur dit le seau, le texte dit le delai. Les deux ne disent pas la
    // meme chose, et c'est voulu.
    expect(formatExpiryLabel(10)).toBe('Dans 10 jours')
  })
})

describe('formatExpiryDate', () => {
  it('n affiche PAS LA VEILLE, piege du fuseau europeen', () => {
    /*
     * `new Date('2026-08-31')` interprete la chaine en UTC : a Paris, en heure
     * d'ete, cela retombe au 31 aout a 02:00, mais un decoupage naif suivi d'un
     * `toLocaleDateString` en UTC afficherait le 30. On decoupe donc a la main.
     */
    expect(formatExpiryDate('2026-08-31')).toContain('31')
    expect(formatExpiryDate('2026-08-31')).toContain('août')
    expect(formatExpiryDate('2026-01-01')).toContain('1')
    expect(formatExpiryDate('2026-01-01')).toContain('janvier')
  })

  it('rend la chaine telle quelle si elle n a pas la forme attendue', () => {
    expect(formatExpiryDate('n importe quoi')).toBe('n importe quoi')
  })
})

describe('formatLotQuantity', () => {
  it('donne l equivalent en pieces quand l ingredient en a une', () => {
    const [lot] = lotsDe(
      [stock(1, 7, { quantityG: 180 })],
      [ingredient(7, { name: 'Oeuf', pieceWeightG: 60 })],
    )
    expect(formatLotQuantity(lot as Lot)).toContain('3')
  })

  it('reste en masse quand l ingredient n a pas de piece', () => {
    const [lot] = lotsDe([stock(1, 7, { quantityG: 1500 })], [ingredient(7, { name: 'Riz' })])
    expect(formatLotQuantity(lot as Lot)).toContain('kg')
  })
})
