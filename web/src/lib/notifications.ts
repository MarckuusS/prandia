/**
 * Notifications cote navigateur : l'etat de CET appareil, l'abonner, le
 * desabonner, et les preferences de la personne.
 *
 * DEUX CHOSES DIFFERENTES, et l'ecran les separe :
 *   - les PREFERENCES (quels types, a quelle heure) appartiennent a la
 *     personne et valent pour tous ses appareils ;
 *   - l'ABONNEMENT appartient a l'appareil : un iPhone et un ordinateur
 *     s'abonnent chacun, et le meme compte recoit sur les deux.
 *
 * SUR iPHONE, SEULE L'APPLICATION INSTALLEE PEUT S'ABONNER. Dans un onglet de
 * Safari, `PushManager` n'existe pas : l'ecran le dit et explique l'ajout a
 * l'ecran d'accueil, plutot que d'afficher un bouton qui ne ferait rien.
 * L'autorisation se demande apres un TOUCHER, jamais au chargement : iOS
 * refuse sinon.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NotificationKind } from '@prandia/shared'

import { apiFetch } from './api.js'

export interface NotificationPref {
  readonly kind: NotificationKind
  readonly enabled: boolean
  readonly times: string[]
}

export interface NotificationSettings {
  /** `null` : le serveur n'a pas encore ses cles, rien ne peut partir. */
  readonly publicKey: string | null
  /** Appareils abonnes pour cette personne. */
  readonly devices: number
  readonly prefs: NotificationPref[]
}

const CLE = ['notifications'] as const

export function useNotificationSettings() {
  return useQuery({ queryKey: CLE, queryFn: () => apiFetch<NotificationSettings>('/api/notifications') })
}

export function useSetNotificationPref() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ kind, enabled, times }: NotificationPref) =>
      apiFetch<NotificationPref>(`/api/notifications/preferences/${kind}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, times }),
      }),
    // Mise a jour immediate de la case : l'ecran enregistre au fil des gestes,
    // il ne doit pas rester une demi-seconde sur l'ancienne valeur.
    onMutate: (pref) => {
      client.setQueryData<NotificationSettings>(CLE, (avant) =>
        avant === undefined
          ? avant
          : { ...avant, prefs: avant.prefs.map((p) => (p.kind === pref.kind ? pref : p)) },
      )
    },
    onSettled: () => void client.invalidateQueries({ queryKey: CLE }),
  })
}

export function useTestNotification() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ envoye: number; perime: number; echec: number }>('/api/notifications/test', { method: 'POST' }),
  })
}

// ---------------------------------------------------------------------------
// L'appareil
// ---------------------------------------------------------------------------

export type EtatAppareil =
  /** Ce navigateur ne sait pas recevoir de notification. */
  | 'indisponible'
  /** iPhone, dans un onglet de Safari : il faut l'application installee. */
  | 'onglet-iphone'
  /** Refuse dans les reglages du telephone : le site ne peut pas redemander. */
  | 'refuse'
  | 'a-activer'
  | 'actif'

const estIphone = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent)

const estInstallee = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

export async function etatAppareil(): Promise<EtatAppareil> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return estIphone() && !estInstallee() ? 'onglet-iphone' : 'indisponible'
  }
  if (Notification.permission === 'denied') return 'refuse'
  const registration = await navigator.serviceWorker.ready
  const abonnement = await registration.pushManager.getSubscription()
  return abonnement === null ? 'a-activer' : 'actif'
}

/** La cle publique en base64url vers les octets qu'attend `subscribe`. */
function octets(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  const texte = atob(base64)
  const tampon = new ArrayBuffer(texte.length)
  const vue = new Uint8Array(tampon)
  for (let i = 0; i < texte.length; i++) vue[i] = texte.charCodeAt(i)
  return tampon
}

/** A appeler depuis un TOUCHER : iOS ne demande l'autorisation qu'a ce prix. */
export async function activerAppareil(publicKey: string): Promise<EtatAppareil> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission === 'denied' ? 'refuse' : 'a-activer'

  const registration = await navigator.serviceWorker.ready
  const abonnement =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: octets(publicKey) }))

  await apiFetch('/api/notifications/abonnement', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(abonnement.toJSON()),
  })
  return 'actif'
}

export async function desactiverAppareil(): Promise<EtatAppareil> {
  const registration = await navigator.serviceWorker.ready
  const abonnement = await registration.pushManager.getSubscription()
  if (abonnement !== null) {
    // Le serveur d'abord : si l'appel echoue, l'appareil reste abonne et
    // l'ecran le montre, au lieu d'un serveur qui enverrait dans le vide.
    await apiFetch('/api/notifications/abonnement', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: abonnement.endpoint }),
    })
    await abonnement.unsubscribe()
  }
  return 'a-activer'
}
