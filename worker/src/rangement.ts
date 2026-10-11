/**
 * Ranger des produits dans les rayons de la cuisine (shared/src/rayonAuto.ts).
 *
 * Deux usages :
 *   - en ARRIERE-PLAN, a la creation d'une fiche sans rayon (ajout manuel,
 *     produit OpenFoodFacts, article du chariot) : la creation repond tout de
 *     suite, le rayon arrive une seconde apres. Une erreur ici ne doit JAMAIS
 *     faire echouer la creation : au pire, le produit reste sans rayon, comme
 *     avant ;
 *   - a la DEMANDE, pour les produits deja en bibliotheque sans rayon
 *     (`POST /api/rangement`, par lots de `RANGEMENT_MAX`).
 *
 * Le rayon choisi s'ecrit comme si la personne l'avait choisi : il se change
 * dans la fiche, comme n'importe quel rayon.
 */

import { RANGEMENT_MAX, interpretClassement, rayonQuestion, rayonTool, type ProduitARanger } from '@prandia/shared'

import { cleClaude, compterAppel, demanderOutil } from './anthropic.js'
import type { Env } from './http.js'
import type { Repositories } from './repos/index.js'

/** Range jusqu'a `RANGEMENT_MAX` produits ; rend le nombre de produits ranges. */
export async function rangerProduits(env: Env, repos: Repositories, produits: readonly ProduitARanger[]): Promise<number> {
  if (produits.length === 0) return 0
  // Une cuisine sans rayon n'a rien a proposer : on ne paie pas une question
  // dont la seule reponse possible est "aucun".
  const rayons = (await repos.rayons.list()).map((r) => r.name)
  if (rayons.length === 0) return 0
  const cle = cleClaude(env)
  await compterAppel(repos)
  const lot = produits.slice(0, RANGEMENT_MAX)
  const sortie = await demanderOutil(cle, [{ type: 'text', text: rayonQuestion(rayons, lot) }], rayonTool(rayons), 1500)
  const classement = interpretClassement(
    sortie,
    rayons,
    lot.map((p) => p.id),
  )
  for (const [id, rayon] of classement) await repos.ingredients.update(id, { categoryL1: rayon })
  return classement.size
}

/**
 * Le meme rangement, apres la reponse. Sans `waitUntil` (tests), la promesse
 * est rendue pour que l'appelant l'attende ; sans cle, rien ne part.
 */
export function rangerEnArrierePlan(
  ctx: { readonly env: Env; readonly repos: Repositories; readonly waitUntil?: ((p: Promise<unknown>) => void) | undefined },
  produits: readonly ProduitARanger[],
): Promise<void> | undefined {
  if (produits.length === 0 || !ctx.env.ANTHROPIC_API_KEY) return undefined
  const travail = rangerProduits(ctx.env, ctx.repos, produits).then(
    () => undefined,
    (erreur: unknown) => {
      console.warn('rangement automatique abandonne :', erreur instanceof Error ? erreur.message : erreur)
    },
  )
  if (ctx.waitUntil === undefined) return travail
  ctx.waitUntil(travail)
  return undefined
}
