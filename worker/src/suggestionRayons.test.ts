/**
 * Les rayons proposes par Savarin, cote serveur, avec un faux Claude.
 *
 * Ce qui compte : Claude n'est interroge que quand la cuisine a change, et
 * jamais deux fois le meme jour ; un refus ne revient pas ; un rayon cree
 * part de la memoire sans faire reinterroger ; une panne ne montre rien.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Env } from './http.js'
import type { Repositories } from './repos/index.js'
import { CLE_REFUS, rayonCree, refuserRayon, suggestionsDeRayons } from './suggestionRayons.js'

const BIBLIOTHEQUE = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  nom: i < 6 ? `Conserve ${i + 1}` : `Produit ${i + 1}`,
  rayon: 'Epicerie' as string | null,
}))

function cuisine(rayonsInitiaux = ['Epicerie', 'Frais']) {
  const reglages = new Map<string, unknown>()
  const etat = { rayons: [...rayonsInitiaux], bibliotheque: [...BIBLIOTHEQUE] }
  const repos = {
    rayons: { noms: async () => [...etat.rayons] },
    settings: {
      getJson: async (cle: string, defaut: unknown) => reglages.get(cle) ?? defaut,
      setJson: async (cle: string, valeur: unknown) => void reglages.set(cle, valeur),
    },
    ingredients: {
      countBibliotheque: async () => etat.bibliotheque.length,
      bibliothequeRangee: async () => etat.bibliotheque,
      byIds: async (ids: Iterable<number>) =>
        new Map(
          [...ids].flatMap((id) => {
            const p = etat.bibliotheque.find((x) => x.id === id)
            return p ? [[id, { id, name: p.nom, inLibrary: true, categoryL1: p.rayon }]] : []
          }),
        ),
    },
  } as unknown as Repositories
  return { repos, etat, reglages }
}

const env = { ANTHROPIC_API_KEY: 'cle-de-test' } as unknown as Env
const LUNDI = new Date('2026-10-12T10:00:00Z')
const MARDI = new Date('2026-10-13T10:00:00Z')

/** Claude repond par l'outil, avec ces propositions. */
function claudePropose(propositions: unknown) {
  const appels: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      appels.push((JSON.parse(init.body) as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0]!.content[0]!.text)
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { propositions } }] }), { status: 200 })
    }),
  )
  return appels
}

const CONSERVES = { nom: 'Conserves', raison: '6 de tes produits d’Epicerie sont des conserves.', produits: [1, 2, 3, 4, 5, 6] }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('suggestionsDeRayons', () => {
  it('interroge une fois, puis relit sa memoire le meme jour', async () => {
    const { repos } = cuisine()
    const appels = claudePropose([CONSERVES])

    const premier = await suggestionsDeRayons(env, repos, LUNDI)
    expect(appels).toHaveLength(1)
    expect(appels[0]).toContain('## Epicerie (30)')
    expect(premier.propositions).toEqual([
      {
        nom: 'Conserves',
        raison: CONSERVES.raison,
        produits: [1, 2, 3, 4, 5, 6].map((id) => ({ id, nom: `Conserve ${id}`, rayon: 'Epicerie' })),
      },
    ])

    await suggestionsDeRayons(env, repos, LUNDI)
    await suggestionsDeRayons(env, repos, MARDI)
    expect(appels).toHaveLength(1)
  })

  it('reinterroge un autre jour quand la bibliotheque a change de dix produits', async () => {
    const { repos, etat } = cuisine()
    const appels = claudePropose([])
    await suggestionsDeRayons(env, repos, LUNDI)
    etat.bibliotheque.push(...Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, nom: `Neuf ${i}`, rayon: null })))
    await suggestionsDeRayons(env, repos, LUNDI)
    expect(appels).toHaveLength(1)
    await suggestionsDeRayons(env, repos, MARDI)
    expect(appels).toHaveLength(2)
  })

  it('ne propose rien sous vingt produits, sans interroger', async () => {
    const { repos, etat } = cuisine()
    etat.bibliotheque.splice(19)
    const appels = claudePropose([CONSERVES])
    expect((await suggestionsDeRayons(env, repos, LUNDI)).propositions).toEqual([])
    expect(appels).toHaveLength(0)
  })

  it('sans cle, rien ne part', async () => {
    const { repos } = cuisine()
    const appels = claudePropose([CONSERVES])
    expect(await suggestionsDeRayons({} as Env, repos, LUNDI)).toEqual({ disponible: false, propositions: [] })
    expect(appels).toHaveLength(0)
  })

  it('une panne ne montre rien et ne fait pas reessayer le meme jour', async () => {
    const { repos } = cuisine()
    const panne = vi.fn(async () => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', panne)
    expect((await suggestionsDeRayons(env, repos, LUNDI)).propositions).toEqual([])
    await suggestionsDeRayons(env, repos, LUNDI)
    expect(panne).toHaveBeenCalledTimes(1)
  })

  it('un rayon cree a la main qui couvre l’idee la fait disparaitre, sans reinterroger le meme jour', async () => {
    const { repos, etat } = cuisine()
    const appels = claudePropose([CONSERVES])
    await suggestionsDeRayons(env, repos, LUNDI)
    etat.rayons.push('Les conserves')
    expect((await suggestionsDeRayons(env, repos, LUNDI)).propositions).toEqual([])
    expect(appels).toHaveLength(1)
  })

  it('un produit range la entre-temps ne compte plus, et sous quatre la proposition part', async () => {
    const { repos, etat } = cuisine()
    claudePropose([CONSERVES])
    await suggestionsDeRayons(env, repos, LUNDI)
    for (const p of etat.bibliotheque.slice(0, 3)) p.rayon = 'Conserves'
    expect((await suggestionsDeRayons(env, repos, LUNDI)).propositions).toEqual([])
  })
})

describe('refuser et creer', () => {
  it('un refus retire l’idee, la retient, et la dit au modele la fois suivante', async () => {
    const { repos, reglages, etat } = cuisine()
    const appels = claudePropose([CONSERVES])
    await suggestionsDeRayons(env, repos, LUNDI)
    await refuserRayon(repos, 'Conserves')
    expect(reglages.get(CLE_REFUS)).toEqual(['Conserves'])
    expect((await suggestionsDeRayons(env, repos, LUNDI)).propositions).toEqual([])

    etat.rayons.push('Boissons')
    await suggestionsDeRayons(env, repos, MARDI)
    expect(appels).toHaveLength(2)
    expect(appels[1]).toContain('deja refuses par la personne : Conserves')
  })

  it('un rayon cree depuis la proposition la retire, garde les autres, et ne fait pas reinterroger', async () => {
    const { repos, etat } = cuisine()
    const appels = claudePropose([CONSERVES, { nom: 'Pâtes et riz', raison: 'Des pâtes.', produits: [7, 8, 9, 10] }])
    await suggestionsDeRayons(env, repos, LUNDI)
    etat.rayons.push('Mes conserves')
    for (const p of etat.bibliotheque.slice(0, 6)) p.rayon = 'Mes conserves'
    await rayonCree(repos, 'Conserves')
    const apres = await suggestionsDeRayons(env, repos, MARDI)
    expect(apres.propositions.map((p) => p.nom)).toEqual(['Pâtes et riz'])
    expect(appels).toHaveLength(1)
  })
})
