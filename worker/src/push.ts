/**
 * Envoyer une notification a un appareil : Web Push, chiffre et signe.
 *
 * Partage par la route de test (Pages) et par la planification (le Worker
 * `notifier`). Le contenu est chiffre pour l'appareil seul (RFC 8291) : le
 * service du fabricant, chez Apple ou Google, transporte sans lire. La
 * signature VAPID (RFC 8292) prouve que l'envoi vient bien de Prandia.
 *
 * LA CLE PRIVEE EST UN SECRET (`VAPID_PRIVATE_KEY`), pose par
 * `wrangler secret put`, jamais dans le depot qui est public. La cle publique,
 * elle, est dans `wrangler.toml` : l'appareil en a besoin pour s'abonner.
 */

import { buildPushPayload, type VapidKeys } from '@block65/webcrypto-web-push'

export interface PushTarget {
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}

/** Ce que lit `push-sw.js` pour afficher la notification. */
export interface PushContent {
  readonly title: string
  readonly body: string
  /** Ecran a ouvrir au toucher. */
  readonly url: string
  /** Une notification du meme `tag` remplace la precedente au lieu de s'empiler. */
  readonly tag: string
}

/** `perime` : l'appareil s'est desabonne ou a reinstalle l'application. */
export type PushResult = 'envoye' | 'perime' | 'echec'

export interface VapidEnv {
  readonly VAPID_PUBLIC_KEY?: string | undefined
  readonly VAPID_PRIVATE_KEY?: string | undefined
  readonly VAPID_SUBJECT?: string | undefined
}

/** Les cles d'envoi, ou `null` quand le secret manque : rien ne part alors. */
export function vapidFrom(env: VapidEnv): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null
  return { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
}

/**
 * Quatre heures de validite : un rappel de pesee recu le soir, apres une
 * journee telephone eteint, ne sert plus a rien. Le service le jette.
 */
const TTL_S = 4 * 60 * 60

export async function sendPush(target: PushTarget, content: PushContent, vapid: VapidKeys): Promise<PushResult> {
  const payload = await buildPushPayload(
    { data: { ...content }, options: { ttl: TTL_S, urgency: 'normal' } },
    { endpoint: target.endpoint, expirationTime: null, keys: { p256dh: target.p256dh, auth: target.auth } },
    vapid,
  )
  // Les en-tetes optionnels (`topic`, `urgency`) peuvent valoir `undefined` :
  // passes tels quels, `fetch` enverrait le texte "undefined". On les retire.
  const headers = new Headers()
  for (const [name, value] of Object.entries(payload.headers)) {
    if (value !== undefined) headers.set(name, value)
  }
  const response = await fetch(target.endpoint, { method: payload.method, headers, body: payload.body })
  // 404 et 410 : l'abonnement n'existe plus chez le fabricant. Tout autre echec
  // peut etre passager (service indisponible, quota) et se retente au prochain
  // rappel.
  if (response.status === 404 || response.status === 410) return 'perime'
  return response.ok ? 'envoye' : 'echec'
}
