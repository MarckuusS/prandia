/**
 * L'horloge des notifications. Une alarme qui ne se re-arme pas ne sonne
 * qu'une fois, et rien ne le signale : les rappels cessent simplement d'arriver.
 * Chaque test correspond a une facon de rompre la chaine.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Horloge, prochainReveil, type NotifierEnv } from './notifier.js'

const ICI = dirname(fileURLToPath(import.meta.url))
const lire = (nom: string) => readFileSync(join(ICI, '..', '..', nom), 'utf8')

/** Un stockage d'alarme en memoire, seul morceau de l'etat que l'horloge lit. */
function etat(alarme: number | null = null) {
  const stockage = {
    alarme,
    getAlarm: vi.fn(async () => stockage.alarme),
    setAlarm: vi.fn(async (quand: number) => {
      stockage.alarme = quand
    }),
  }
  return { stockage, state: { storage: stockage } as unknown as DurableObjectState }
}

const envSansBase: NotifierEnv = {
  // Des cles presentes, pour que `planifier` aille jusqu'a la base.
  VAPID_PUBLIC_KEY: 'publique',
  VAPID_PRIVATE_KEY: 'privee',
  VAPID_SUBJECT: 'https://prandia.pages.dev',
  DB: {
    prepare: () => {
      throw new Error('base injoignable')
    },
  } as unknown as NotifierEnv['DB'],
  HORLOGE: {} as DurableObjectNamespace,
  MEDIA: {} as NotifierEnv['MEDIA'],
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('prochainReveil', () => {
  it('tombe sur le multiple de cinq minutes qui suit', () => {
    expect(prochainReveil(Date.UTC(2026, 9, 10, 12, 3, 10))).toBe(Date.UTC(2026, 9, 10, 12, 5, 0))
  })

  it('ne rend jamais l’instant même, sans quoi l’alarme sonnerait en boucle', () => {
    expect(prochainReveil(Date.UTC(2026, 9, 10, 12, 5, 0))).toBe(Date.UTC(2026, 9, 10, 12, 10, 0))
  })
})

describe('Horloge', () => {
  it('se re-arme même quand les rappels ET la sauvegarde échouent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { stockage, state } = etat()
    const avant = Date.now()

    await expect(new Horloge(state, envSansBase).alarm()).resolves.toBeUndefined()

    // Lever ferait rejouer l'alarme par le runtime ; ne pas se re-armer la
    // perdrait. Les deux sont evites : rien ne sort, et la suivante est posee.
    expect(stockage.setAlarm).toHaveBeenCalledTimes(1)
    expect(stockage.alarme).toBe(prochainReveil(avant))
  })

  it('part tout de suite quand on la remonte sans alarme posée', async () => {
    const { stockage, state } = etat(null)
    const avant = Date.now()
    await new Horloge(state, envSansBase).fetch()
    expect(stockage.setAlarm).toHaveBeenCalledTimes(1)
    expect(stockage.alarme).toBeGreaterThanOrEqual(avant)
    expect(stockage.alarme).toBeLessThanOrEqual(Date.now())
  })

  it('ne déplace pas une alarme qui attend déjà', async () => {
    // Sans cela, chaque visite de l'ecran Notifications avancerait le passage
    // suivant, et une personne qui rouvre l'ecran souvent decalerait tout.
    const prevue = Date.UTC(2026, 9, 10, 12, 5, 0)
    const { stockage, state } = etat(prevue)
    await new Horloge(state, envSansBase).fetch()
    expect(stockage.setAlarm).not.toHaveBeenCalled()
    expect(stockage.alarme).toBe(prevue)
  })
})

describe('configuration', () => {
  const notifier = lire('notifier/wrangler.toml')
  const site = lire('wrangler.toml')

  it('ne déclare aucun déclencheur horaire', () => {
    // Le plan gratuit borne le COMPTE a cinq crons, tous pris. Et celui pose
    // pour la sauvegarde le 2026-10-11, au plan payant, n'a jamais sonne : la
    // sauvegarde passe par l'horloge, comme les rappels. La liste VIDE est
    // exigee : sans elle, un deploiement laisserait l'ancien cron en place.
    expect(notifier.match(/^\s*crons\s*=.*$/gm)?.map((ligne) => ligne.trim())).toEqual(['crons = []'])
  })

  it('crée l’horloge en stockage SQLite, le seul du plan gratuit', () => {
    expect(notifier).toMatch(/new_sqlite_classes\s*=\s*\["Horloge"\]/)
  })

  it('lie le site à l’horloge du bon Worker', () => {
    const nom = /^name\s*=\s*"([^"]+)"/m.exec(notifier)?.[1]
    expect(nom).toBe('prandia-notifier')
    expect(site).toContain(`script_name = "${nom}"`)
    expect(site).toMatch(/class_name\s*=\s*"Horloge"/)
  })
})
