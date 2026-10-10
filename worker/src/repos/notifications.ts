/**
 * Abonnements et preferences de notification d'UNE personne.
 *
 * Cloisonne par personne comme `ProfileRepo` et `WeightRepo` : l'identifiant
 * vient du cookie signe, jamais d'un parametre. Voir migrations/0018.
 */

import type { D1Database } from '@cloudflare/workers-types'
import { isNotificationKind, parseTimes, type NotificationKind } from '@prandia/shared'

import type { PushTarget } from '../push.js'

export interface NotificationPrefRow {
  readonly kind: NotificationKind
  readonly enabled: boolean
  readonly times: string[]
}

/** Abonnement tenu en base : la cible d'envoi et son identifiant. */
export interface StoredSubscription extends PushTarget {
  readonly id: number
}

export class NotificationRepo {
  constructor(
    private readonly db: D1Database,
    private readonly userId: number,
  ) {}

  /** Les preferences enregistrees. Un type absent n'est pas renvoye : il est desactive. */
  async prefs(): Promise<Map<NotificationKind, NotificationPrefRow>> {
    const { results } = await this.db
      .prepare('SELECT kind, enabled, times FROM notification_pref WHERE user_id = ?')
      .bind(this.userId)
      .all<{ kind: string; enabled: number; times: string | null }>()
    const prefs = new Map<NotificationKind, NotificationPrefRow>()
    for (const row of results) {
      if (!isNotificationKind(row.kind)) continue
      prefs.set(row.kind, { kind: row.kind, enabled: row.enabled === 1, times: parseTimes(row.times, row.kind) })
    }
    return prefs
  }

  async setPref(kind: NotificationKind, enabled: boolean, times: readonly string[] | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO notification_pref (user_id, kind, enabled, times) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, kind) DO UPDATE SET enabled = excluded.enabled, times = excluded.times`,
      )
      .bind(this.userId, kind, enabled ? 1 : 0, times === null ? null : times.join(','))
      .run()
  }

  /**
   * Enregistre l'appareil pour cette personne. L'adresse est unique : un
   * telephone deja abonne sous un autre compte CHANGE de proprietaire, il ne
   * recoit pas les rappels des deux. Les echecs passes s'effacent.
   */
  async saveSubscription(target: PushTarget): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO push_subscription (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failure_count = 0`,
      )
      .bind(this.userId, target.endpoint, target.p256dh, target.auth)
      .run()
  }

  /** Retire un appareil, seulement s'il appartient a cette personne. */
  async removeSubscription(endpoint: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM push_subscription WHERE endpoint = ? AND user_id = ?')
      .bind(endpoint, this.userId)
      .run()
  }

  async subscriptions(): Promise<StoredSubscription[]> {
    const { results } = await this.db
      .prepare('SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = ? ORDER BY id')
      .bind(this.userId)
      .all<StoredSubscription>()
    return results
  }
}

/**
 * Suites d'un envoi, communes a la route de test et a la planification : un
 * abonnement perime se supprime, un echec se compte, un succes se date.
 */
export async function recordDelivery(
  db: D1Database,
  subscriptionId: number,
  result: 'envoye' | 'perime' | 'echec',
): Promise<void> {
  if (result === 'perime') {
    await db.prepare('DELETE FROM push_subscription WHERE id = ?').bind(subscriptionId).run()
  } else if (result === 'echec') {
    await db.prepare('UPDATE push_subscription SET failure_count = failure_count + 1 WHERE id = ?').bind(subscriptionId).run()
  } else {
    await db
      .prepare(
        `UPDATE push_subscription SET failure_count = 0, last_sent_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
      )
      .bind(subscriptionId)
      .run()
  }
}
