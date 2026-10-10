/**
 * La planification des notifications : un Worker A PART, et une horloge.
 *
 * POURQUOI A PART. Le site et son API sont une Pages Function, et Pages ne sait
 * pas declencher une action a heure fixe. Ce Worker-ci n'a aucune route : il
 * porte l'horloge, lit la meme base et envoie ce qui est du. Il se deploie par
 * `wrangler deploy`, pas par le push sur main : voir docs/deploiement.md.
 *
 * POURQUOI UNE ALARME ET PAS UN DECLENCHEUR HORAIRE. Le plan gratuit de
 * Cloudflare borne le COMPTE a cinq declencheurs (cron), et d'autres projets
 * les occupent tous : le deploiement a ete refuse. L'horloge est donc un
 * Durable Object dont l'alarme sonne toutes les cinq minutes ; une alarme ne
 * consomme aucun declencheur. Elle se RE-ARME AVANT de travailler, et le
 * travail ne leve jamais : une erreur d'envoi ne casse pas la chaine. Si elle
 * se rompt quand meme, l'API la remonte a la visite suivante de l'ecran
 * Notifications (worker/src/horloge.ts).
 *
 * L'ORDRE D'UN ENVOI EST LA SEULE GARANTIE CONTRE LE DOUBLON. On RESERVE d'abord
 * la cle dans `notification_log` (`INSERT OR IGNORE`) : de deux passages qui se
 * chevauchent, un seul obtient `changes = 1`. Puis on compose, puis on envoie.
 * Consequence assumee : un envoi qui echoue apres la reservation n'est pas
 * retente dans la fenetre. Une notification manquee vaut mieux qu'une
 * notification recue en double, qui fait desactiver toutes les autres.
 *
 * "RIEN A DIRE" EST UNE REPONSE. Deja pese ce matin, semaine suivante deja
 * remplie : `composer` rend `null`, la cle reste posee, et le passage suivant ne
 * reposera pas la question pendant toute la fenetre.
 */

import type { D1Database, DurableObject, DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types'
import {
  NOTIFICATION_DEF,
  dueSlots,
  isNotificationKind,
  nextIsoWeek,
  parisClock,
  parseTimes,
  type NotificationKind,
  type ParisClock,
} from '@prandia/shared'

import { remonterHorloge } from './horloge.js'
import { sendPush, vapidFrom, type PushContent, type VapidEnv } from './push.js'
import { recordDelivery } from './repos/notifications.js'

export interface NotifierEnv extends VapidEnv {
  readonly DB: D1Database
  readonly HORLOGE: DurableObjectNamespace
}

const PERIODE_MS = 5 * 60 * 1000

/** Le multiple de cinq minutes qui suit : des passages a heure ronde. */
export function prochainReveil(now: number): number {
  return (Math.floor(now / PERIODE_MS) + 1) * PERIODE_MS
}

export class Horloge implements DurableObject {
  private readonly state: DurableObjectState
  private readonly env: NotifierEnv

  constructor(state: DurableObjectState, env: NotifierEnv) {
    this.state = state
    this.env = env
  }

  /**
   * Remonter : poser l'alarme si aucune n'attend, et dire quand elle sonnera.
   * Une horloge qui n'avait rien de pose part TOUT DE SUITE : le premier
   * passage n'attend pas le multiple de cinq minutes.
   */
  async fetch(): Promise<Response> {
    let prochain = await this.state.storage.getAlarm()
    if (prochain === null) {
      prochain = Date.now()
      await this.state.storage.setAlarm(prochain)
    }
    return Response.json({ prochain: new Date(prochain).toISOString() })
  }

  async alarm(): Promise<void> {
    await this.state.storage.setAlarm(prochainReveil(Date.now()))
    try {
      await planifier(this.env, new Date())
    } catch (error) {
      // Lever ferait rejouer l'alarme par le runtime, en plus de celle qu'on
      // vient de poser. On journalise et on attend le passage suivant.
      console.error('notifier : passage en echec', error)
    }
  }
}

export default {
  /**
   * Aucune adresse ne mene ici en production (`workers_dev` et `preview_urls`
   * a false). En local, `wrangler dev` y repond : c'est la facon de remonter
   * l'horloge a la main pour un essai.
   */
  async fetch(_request: Request, env: NotifierEnv): Promise<Response> {
    await remonterHorloge(env.HORLOGE)
    return new Response('horloge remontee\n')
  },
}

interface Abonne {
  readonly user_id: number
  readonly household_id: number
  readonly kind: string
  readonly times: string | null
}

export async function planifier(env: NotifierEnv, now: Date): Promise<number> {
  const vapid = vapidFrom(env)
  if (vapid === null) return 0
  const clock = parisClock(now)

  // Seulement ce qui peut partir : type active, compte actif, au moins un appareil.
  const { results } = await env.DB.prepare(
    `SELECT p.user_id, u.household_id, p.kind, p.times
       FROM notification_pref p
       JOIN user u ON u.id = p.user_id
      WHERE p.enabled = 1 AND u.is_active = 1
        AND EXISTS (SELECT 1 FROM push_subscription s WHERE s.user_id = p.user_id)`,
  ).all<Abonne>()

  let envoyes = 0
  for (const abonne of results) {
    if (!isNotificationKind(abonne.kind) || !NOTIFICATION_DEF[abonne.kind].disponible) continue
    for (const cle of dueSlots(abonne.kind, parseTimes(abonne.times, abonne.kind), clock)) {
      const reservation = await env.DB.prepare(
        'INSERT OR IGNORE INTO notification_log (user_id, kind, slot_key) VALUES (?, ?, ?)',
      )
        .bind(abonne.user_id, abonne.kind, cle)
        .run()
      if ((reservation.meta.changes ?? 0) === 0) continue

      const contenu = await composer(env.DB, abonne.kind, abonne.user_id, abonne.household_id, clock)
      if (contenu === null) continue
      envoyes += await livrer(env.DB, abonne.user_id, contenu, vapid)
    }
  }
  return envoyes
}

async function livrer(
  db: D1Database,
  userId: number,
  contenu: PushContent,
  vapid: NonNullable<ReturnType<typeof vapidFrom>>,
): Promise<number> {
  const { results } = await db
    .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = ?')
    .bind(userId)
    .all<{ id: number; endpoint: string; p256dh: string; auth: string }>()
  let envoyes = 0
  for (const appareil of results) {
    const resultat = await sendPush(appareil, contenu, vapid).catch(() => 'echec' as const)
    await recordDelivery(db, appareil.id, resultat)
    if (resultat === 'envoye') envoyes += 1
  }
  return envoyes
}

/** Ce que dit la notification, ou `null` quand il n'y a rien a dire. */
export async function composer(
  db: D1Database,
  kind: NotificationKind,
  userId: number,
  householdId: number,
  clock: ParisClock,
): Promise<PushContent | null> {
  switch (kind) {
    case 'repas_soir': {
      const { results } = await db
        .prepare(
          `SELECT COALESCE(r.name, i.name) AS nom
             FROM meal_plan_entry e
             LEFT JOIN recipe r ON r.id = e.recipe_id
             LEFT JOIN ingredient i ON i.id = e.ingredient_id
            WHERE e.household_id = ? AND e.iso_week = ? AND e.day_of_week = ? AND e.slot = 'evening'
            ORDER BY e.ordinal`,
        )
        .bind(householdId, clock.isoWeek, clock.weekday)
        .all<{ nom: string | null }>()
      const noms = results.flatMap((r) => (r.nom ? [r.nom] : []))
      return {
        title: 'Ce soir',
        body: noms.length > 0 ? noms.join(', ') : 'Rien de prévu ce soir. Un repas à planifier ?',
        url: `/planning/${clock.weekday}?semaine=${clock.isoWeek}`,
        tag: 'repas_soir',
      }
    }

    case 'planifier_semaine': {
      const suivante = nextIsoWeek(clock.isoWeek)
      const ligne = await db
        .prepare('SELECT COUNT(*) AS n FROM meal_plan_entry WHERE household_id = ? AND iso_week = ?')
        .bind(householdId, suivante)
        .first<{ n: number }>()
      if ((ligne?.n ?? 0) > 0) return null
      return {
        title: 'La semaine prochaine',
        body: 'Rien n’est encore prévu. Un moment pour planifier les repas ?',
        url: `/planning?semaine=${suivante}`,
        tag: 'planifier_semaine',
      }
    }

    case 'pesee': {
      const deja = await db
        .prepare('SELECT 1 AS oui FROM weight_log WHERE user_id = ? AND day = ?')
        .bind(userId, clock.day)
        .first<{ oui: number }>()
      if (deja !== null) return null
      return { title: 'Pesée', body: 'Pense à te peser ce matin.', url: '/objectifs', tag: 'pesee' }
    }

    // Etape 2 : ces types se reglent deja mais ne partent pas encore
    // (`disponible: false`), `planifier` ne les atteint donc pas.
    case 'peremption':
    case 'seuil':
    case 'hydratation':
    case 'bilan_semaine':
      return null
  }
}
