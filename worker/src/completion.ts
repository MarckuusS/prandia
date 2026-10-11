/**
 * Completer des fiches par l'IA : rayon, poids cuit, mois de saison
 * (shared/src/completion.ts).
 *
 * Trois usages :
 *   - en ARRIERE-PLAN, a la creation d'une fiche (ajout manuel, produit
 *     OpenFoodFacts, article du chariot) : la creation repond tout de suite,
 *     les champs arrivent une seconde apres. Une erreur ici ne doit JAMAIS
 *     faire echouer la creation : au pire, la fiche reste comme avant ;
 *   - a la DEMANDE, pour la bibliotheque deja la (`POST /api/completion`, par
 *     lots de `COMPLETION_MAX`) ;
 *   - en PROPOSITION pour la fiche ouverte (`POST /api/completion/proposition`) :
 *     rien n'est ecrit, l'ecran remplit ses champs vides et la personne
 *     enregistre, ou non.
 *
 * Ce qui s'ecrit ne remplit que les champs vides (`IngredientRepo.completer`)
 * et se corrige dans la fiche comme n'importe quelle saisie.
 */

import {
  COMPLETION_MAX,
  completionQuestion,
  completionTool,
  interpretCompletion,
  moisCsv,
  type Completion,
  type OptionsCompletion,
  type ProduitACompleter,
} from '@prandia/shared'

import { cleClaude, compterAppel, demanderOutil } from './anthropic.js'
import type { Env } from './http.js'
import type { Repositories } from './repos/index.js'

/**
 * Une question pour au plus `COMPLETION_MAX` produits, rien d'ecrit.
 * `relue` : seulement quand la personne relira (fiche ouverte).
 */
export async function demanderCompletion(
  env: Env,
  repos: Repositories,
  produits: readonly ProduitACompleter[],
  options: OptionsCompletion = {},
): Promise<Map<number, Completion>> {
  if (produits.length === 0) return new Map()
  const rayons = (await repos.rayons.list()).map((r) => r.name)
  const cle = cleClaude(env)
  await compterAppel(repos)
  const lot = produits.slice(0, COMPLETION_MAX)
  const sortie = await demanderOutil(
    cle,
    [{ type: 'text', text: completionQuestion(rayons, lot, options) }],
    completionTool(rayons, options),
    4000,
  )
  return interpretCompletion(
    sortie,
    rayons,
    lot.map((p) => p.id),
  )
}

/**
 * Demande, puis ecrit dans les champs vides et marque chaque fiche a laquelle
 * le modele a repondu. Rend ce qu'il a propose, pour que l'appelant compte.
 */
export async function completerProduits(
  env: Env,
  repos: Repositories,
  produits: readonly ProduitACompleter[],
): Promise<Map<number, Completion>> {
  const completions = await demanderCompletion(env, repos, produits)
  for (const [id, c] of completions) {
    await repos.ingredients.completer(id, { rayon: c.rayon, poidsCuitG: c.poidsCuitG, saison: moisCsv(c.moisSaison) })
  }
  return completions
}

/**
 * La meme completion, apres la reponse. Sans `waitUntil` (tests), la promesse
 * est rendue pour que l'appelant l'attende ; sans cle, rien ne part.
 */
export function completerEnArrierePlan(
  ctx: { readonly env: Env; readonly repos: Repositories; readonly waitUntil?: ((p: Promise<unknown>) => void) | undefined },
  produits: readonly ProduitACompleter[],
): Promise<void> | undefined {
  if (produits.length === 0 || !ctx.env.ANTHROPIC_API_KEY) return undefined
  const travail = completerProduits(ctx.env, ctx.repos, produits).then(
    () => undefined,
    (erreur: unknown) => {
      console.warn('completion automatique abandonnee :', erreur instanceof Error ? erreur.message : erreur)
    },
  )
  if (ctx.waitUntil === undefined) return travail
  ctx.waitUntil(travail)
  return undefined
}
