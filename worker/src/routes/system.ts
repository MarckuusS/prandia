/** Diagnostic et journal d'activite. */

import { listActivity } from '../activity.js'
import { json, route } from '../http.js'
import { NO_HOUSEHOLD } from '../repos/index.js'
import { derniereSauvegarde } from '../sauvegarde.js'

export const VERSION = '0.3.0'

route('GET', '/api/health', async ({ repos, env }) => {
  // On interroge reellement la base : un Worker qui repond alors que D1 est
  // injoignable donnerait un diagnostic faussement rassurant.
  let reachable = false
  let ingredients: number | null = null
  try {
    ingredients = await repos.ingredients.count()
    reachable = true
  } catch {
    reachable = false
  }

  // Une sauvegarde qui s'arrete en silence est le defaut classique : l'onglet
  // Profil montre la date de la derniere reussie (voir sauvegarde.ts).
  const sauvegarde = reachable ? await derniereSauvegarde(env.DB).catch(() => null) : null

  return json({
    status: 'ok',
    version: VERSION,
    environment: env.ENVIRONMENT,
    database: { reachable, ingredients },
    sauvegarde: sauvegarde === null ? null : { jour: sauvegarde.jour, octets: sauvegarde.octets, faiteLe: sauvegarde.faiteLe },
    time: new Date().toISOString(),
  })
})

// Le journal ne passe pas par un repository : le foyer lui est donne ici, et
// il vient de la session — comme celui que `index.ts` remet aux repositories.
route('GET', '/api/activity', async ({ env, url, user }) =>
  json({
    items: await listActivity(
      env.DB,
      user?.householdId ?? NO_HOUSEHOLD,
      Number(url.searchParams.get('limit') ?? 50),
    ),
  }),
)
