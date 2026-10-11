/**
 * Les regles de filtrage de la bibliotheque.
 *
 * Le module est pur — ni React ni reseau — donc il se teste comme une
 * specification. Deux comportements meritent particulierement d'etre figes :
 * une valeur inconnue ne satisfait aucune borne, et un lien partage avant
 * l'arrivee du troisieme etat doit continuer de dire la meme chose.
 */

import { describe, expect, it } from 'vitest'
import type { Ingredient } from '@prandia/shared'

import {
  EMPTY_DRAFT,
  NO_FILTERS,
  activeFilterCount,
  appliquerCompletion,
  bilanCompletion,
  propositionPour,
  criterionValue,
  filterIngredients,
  readViewOptions,
  toggleQuickFilter,
  viewOptionsToParams,
  type LibraryFilters,
} from './model.js'

/**
 * Fabrique un ingredient reduit aux champs que le filtrage regarde.
 *
 * Le transtypage est assume : construire les trente champs du modele complet
 * n'apprendrait rien de plus sur le filtrage, et rendrait chaque test illisible.
 */
const ing = (patch: Partial<Ingredient>): Ingredient =>
  ({
    id: 1,
    name: 'Test',
    brand: null,
    source: 'manual',
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
    categoryL1: null,
    seasonMonths: null,
    ...patch,
  }) as unknown as Ingredient

const avec = (filters: Partial<LibraryFilters>): LibraryFilters => ({ ...NO_FILTERS, ...filters })

describe('criterionValue', () => {
  it('ramene le prix au kilo, quelle que soit la quantite tarifee', () => {
    // 2,50 € pour 500 g, c'est 5 €/kg. Comparer des prix bruts n'aurait aucun
    // sens : l'un est tarife au kilo, l'autre a la piece.
    expect(criterionValue(ing({ priceEur: '2.5000', priceQuantityG: 500 }), 'priceKg')).toBe(5)
  })

  it('rend null plutot que zero quand la donnee manque', () => {
    expect(criterionValue(ing({}), 'proteins')).toBeNull()
    expect(criterionValue(ing({ priceEur: '3.0000', priceQuantityG: null }), 'priceKg')).toBeNull()
    expect(criterionValue(ing({ priceEur: '3.0000', priceQuantityG: 0 }), 'priceKg')).toBeNull()
  })

  it('lit une valeur nutritionnelle telle quelle', () => {
    expect(criterionValue(ing({ proteins: 21.5 }), 'proteins')).toBe(21.5)
  })
})

describe('filterIngredients — bornes', () => {
  const riche = ing({ name: 'Blanc de poulet', proteins: 23, salt: 0.2 })
  const pauvre = ing({ name: 'Riz', proteins: 7, salt: 0.01 })
  const vide = ing({ name: 'Fiche incomplete' })
  const tous = [riche, pauvre, vide]

  it('applique une borne basse', () => {
    const r = filterIngredients(tous, avec({ criteria: [{ field: 'proteins', bound: 'min', value: 20 }] }))
    expect(r.map((i) => i.name)).toEqual(['Blanc de poulet'])
  })

  it('applique une borne haute', () => {
    const r = filterIngredients(tous, avec({ criteria: [{ field: 'proteins', bound: 'max', value: 10 }] }))
    expect(r.map((i) => i.name)).toEqual(['Riz'])
  })

  it('cumule les bornes : toutes doivent etre satisfaites', () => {
    const r = filterIngredients(
      tous,
      avec({
        criteria: [
          { field: 'proteins', bound: 'min', value: 5 },
          { field: 'salt', bound: 'max', value: 0.1 },
        ],
      }),
    )
    expect(r.map((i) => i.name)).toEqual(['Riz'])
  })

  it('EXCLUT les fiches dont la valeur est inconnue', () => {
    // Le point le plus important du lot : sans cette regle, « moins de 1 g de
    // sel » ramenerait toute la bibliotheque incomplete, et l'utilisateur
    // croirait avoir trouve des aliments pauvres en sel.
    const r = filterIngredients(tous, avec({ criteria: [{ field: 'salt', bound: 'max', value: 1 }] }))
    expect(r.map((i) => i.name)).toEqual(['Blanc de poulet', 'Riz'])
    expect(r).not.toContain(vide)
  })
})

describe('filterIngredients — bascules a trois etats', () => {
  const tarife = ing({ name: 'Avec prix', priceEur: '2.0000', priceQuantityG: 1000 })
  const sansPrix = ing({ name: 'Sans prix' })
  const tous = [tarife, sansPrix]

  it('indifferent ne filtre rien', () => {
    expect(filterIngredients(tous, NO_FILTERS)).toHaveLength(2)
  })

  it('« avec » ne garde que ce qui porte la propriete', () => {
    expect(filterIngredients(tous, avec({ withPrice: 'avec' })).map((i) => i.name)).toEqual(['Avec prix'])
  })

  it('« sans » garde exactement le complement', () => {
    // C'est le filtre qui manquait : montrer ce qu'il reste a renseigner.
    expect(filterIngredients(tous, avec({ withPrice: 'sans' })).map((i) => i.name)).toEqual(['Sans prix'])
  })

  it('le cycle revient a son point de depart en trois taps', () => {
    let f = NO_FILTERS
    f = toggleQuickFilter(f, 'withPrice')
    expect(f.withPrice).toBe('avec')
    f = toggleQuickFilter(f, 'withPrice')
    expect(f.withPrice).toBe('sans')
    f = toggleQuickFilter(f, 'withPrice')
    expect(f.withPrice).toBe('indifferent')
  })
})

describe('filterIngredients — marque', () => {
  const tous = [ing({ name: 'A', brand: 'Bjorg' }), ing({ name: 'B', brand: 'Système U' }), ing({ name: 'C' })]

  it('cherche une sous-chaine, accents et casse ignores', () => {
    expect(filterIngredients(tous, avec({ brand: 'systeme' })).map((i) => i.name)).toEqual(['B'])
    expect(filterIngredients(tous, avec({ brand: 'BJO' })).map((i) => i.name)).toEqual(['A'])
  })

  it('une marque absente ne correspond a rien', () => {
    expect(filterIngredients(tous, avec({ brand: 'bjorg' })).map((i) => i.name)).toEqual(['A'])
  })
})

describe('activeFilterCount', () => {
  it('compte chaque borne separement, et chaque liste une fois', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0)
    expect(
      activeFilterCount(
        avec({
          sources: ['ciqual', 'manual'],
          rayons: ['Viandes'],
          withPrice: 'sans',
          brand: 'bjorg',
          criteria: [
            { field: 'proteins', bound: 'min', value: 20 },
            { field: 'salt', bound: 'max', value: 1 },
          ],
        }),
      ),
    ).toBe(6)
  })
})

describe('URL', () => {
  const relire = (params: URLSearchParams) => readViewOptions(params).filters

  it('fait l’aller-retour sur les bornes et la marque', () => {
    const filters = avec({
      brand: 'bjorg',
      withPrice: 'sans',
      inSeason: 'avec',
      criteria: [
        { field: 'proteins', bound: 'min', value: 20 },
        { field: 'priceKg', bound: 'max', value: 12.5 },
      ],
    })
    const params = viewOptionsToParams(readViewOptions(new URLSearchParams()) && {
      ...readViewOptions(new URLSearchParams()),
      filters,
    })
    expect(relire(params)).toEqual(filters)
  })

  it('relit les anciens liens : « f=withPrice » veut toujours dire « avec »', () => {
    // Un lien partage avant l'arrivee du troisieme etat doit dire la meme
    // chose qu'a l'epoque, sans quoi un favori se met a filtrer l'inverse.
    const f = relire(new URLSearchParams('f=withPrice,inSeason'))
    expect(f.withPrice).toBe('avec')
    expect(f.inSeason).toBe('avec')
    expect(f.withBrand).toBe('indifferent')
  })

  it('conserve les decimales — le separateur n’est pas le point', () => {
    const params = viewOptionsToParams({
      ...readViewOptions(new URLSearchParams()),
      filters: avec({ criteria: [{ field: 'salt', bound: 'max', value: 0.5 }] }),
    })
    expect(relire(params).criteria).toEqual([{ field: 'salt', bound: 'max', value: 0.5 }])
  })

  it('ignore en silence une borne illisible', () => {
    const f = relire(new URLSearchParams('bornes=proteins:min:20,nawak:min:3,salt:entre:2,fats:min:abc'))
    expect(f.criteria).toEqual([{ field: 'proteins', bound: 'min', value: 20 }])
  })

  it('n’ecrit que ce qui differe du defaut', () => {
    const params = viewOptionsToParams({
      ...readViewOptions(new URLSearchParams()),
      filters: NO_FILTERS,
    })
    expect(params.has('bornes')).toBe(false)
    expect(params.has('marque')).toBe(false)
    expect(params.has('f')).toBe(false)
  })
})

describe('appliquerCompletion', () => {
  const proposition = { rayon: 'Epicerie', poidsCuitG: 300, moisSaison: [6, 7, 8, 9], poidsPieceG: 30 }

  it('remplit les champs vides et dit lesquels', () => {
    const { patch, champs } = appliquerCompletion(EMPTY_DRAFT, proposition)
    expect(patch).toEqual({
      categoryL1: 'Epicerie',
      cookedWeightPer100gRaw: 300,
      months: [6, 7, 8, 9],
      pieceWeightG: 30,
    })
    expect(champs).toEqual(['rayon', 'poidsPiece', 'poidsCuit', 'saison'])
  })

  it('ne remplace jamais une saisie', () => {
    const draft = { ...EMPTY_DRAFT, categoryL1: 'Vrac', cookedWeightPer100gRaw: 250, months: [5], pieceWeightG: 40 }
    expect(appliquerCompletion(draft, proposition)).toEqual({ patch: {}, champs: [] })
  })

  it('laisse vide ce que l’IA ne sait pas', () => {
    const rien = { rayon: null, poidsCuitG: null, moisSaison: null, poidsPieceG: null }
    expect(appliquerCompletion(EMPTY_DRAFT, rien)).toEqual({ patch: {}, champs: [] })
  })

  it('ignore une reponse a laquelle il manque une cle, au lieu de casser la fiche', () => {
    const incomplete = { poidsCuitG: 75 } as unknown as Parameters<typeof appliquerCompletion>[1]
    expect(appliquerCompletion(EMPTY_DRAFT, incomplete)).toEqual({
      patch: { cookedWeightPer100gRaw: 75 },
      champs: ['poidsCuit'],
    })
  })
})

describe('propositionPour', () => {
  it('rend la valeur d’un seul champ, meme si la fiche en a deja une', () => {
    const c = { rayon: 'Boucherie', poidsCuitG: 75, moisSaison: null, poidsPieceG: null }
    expect(propositionPour(c, 'rayon')).toEqual({ categoryL1: 'Boucherie' })
    expect(propositionPour(c, 'poidsCuit')).toEqual({ cookedWeightPer100gRaw: 75 })
    expect(propositionPour(c, 'saison')).toBeNull()
    expect(propositionPour(c, 'poidsPiece')).toBeNull()
  })
})

describe('bilanCompletion', () => {
  it('compte ce qui a ete ajoute, avec le bon accord', () => {
    expect(bilanCompletion({ traites: 40, rayons: 3, poidsCuits: 1, saisons: 12 })).toBe(
      '40 produits relus : 3 rayons, 1 poids cuit, 12 saisons ajoutés. Tout se corrige dans la fiche.',
    )
    expect(bilanCompletion({ traites: 1, rayons: 0, poidsCuits: 0, saisons: 1 })).toBe(
      '1 produit relu : 1 saison ajoutée. Tout se corrige dans la fiche.',
    )
  })

  it('dit quand il n’y avait rien de sur, ou rien de fait', () => {
    expect(bilanCompletion({ traites: 5, rayons: 0, poidsCuits: 0, saisons: 0 })).toBe(
      '5 produits relus, rien de sûr à ajouter.',
    )
    expect(bilanCompletion({ traites: 0, rayons: 0, poidsCuits: 0, saisons: 0 })).toBe(
      'Rien n’a pu être complété. Réessaie plus tard.',
    )
  })
})
