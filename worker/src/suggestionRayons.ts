/**
 * Savarin propose des rayons (shared/src/suggestionRayons.ts), et s'en
 * SOUVIENT : l'ecran des rayons s'ouvre souvent, la bibliotheque change
 * lentement. Une question a chaque ouverture couterait des appels a Claude
 * et la lecture de toute la bibliotheque pour redire la meme chose.
 *
 * Il ne reinterroge que si les rayons ont change ou si la bibliotheque a
 * gagne ou perdu `ECART_BIBLIOTHEQUE` produits, et jamais deux fois le meme
 * jour. Entre-temps, l'ecran relit la memoire (`app_setting`), et seuls les
 * produits encore proposes sont relus, par leur cle.
 */

import {
  SUGGESTION_BIBLIOTHEQUE_MAX,
  SUGGESTION_BIBLIOTHEQUE_MIN,
  SUGGESTION_PRODUITS_MIN,
  SUGGESTION_RAYONS_TOOL,
  interpretSuggestionRayons,
  parisClock,
  rayonDejaCouvert,
  suggestionRayonsQuestion,
  type RayonPropose,
} from '@prandia/shared'

import { cleClaude, compterAppel, demanderOutil } from './anthropic.js'
import type { Env } from './http.js'
import type { Repositories } from './repos/index.js'

export const CLE_SUGGESTIONS = 'rayons.suggestions'
export const CLE_REFUS = 'rayons.suggestions.refus'
/** Dix produits de plus ou de moins : la bibliotheque a assez change pour qu'une autre idee apparaisse. */
export const ECART_BIBLIOTHEQUE = 10
/** Un refus se retient, mais la liste ne grandit pas sans fin. */
const REFUS_MAX = 30

interface Memoire {
  /** Les rayons au moment de la question, un par ligne. */
  readonly rayons: string
  readonly nombre: number
  readonly jour: string
  readonly propositions: readonly RayonPropose[]
}

export interface PropositionAffichee {
  readonly nom: string
  readonly raison: string
  readonly produits: ReadonlyArray<{ readonly id: number; readonly nom: string; readonly rayon: string | null }>
}

/** Ce que l'ecran affiche : les propositions encore valables, produits relus. */
export async function suggestionsDeRayons(
  env: Env,
  repos: Repositories,
  maintenant = new Date(),
): Promise<{ disponible: boolean; propositions: PropositionAffichee[] }> {
  const disponible = Boolean(env.ANTHROPIC_API_KEY)
  if (!disponible) return { disponible, propositions: [] }

  const rayons = await repos.rayons.noms()
  const refus = await repos.settings.getJson<string[]>(CLE_REFUS, [])
  const memoire = await repos.settings.getJson<Memoire | null>(CLE_SUGGESTIONS, null)
  const nombre = await repos.ingredients.countBibliotheque()
  const jour = parisClock(maintenant).day
  const empreinte = rayons.join('\n')

  let propositions = memoire?.propositions ?? []
  const aJour =
    memoire !== null && memoire.rayons === empreinte && Math.abs(memoire.nombre - nombre) < ECART_BIBLIOTHEQUE
  if (!aJour && memoire?.jour !== jour && nombre >= SUGGESTION_BIBLIOTHEQUE_MIN) {
    try {
      const bibliotheque = await repos.ingredients.bibliothequeRangee(SUGGESTION_BIBLIOTHEQUE_MAX)
      const cle = cleClaude(env)
      await compterAppel(repos)
      const sortie = await demanderOutil(
        cle,
        [{ type: 'text', text: suggestionRayonsQuestion(rayons, bibliotheque, refus) }],
        SUGGESTION_RAYONS_TOOL,
        1500,
      )
      propositions = interpretSuggestionRayons(sortie, rayons, refus, new Set(bibliotheque.map((p) => p.id)))
      await repos.settings.setJson(CLE_SUGGESTIONS, { rayons: empreinte, nombre, jour, propositions } satisfies Memoire)
    } catch (erreur) {
      // Une bulle en plus, jamais une erreur a l'ecran. Le jour est retenu
      // quand meme : un quota atteint ne doit pas faire reessayer a chaque
      // ouverture.
      console.warn('suggestion de rayons abandonnee :', erreur instanceof Error ? erreur.message : erreur)
      await repos.settings.setJson(CLE_SUGGESTIONS, {
        rayons: memoire?.rayons ?? '',
        nombre: memoire?.nombre ?? -ECART_BIBLIOTHEQUE,
        jour,
        propositions,
      } satisfies Memoire)
    }
  }

  // Un rayon cree a la main depuis la question peut deja couvrir une idee.
  const encore = propositions.filter(
    (p) => !rayons.some((r) => rayonDejaCouvert(p.nom, r)) && !refus.some((r) => rayonDejaCouvert(p.nom, r)),
  )
  const fiches = await repos.ingredients.byIds(encore.flatMap((p) => p.produits))
  return {
    disponible,
    propositions: encore
      .map((p) => ({
        nom: p.nom,
        raison: p.raison,
        // Un produit retire de la bibliotheque, ou deja range la entre-temps, ne compte plus.
        produits: p.produits.flatMap((id) => {
          const fiche = fiches.get(id)
          return fiche === undefined || !fiche.inLibrary || fiche.categoryL1 === p.nom
            ? []
            : [{ id, nom: fiche.name, rayon: fiche.categoryL1 || null }]
        }),
      }))
      .filter((p) => p.produits.length >= SUGGESTION_PRODUITS_MIN),
  }
}

/** Retire une proposition de la memoire, et y note les rayons du moment s'ils viennent de changer. */
async function oublier(repos: Repositories, nom: string, rayonsChanges: boolean): Promise<void> {
  const memoire = await repos.settings.getJson<Memoire | null>(CLE_SUGGESTIONS, null)
  if (memoire === null) return
  await repos.settings.setJson(CLE_SUGGESTIONS, {
    ...memoire,
    // Creer le rayon propose change les rayons, sans que la bibliotheque ait
    // rien appris de neuf : les autres idees restent valables.
    rayons: rayonsChanges ? (await repos.rayons.noms()).join('\n') : memoire.rayons,
    propositions: memoire.propositions.filter((p) => p.nom !== nom),
  } satisfies Memoire)
}

/** "Non merci" : la proposition part, et le nom ne sera plus propose. */
export async function refuserRayon(repos: Repositories, nom: string): Promise<void> {
  const refus = await repos.settings.getJson<string[]>(CLE_REFUS, [])
  if (!refus.includes(nom)) await repos.settings.setJson(CLE_REFUS, [nom, ...refus].slice(0, REFUS_MAX))
  await oublier(repos, nom, false)
}

/** Le rayon cree a partir d'une proposition : elle part de la memoire. */
export async function rayonCree(repos: Repositories, proposition: string): Promise<void> {
  await oublier(repos, proposition, true)
}
