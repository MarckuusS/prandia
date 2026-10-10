import { describe, expect, it } from 'vitest'

import {
  CATCH_UP_MIN,
  NOTIFICATION_DEF,
  NOTIFICATION_DEFS,
  NOTIFICATION_KINDS,
  dueSlots,
  minutesOf,
  notificationPrefWriteSchema,
  parisClock,
  parseTimes,
} from './notifications.js'

describe('les types de notification', () => {
  it('chaque type a sa definition, et une seule', () => {
    expect(NOTIFICATION_DEFS.map((d) => d.kind).sort()).toEqual([...NOTIFICATION_KINDS].sort())
  })

  it('chaque heure par defaut est une heure valide', () => {
    for (const def of NOTIFICATION_DEFS) {
      expect(def.defaultTimes.length).toBeGreaterThan(0)
      for (const time of def.defaultTimes) expect(minutesOf(time)).not.toBeNull()
    }
  })
})

describe('parisClock', () => {
  it('relit un instant UTC a l heure d ete de Paris', () => {
    // Samedi 10 octobre 2026, 07:00 UTC = 09:00 a Paris (UTC+2).
    expect(parisClock(new Date('2026-10-10T07:00:00Z'))).toEqual({
      day: '2026-10-10',
      minutes: 9 * 60,
      weekday: 5,
      isoWeek: '2026-W41',
    })
  })

  it('suit l heure d hiver', () => {
    // 1er decembre 2026, 08:00 UTC = 09:00 a Paris (UTC+1).
    expect(parisClock(new Date('2026-12-01T08:00:00Z')).minutes).toBe(9 * 60)
  })

  it('change de jour a minuit a Paris, pas a minuit UTC', () => {
    // 22:30 UTC le samedi = 00:30 le dimanche a Paris.
    const clock = parisClock(new Date('2026-10-10T22:30:00Z'))
    expect(clock.day).toBe('2026-10-11')
    expect(clock.weekday).toBe(6)
    expect(clock.minutes).toBe(30)
  })
})

describe('dueSlots', () => {
  const samedi = (minutes: number) => ({ day: '2026-10-10', minutes, weekday: 5, isoWeek: '2026-W41' })
  const dimanche = (minutes: number) => ({ day: '2026-10-11', minutes, weekday: 6, isoWeek: '2026-W41' })
  const soir = 17 * 60 + 30

  it('est du a l heure, et pendant la fenetre de rattrapage', () => {
    expect(dueSlots('repas_soir', ['17:30'], samedi(soir))).toEqual(['2026-10-10'])
    expect(dueSlots('repas_soir', ['17:30'], samedi(soir + CATCH_UP_MIN - 1))).toEqual(['2026-10-10'])
  })

  it('ne l est ni avant, ni apres la fenetre', () => {
    expect(dueSlots('repas_soir', ['17:30'], samedi(soir - 1))).toEqual([])
    expect(dueSlots('repas_soir', ['17:30'], samedi(soir + CATCH_UP_MIN))).toEqual([])
  })

  it('un rappel du dimanche ne part pas le samedi', () => {
    expect(dueSlots('planifier_semaine', ['18:00'], samedi(18 * 60 + 5))).toEqual([])
    expect(dueSlots('planifier_semaine', ['18:00'], dimanche(18 * 60 + 5))).toEqual(['2026-10-11'])
  })

  it('un rappel qui revient porte son heure dans sa cle', () => {
    const heures = ['11:00', '15:00', '18:00']
    expect(dueSlots('hydratation', heures, samedi(15 * 60 + 20))).toEqual(['2026-10-10T15:00'])
  })
})

describe('les heures enregistrees', () => {
  it('absentes : celles du type', () => {
    expect(parseTimes(null, 'hydratation')).toEqual([...NOTIFICATION_DEF.hydratation.defaultTimes])
  })

  it('triees, sans doublon ni heure invalide', () => {
    expect(parseTimes('15:00,11:00,11:00,25:00', 'hydratation')).toEqual(['11:00', '15:00'])
  })

  it('rien de valide : celles du type, plutot qu une liste vide qui ne sonnerait jamais', () => {
    expect(parseTimes('', 'pesee')).toEqual(['07:30'])
  })

  it('refuse une heure mal ecrite et plus de trois heures', () => {
    expect(notificationPrefWriteSchema.safeParse({ enabled: true, times: ['7h30'] }).success).toBe(false)
    expect(
      notificationPrefWriteSchema.safeParse({ enabled: true, times: ['08:00', '09:00', '10:00', '11:00'] }).success,
    ).toBe(false)
  })
})
