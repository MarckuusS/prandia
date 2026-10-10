/**
 * Notifications : les types, leurs heures, et quand chacune est due.
 *
 * Module PUR, partage par le Worker planifie qui envoie, par l'API qui
 * enregistre les preferences, et par l'ecran qui les regle. Trois copies de la
 * liste des types, ou de leurs heures par defaut, finiraient par diverger.
 *
 * TOUT SE COMPTE A L'HEURE DE PARIS. Un Worker tourne en UTC : "9 h" n'y veut
 * rien dire, et l'ecart change deux fois par an. `parisClock` relit l'instant
 * en heure de Paris, une fois, et tout le reste en derive.
 */

import { z } from 'zod'

import { currentIsoWeek } from './isoweek.js'

export const NOTIFICATION_KINDS = [
  'peremption',
  'seuil',
  'repas_soir',
  'planifier_semaine',
  'hydratation',
  'pesee',
  'bilan_semaine',
] as const

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export interface NotificationDef {
  readonly kind: NotificationKind
  readonly label: string
  /** Ce que la notification dit, et quand elle se tait. Affiche sous la case. */
  readonly description: string
  readonly famille: 'cuisine' | 'sante'
  /** Heures par defaut, "HH:MM" a Paris. Plusieurs : un rappel qui revient. */
  readonly defaultTimes: readonly string[]
  /** Jour de la semaine (0 = lundi, 6 = dimanche), ou `null` : tous les jours. */
  readonly weekday: number | null
  /**
   * Envoyee par la planification. `false` : le type se regle deja mais ne part
   * pas encore, et l'ecran le dit au lieu de laisser croire qu'il marche.
   */
  readonly disponible: boolean
}

export const NOTIFICATION_DEFS: readonly NotificationDef[] = [
  {
    kind: 'peremption',
    label: 'Péremption au frigo',
    description: 'Un produit du frigo ou du cellier arrive à sa date limite, la veille et le jour même.',
    famille: 'cuisine',
    defaultTimes: ['09:00'],
    weekday: null,
    disponible: false,
  },
  {
    kind: 'seuil',
    label: 'Stock sous le seuil',
    description: 'Des produits sont passés sous le seuil que tu as fixé : à racheter.',
    famille: 'cuisine',
    defaultTimes: ['09:00'],
    weekday: null,
    disponible: false,
  },
  {
    kind: 'repas_soir',
    label: 'Repas du soir',
    description: 'Ce qui est prévu ce soir au planning, ou qu’il n’y a encore rien.',
    famille: 'cuisine',
    defaultTimes: ['17:30'],
    weekday: null,
    disponible: true,
  },
  {
    kind: 'planifier_semaine',
    label: 'Planifier la semaine',
    description: 'Le dimanche, seulement si la semaine suivante est encore vide.',
    famille: 'cuisine',
    defaultTimes: ['18:00'],
    weekday: 6,
    disponible: true,
  },
  {
    kind: 'hydratation',
    label: 'Hydratation',
    description: 'Ce qu’il reste à boire, seulement si l’objectif du jour n’est pas atteint.',
    famille: 'sante',
    defaultTimes: ['11:00', '15:00', '18:00'],
    weekday: null,
    disponible: false,
  },
  {
    kind: 'pesee',
    label: 'Pesée',
    description: 'Un rappel le matin, seulement si tu ne t’es pas encore pesé ce jour-là.',
    famille: 'sante',
    defaultTimes: ['07:30'],
    weekday: null,
    disponible: true,
  },
  {
    kind: 'bilan_semaine',
    label: 'Bilan de la semaine',
    description: 'Le dimanche soir : les jours où l’objectif est tenu, la tendance du poids.',
    famille: 'sante',
    defaultTimes: ['19:00'],
    weekday: 6,
    disponible: false,
  },
]

export const NOTIFICATION_DEF: Readonly<Record<NotificationKind, NotificationDef>> = Object.fromEntries(
  NOTIFICATION_DEFS.map((def) => [def.kind, def]),
) as Record<NotificationKind, NotificationDef>

export const isNotificationKind = (value: string): value is NotificationKind =>
  (NOTIFICATION_KINDS as readonly string[]).includes(value)

// ---------------------------------------------------------------------------
// Heures
// ---------------------------------------------------------------------------

const HEURE = /^([01]\d|2[0-3]):([0-5]\d)$/

/** Minutes depuis minuit pour "HH:MM", `null` si le texte n'en est pas une. */
export function minutesOf(time: string): number | null {
  const match = HEURE.exec(time)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Le nombre maximal d'heures par type : trois rappels d'hydratation suffisent. */
export const MAX_TIMES = 3

export const notificationPrefWriteSchema = z.object({
  enabled: z.boolean(),
  /** `null` : les heures par defaut du type. */
  times: z
    .array(z.string().regex(HEURE, 'Une heure s’écrit HH:MM, entre 00:00 et 23:59.'))
    .min(1, 'Il faut au moins une heure.')
    .max(MAX_TIMES, `Trois heures au plus.`)
    .nullable()
    .default(null),
})
export type NotificationPrefWrite = z.infer<typeof notificationPrefWriteSchema>

/** Heures stockees ("HH:MM,HH:MM") vers une liste triee, sans doublon ni valeur invalide. */
export function parseTimes(stored: string | null, kind: NotificationKind): string[] {
  const raw = stored === null ? [...NOTIFICATION_DEF[kind].defaultTimes] : stored.split(',')
  const valides = raw.map((t) => t.trim()).filter((t) => minutesOf(t) !== null)
  const uniques = [...new Set(valides)].sort()
  return uniques.length > 0 ? uniques.slice(0, MAX_TIMES) : [...NOTIFICATION_DEF[kind].defaultTimes]
}

// ---------------------------------------------------------------------------
// L'heure de Paris et ce qui est du
// ---------------------------------------------------------------------------

export interface ParisClock {
  /** Date du jour a Paris, "YYYY-MM-DD". */
  readonly day: string
  /** Minutes depuis minuit, a Paris. */
  readonly minutes: number
  /** 0 = lundi ... 6 = dimanche, comme `meal_plan_entry.day_of_week`. */
  readonly weekday: number
  /** Semaine ISO du jour a Paris, "2026-W41". */
  readonly isoWeek: string
}

const PARIS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function parisClock(now: Date): ParisClock {
  const parts = Object.fromEntries(PARIS.formatToParts(now).map((p) => [p.type, p.value]))
  const y = Number(parts['year'])
  const m = Number(parts['month'])
  const d = Number(parts['day'])
  // Les composantes de Paris dans une date "locale" : `currentIsoWeek` les relit
  // telles quelles, quel que soit le fuseau de la machine qui execute.
  const local = new Date(y, m - 1, d)
  return {
    day: `${parts['year']}-${parts['month']}-${parts['day']}`,
    minutes: Number(parts['hour']) * 60 + Number(parts['minute']),
    weekday: (local.getDay() + 6) % 7,
    isoWeek: currentIsoWeek(local),
  }
}

/**
 * Fenetre de rattrapage, en minutes. La planification passe toutes les cinq
 * minutes ; si un passage manque, le suivant rattrape le rappel, mais pas au-dela
 * d'une heure : un "repas du soir" recu a 22 h n'a plus de sens.
 */
export const CATCH_UP_MIN = 60

/**
 * Les envois dus a cet instant pour ce type : la cle de chacun, a noter dans
 * `notification_log` pour ne jamais l'envoyer deux fois.
 *
 * Une heure est due si l'instant est dans `[heure, heure + CATCH_UP_MIN[` le bon
 * jour. La cle porte le jour, plus l'heure quand le type en a plusieurs.
 */
export function dueSlots(kind: NotificationKind, times: readonly string[], clock: ParisClock): string[] {
  const def = NOTIFICATION_DEF[kind]
  if (def.weekday !== null && def.weekday !== clock.weekday) return []
  const plusieurs = times.length > 1
  return times.flatMap((time) => {
    const start = minutesOf(time)
    if (start === null) return []
    const due = clock.minutes >= start && clock.minutes < start + CATCH_UP_MIN
    return due ? [plusieurs ? `${clock.day}T${time}` : clock.day] : []
  })
}
