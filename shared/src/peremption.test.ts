import { describe, expect, it } from 'vitest'

import { addDaysIso, formatExpiryInput, parseExpiryText } from './peremption.js'

/** Un dimanche d'octobre : assez loin de janvier pour que l'annee se devine. */
const AUJOURDHUI = '2026-10-11'
const lire = (texte: string) => parseExpiryText(texte, AUJOURDHUI)

describe('parseExpiryText, dates completes', () => {
  it('lit les formes numeriques courantes', () => {
    expect(lire('14/10/26')).toEqual({ date: '2026-10-14', precision: 'jour' })
    expect(lire('14.10.2026')?.date).toBe('2026-10-14')
    expect(lire('14-10-26')?.date).toBe('2026-10-14')
    expect(lire('14 10 26')?.date).toBe('2026-10-14')
    expect(lire('4/1/27')?.date).toBe('2027-01-04')
  })

  it('retrouve la date dans ce que l’iPhone lit sur l’emballage', () => {
    expect(lire('A consommer jusqu’au : 14/10/26 L5285 12:41')?.date).toBe('2026-10-14')
    expect(lire('À CONSOMMER JUSQU’AU 1er novembre 2026')?.date).toBe('2026-11-01')
    expect(lire('DLC 14 OCT 2026 LOT 2871')?.date).toBe('2026-10-14')
  })

  it('prend la plus tardive quand la fabrication est imprimee a cote', () => {
    expect(lire('Fabriqué le 02/10/26 À consommer jusqu’au 20/10/26')?.date).toBe('2026-10-20')
  })

  it('lit une date tapee d’un trait, mais seulement quand il n’y a que des chiffres', () => {
    expect(lire('141026')?.date).toBe('2026-10-14')
    expect(lire('14102026')?.date).toBe('2026-10-14')
    // Un numero de lot n'est pas une date.
    expect(lire('L141026')).toBeNull()
  })

  it('refuse une date qui n’existe pas, ou une annee absurde', () => {
    expect(lire('31/02/27')).toBeNull()
    expect(lire('14/10/99')).toBeNull()
    expect(lire('14/13/26')).toBeNull()
  })

  it('ne prend pas l’heure de fabrication pour une date', () => {
    expect(lire('12:41')).toBeNull()
  })
})

describe('parseExpiryText, dates au mois', () => {
  it('lit une DDM au mois, jusqu’au dernier jour', () => {
    expect(lire('À consommer de préférence avant fin : 03/2027')).toEqual({ date: '2027-03-31', precision: 'mois' })
    expect(lire('02/2028')?.date).toBe('2028-02-29')
    expect(lire('MARS 2027')).toEqual({ date: '2027-03-31', precision: 'mois' })
  })

  it('lit "03/27" comme un mois, 27 ne pouvant pas en etre un', () => {
    expect(lire('03/27')).toEqual({ date: '2027-03-31', precision: 'mois' })
  })
})

describe('parseExpiryText, sans annee', () => {
  it('date un "14/10" de l’annee en cours', () => {
    expect(lire('14/10')).toEqual({ date: '2026-10-14', precision: 'jour' })
    expect(lire('20 oct')?.date).toBe('2026-10-20')
  })

  it('garde un produit perime de quelques jours dans l’annee en cours', () => {
    expect(lire('05/10')?.date).toBe('2026-10-05')
  })

  it('renvoie a l’an prochain une date de plus de deux mois en arriere', () => {
    expect(lire('05/01')?.date).toBe('2027-01-05')
  })
})

describe('parseExpiryText, rien a lire', () => {
  it('rend null sur du vide ou du texte sans date', () => {
    expect(lire('')).toBeNull()
    expect(lire('   ')).toBeNull()
    expect(lire('Yaourt nature 4 x 125 g')).toBeNull()
    expect(lire('Conserver 12 mois')).toBeNull()
  })
})

describe('addDaysIso et formatExpiryInput', () => {
  it('ajoute des jours au calendrier, fins de mois et d’annee comprises', () => {
    expect(addDaysIso('2026-10-11', 1)).toBe('2026-10-12')
    expect(addDaysIso('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysIso('2026-10-11', -60)).toBe('2026-08-12')
  })

  it('ecrit la date comme on la lit sur l’emballage', () => {
    expect(formatExpiryInput('2026-10-14')).toBe('14/10/26')
  })

  it('relit exactement ce qu’elle ecrit', () => {
    const date = '2027-03-05'
    expect(lire(formatExpiryInput(date))?.date).toBe(date)
  })
})
