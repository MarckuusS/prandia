/**
 * Ce que disent les rappels, et les regles qu'ils partagent avec les ecrans.
 *
 * Les attendus sont ecrits a la main. Les regles partagees (journee tenue,
 * cible du jour, apports d'une entree) sont testees ici parce que c'est le
 * bilan du dimanche qui a impose de les sortir des ecrans : si l'une diverge,
 * la notification et l'ecran annonceraient deux choses pour la meme journee.
 */

import { describe, expect, it } from 'vitest'

import { ingredientSchema, type Ingredient } from './models.js'
import {
  expiryMessage,
  formatLitres,
  hydrationMessage,
  listeNoms,
  restockMessage,
  weekReviewMessage,
} from './notifications.js'
import { mealEntryNutrition } from './nutrition.js'
import { dailyTargetsOf, dayOnTarget, estimateTargets, type StoredProfile } from './profile.js'

describe('formatLitres', () => {
  it('ecrit des litres a une decimale, a la francaise', () => {
    expect(formatLitres(800)).toBe('0,8 L')
    expect(formatLitres(2000)).toBe('2 L')
    expect(formatLitres(2449)).toBe('2,4 L')
  })

  it('arrondit au dixieme superieur ce qu’il reste a boire', () => {
    // Au plus proche, 30 ml donneraient "encore 0 L".
    expect(formatLitres(30, true)).toBe('0,1 L')
    expect(formatLitres(1210, true)).toBe('1,3 L')
  })
})

describe('listeNoms', () => {
  it('relie les noms comme on les dirait', () => {
    expect(listeNoms(['riz'])).toBe('riz')
    expect(listeNoms(['riz', 'pâtes'])).toBe('riz et pâtes')
    expect(listeNoms(['riz', 'pâtes', 'huile'])).toBe('riz, pâtes et huile')
  })

  it('compte le reste au-dela de trois noms', () => {
    expect(listeNoms(['a', 'b', 'c', 'd'])).toBe('a, b, c et 1 autre')
    expect(listeNoms(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c et 2 autres')
  })
})

describe('expiryMessage', () => {
  it('separe le jour meme de la veille', () => {
    expect(
      expiryMessage([
        { name: 'Lait', daysLeft: 0 },
        { name: 'Jambon', daysLeft: 1 },
        { name: 'Yaourt', daysLeft: 0 },
      ]),
    ).toEqual({ title: 'À consommer', body: 'Aujourd’hui : Lait et Yaourt. Demain : Jambon.' })
  })

  it('nomme un produit une seule fois, au jour le plus proche', () => {
    // Deux briques de lait, l'une pour aujourd'hui, l'autre pour demain.
    expect(
      expiryMessage([
        { name: 'Lait', daysLeft: 1 },
        { name: 'Lait', daysLeft: 0 },
        { name: 'Lait', daysLeft: 0 },
      ])?.body,
    ).toBe('Aujourd’hui : Lait.')
  })

  it('se tait quand rien n’arrive a sa date', () => {
    expect(expiryMessage([])).toBeNull()
    // Un lot deja perime ne revient pas chaque matin.
    expect(expiryMessage([{ name: 'Yaourt', daysLeft: -3 }])).toBeNull()
  })
})

describe('restockMessage', () => {
  it('liste ce qui est passe sous le seuil', () => {
    expect(restockMessage(['Riz', 'Pâtes'])).toEqual({ title: 'À racheter', body: 'Sous ton seuil : Riz et Pâtes.' })
  })

  it('se tait sans nouveau produit', () => {
    expect(restockMessage([])).toBeNull()
  })
})

describe('hydrationMessage', () => {
  it('dit ou l’on en est et ce qu’il reste', () => {
    expect(hydrationMessage(800, 2400)?.body).toBe('Tu en es à 0,8 L sur 2,4 L : encore 1,6 L.')
  })

  it('le dit autrement quand rien n’est note', () => {
    expect(hydrationMessage(0, 2400)?.body).toBe('Rien de noté aujourd’hui. Objectif : 2,4 L.')
  })

  it('se tait des que l’objectif est atteint', () => {
    expect(hydrationMessage(2400, 2400)).toBeNull()
    expect(hydrationMessage(3000, 2400)).toBeNull()
  })
})

describe('weekReviewMessage', () => {
  it('donne les jours tenus et la tendance', () => {
    expect(weekReviewMessage({ days: { onTarget: 4, planned: 6 }, paceKgPerWeek: -0.42 })).toEqual({
      title: 'Ta semaine',
      body: 'Objectif tenu 4 jours sur 6 planifiés. Poids : -0,4 kg par semaine sur quatre semaines.',
    })
  })

  it('accorde le singulier', () => {
    expect(weekReviewMessage({ days: { onTarget: 1, planned: 1 }, paceKgPerWeek: null })?.body).toBe(
      'Objectif tenu 1 jour sur 1 planifié.',
    )
    expect(weekReviewMessage({ days: { onTarget: 0, planned: 3 }, paceKgPerWeek: null })?.body).toBe(
      'Objectif tenu 0 jour sur 3 planifiés.',
    )
  })

  it('signe une prise sans la juger, et dit stable sous 50 g par semaine', () => {
    expect(weekReviewMessage({ days: null, paceKgPerWeek: 0.3 })?.body).toBe(
      'Poids : +0,3 kg par semaine sur quatre semaines.',
    )
    expect(weekReviewMessage({ days: null, paceKgPerWeek: -0.04 })?.body).toBe('Poids stable sur quatre semaines.')
  })

  it('se tait sans rien a dire', () => {
    expect(weekReviewMessage({ days: null, paceKgPerWeek: null })).toBeNull()
  })
})

describe('dayOnTarget, partagee par la semaine, les Objectifs et le bilan', () => {
  it('tient a 10 % pres de la cible, pour la part d’une personne', () => {
    // Deux mangeurs, 4 000 kcal pour la cuisine : 2 000 chacun.
    expect(dayOnTarget(4000, 3, 2000, 2)).toBe(true)
    expect(dayOnTarget(4400, 3, 2000, 2)).toBe(true) // 2 200, pile 10 %
    expect(dayOnTarget(4420, 3, 2000, 2)).toBe(false) // 2 210
  })

  it('ne tient rien sans repas ni sans objectif', () => {
    expect(dayOnTarget(0, 0, 2000, 1)).toBe(false)
    expect(dayOnTarget(2000, 2, null, 1)).toBe(false)
  })
})

describe('dailyTargetsOf', () => {
  const NOW = new Date('2026-08-11T12:00:00Z')
  const STOCKE: StoredProfile = {
    sex: 'm',
    birthYear: 1996,
    heightCm: 180,
    weightKg: 80,
    activity: 'actif',
    goal: 'maintien',
    split: null,
    splitProteins: null,
    splitCarbs: null,
    splitFats: null,
    targetWeightKg: null,
    paceKgPerWeek: null,
    kcalTarget: null,
  }

  it('rend la cible calculee depuis le profil stocke', () => {
    const attendu = estimateTargets(
      { sex: 'm', birthYear: 1996, heightCm: 180, weightKg: 80, activity: 'actif', goal: 'maintien' },
      NOW,
    )
    expect(dailyTargetsOf(STOCKE, NOW).kcalTarget).toBe(attendu?.kcal)
  })

  it('fait passer la cible saisie a la main avant la cible calculee', () => {
    expect(dailyTargetsOf({ ...STOCKE, kcalTarget: 1850 }, NOW).kcalTarget).toBe(1850)
  })

  it('rend null quand une mesure manque, et un code inconnu ne fait rien tomber', () => {
    expect(dailyTargetsOf({ ...STOCKE, weightKg: null }, NOW).kcalTarget).toBeNull()
    expect(dailyTargetsOf({ ...STOCKE, activity: 'retire-des-listes' }, NOW).kcalTarget).toBeNull()
  })
})

describe('mealEntryNutrition', () => {
  const ingredient = (overrides: Partial<Ingredient>): Ingredient =>
    ingredientSchema.parse({ name: 'Test', source: 'manual', kcal: 100, proteins: 10, carbs: 20, fats: 5, ...overrides })

  it('pese un ingredient a sa quantite', () => {
    // 150 g a 200 kcal pour 100 g.
    expect(mealEntryNutrition({ quantityG: 150, portions: null }, { kind: 'ingredient', ingredient: ingredient({ kcal: 200 }) }).kcal).toBe(300)
  })

  it('met une recette a l’echelle des portions servies', () => {
    // 400 g a 100 kcal pour 100 g, pour 2 portions : 200 kcal la portion.
    const recipe = {
      defaultPortions: 2,
      lines: [{ ingredient: ingredient({}), quantityG: 400, unit: null, notes: null, ordinal: 0 }],
    }
    expect(mealEntryNutrition({ quantityG: null, portions: 1 }, { kind: 'recipe', recipe }).kcal).toBe(200)
    expect(mealEntryNutrition({ quantityG: null, portions: 3 }, { kind: 'recipe', recipe }).kcal).toBe(600)
  })

  it('ne pese rien pour une reference disparue', () => {
    expect(mealEntryNutrition({ quantityG: 100, portions: null }, null).kcal).toBe(0)
  })
})
