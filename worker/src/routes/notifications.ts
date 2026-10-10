/**
 * Notifications : regler ce qu'on recoit, abonner un appareil, essayer.
 *
 * L'ENVOI PLANIFIE N'EST PAS ICI. Pages ne sait pas declencher une action a
 * heure fixe : c'est l'horloge du Worker `notifier` (worker/src/notifier.ts)
 * qui passe toutes les cinq minutes. Ces routes ne font que preparer ce
 * qu'elle lira, envoyer une notification de test a la demande, et REMONTER
 * l'horloge a chaque visite de l'ecran et a chaque reglage : une alarme
 * jamais posee ne sonne jamais.
 */

import { z } from 'zod'
import {
  NOTIFICATION_DEFS,
  isNotificationKind,
  notificationPrefWriteSchema,
  parseTimes,
} from '@prandia/shared'

import { remonterHorloge } from '../horloge.js'
import { badRequest, HttpError, json, parseOrThrow, readJson, requireUser, route, type Env } from '../http.js'
import { sendPush, vapidFrom } from '../push.js'
import { NotificationRepo, recordDelivery } from '../repos/notifications.js'

/** Ce que `PushManager.subscribe()` rend, serialise par `toJSON()`. */
const abonnementSchema = z.object({
  endpoint: z
    .string()
    .url()
    // Un service de notification est toujours en https : refuser le reste
    // empeche de faire envoyer des requetes signees vers une adresse quelconque.
    .refine((value) => value.startsWith('https://'), 'Adresse de notification invalide.'),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(100),
  }),
})

const desabonnementSchema = z.object({ endpoint: z.string().url() })

/**
 * Au mieux : l'ecran doit marcher meme quand l'horloge ne repond pas (en
 * local, tant que le Worker `notifier` ne tourne pas). L'echec se journalise,
 * il ne remonte pas jusqu'a la personne, qui n'y peut rien.
 */
const remonter = (env: Env): Promise<void> =>
  remonterHorloge(env.HORLOGE).catch((error: unknown) => console.error('horloge injoignable', error))

route('GET', '/api/notifications', async ({ env, user }) => {
  const me = requireUser(user)
  const repo = new NotificationRepo(env.DB, me.id)
  const [prefs, appareils] = await Promise.all([repo.prefs(), repo.subscriptions(), remonter(env)])
  return json({
    // `null` tant que les cles ne sont pas posees : l'ecran dit alors que les
    // notifications ne sont pas encore disponibles, au lieu d'echouer a l'abonnement.
    publicKey: vapidFrom(env) === null ? null : (env.VAPID_PUBLIC_KEY ?? null),
    devices: appareils.length,
    prefs: NOTIFICATION_DEFS.map((def) => {
      const pref = prefs.get(def.kind)
      return { kind: def.kind, enabled: pref?.enabled ?? false, times: pref?.times ?? parseTimes(null, def.kind) }
    }),
  })
})

route('PUT', '/api/notifications/preferences/:kind', async ({ env, user, params, request }) => {
  const me = requireUser(user)
  const kind = params['kind'] ?? ''
  if (!isNotificationKind(kind)) throw badRequest('Type de notification inconnu.')
  const body = parseOrThrow(notificationPrefWriteSchema, await readJson(request))
  // Les heures repassent par `parseTimes` : triees, sans doublon.
  const times = body.times === null ? null : parseTimes(body.times.join(','), kind)
  await new NotificationRepo(env.DB, me.id).setPref(kind, body.enabled, times)
  await remonter(env)
  return json({ kind, enabled: body.enabled, times: times ?? parseTimes(null, kind) })
})

route('POST', '/api/notifications/abonnement', async ({ env, user, request }) => {
  const me = requireUser(user)
  const body = parseOrThrow(abonnementSchema, await readJson(request))
  await new NotificationRepo(env.DB, me.id).saveSubscription({
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
  })
  await remonter(env)
  return json({ ok: true })
})

route('DELETE', '/api/notifications/abonnement', async ({ env, user, request }) => {
  const me = requireUser(user)
  const body = parseOrThrow(desabonnementSchema, await readJson(request))
  await new NotificationRepo(env.DB, me.id).removeSubscription(body.endpoint)
  return json({ ok: true })
})

route('POST', '/api/notifications/test', async ({ env, user }) => {
  const me = requireUser(user)
  const vapid = vapidFrom(env)
  if (vapid === null) throw new HttpError(503, 'push_unconfigured', 'Les notifications ne sont pas encore configurées sur le serveur.')

  const repo = new NotificationRepo(env.DB, me.id)
  const appareils = await repo.subscriptions()
  if (appareils.length === 0) throw badRequest('Aucun appareil abonné pour l’instant.', 'no_device')

  const bilan = { envoye: 0, perime: 0, echec: 0 }
  for (const appareil of appareils) {
    const resultat = await sendPush(
      appareil,
      { title: 'Prandia', body: 'Les notifications fonctionnent sur cet appareil.', url: '/parametres/notifications', tag: 'test' },
      vapid,
    ).catch(() => 'echec' as const)
    bilan[resultat] += 1
    await recordDelivery(env.DB, appareil.id, resultat)
  }
  return json(bilan)
})
