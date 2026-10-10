/**
 * Remonter l'horloge des notifications.
 *
 * L'horloge est un Durable Object (`Horloge`, dans notifier.ts) dont l'alarme
 * sonne toutes les cinq minutes et se re-arme elle-meme. Mais une alarme qui
 * n'a jamais ete posee ne sonne jamais, et une chaine peut se rompre (alarme
 * abandonnee apres des echecs repetes, Worker redeploye sans etat). D'ou cet
 * appel, place sur les routes de l'ecran Notifications : l'horloge se pose au
 * premier usage et se repose d'elle-meme a la visite suivante si elle s'est
 * arretee. Il est idempotent : il ne pose l'alarme que si aucune n'attend.
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types'

/** Une seule horloge pour toute l'application, donc un seul nom. */
const NOM = 'horloge'

export async function remonterHorloge(horloge: DurableObjectNamespace | undefined): Promise<void> {
  if (horloge === undefined) return
  const reponse = await horloge.get(horloge.idFromName(NOM)).fetch('https://horloge/remonter', { method: 'POST' })
  // Lire le corps libere la connexion ; sans cela le runtime signale une
  // reponse laissee en suspens.
  await reponse.text()
  if (!reponse.ok) throw new Error(`horloge : ${reponse.status}`)
}
