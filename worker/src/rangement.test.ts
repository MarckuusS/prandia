/**
 * Le rangement par rayon, de bout en bout cote serveur, avec un faux Claude.
 *
 * Ce qui compte et ne se voit qu'a l'usage : le modele ne recoit QUE les
 * rayons de la cuisine, ce qu'il rend hors de la liste n'est jamais ecrit,
 * et un rangement en arriere-plan qui echoue ne fait pas echouer la creation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Env } from './http.js'
import { rangerEnArrierePlan, rangerProduits } from './rangement.js'
import type { Repositories } from './repos/index.js'

function fauxDepots(rayons: string[]) {
  const reglages = new Map<string, unknown>()
  const ecrits: Array<[number, unknown]> = []
  const repos = {
    rayons: { list: async () => rayons.map((name, i) => ({ id: i + 1, name })) },
    settings: {
      getJson: async (cle: string, defaut: unknown) => reglages.get(cle) ?? defaut,
      setJson: async (cle: string, valeur: unknown) => void reglages.set(cle, valeur),
    },
    ingredients: { update: async (id: number, patch: unknown) => void ecrits.push([id, patch]) },
  } as unknown as Repositories
  return { repos, ecrits }
}

const env = { ANTHROPIC_API_KEY: 'cle-de-test' } as unknown as Env

/** Claude repond par l'outil, avec le classement donne. */
function claudeRepond(classement: unknown) {
  const appels: Array<{ corps: Record<string, unknown> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      appels.push({ corps: JSON.parse(init.body) as Record<string, unknown> })
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { classement } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return appels
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('rangerProduits', () => {
  it('ecrit le rayon choisi, et seulement un rayon de la cuisine', async () => {
    const { repos, ecrits } = fauxDepots(['Epicerie', 'Produits laitiers & oeufs'])
    const appels = claudeRepond([
      { id: 7, rayon: 'Epicerie' },
      { id: 9, rayon: 'Conserves' },
    ])
    const ranges = await rangerProduits(env, repos, [
      { id: 7, nom: 'Thon à l’huile', marque: 'Nixe' },
      { id: 9, nom: 'Maïs doux', marque: null },
    ])
    expect(ranges).toBe(1)
    expect(ecrits).toEqual([[7, { categoryL1: 'Epicerie' }]])
    // L'outil impose la liste des rayons de la cuisine, et rien d'autre.
    const outil = (appels[0]?.corps['tools'] as Array<{ input_schema: unknown }>)[0]
    expect(JSON.stringify(outil)).toContain('Produits laitiers & oeufs')
    expect(appels[0]?.corps['model']).toBe('claude-haiku-5-5')
  })

  it('ne pose aucune question a une cuisine sans rayon', async () => {
    const { repos, ecrits } = fauxDepots([])
    const appels = claudeRepond([])
    expect(await rangerProduits(env, repos, [{ id: 1, nom: 'Riz', marque: null }])).toBe(0)
    expect(appels).toHaveLength(0)
    expect(ecrits).toHaveLength(0)
  })
})

describe('rangerEnArrierePlan', () => {
  it('avale une erreur : la creation ne doit jamais echouer pour un rayon', async () => {
    const { repos } = fauxDepots(['Epicerie'])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"overloaded"}}', { status: 529 })),
    )
    await expect(rangerEnArrierePlan({ env, repos }, [{ id: 1, nom: 'Riz', marque: null }])).resolves.toBeUndefined()
  })

  it('ne part pas sans cle', () => {
    const { repos } = fauxDepots(['Epicerie'])
    const sansCle = {} as unknown as Env
    expect(rangerEnArrierePlan({ env: sansCle, repos }, [{ id: 1, nom: 'Riz', marque: null }])).toBeUndefined()
  })

  it('confie le travail au runtime quand il le peut', () => {
    const { repos } = fauxDepots(['Epicerie'])
    claudeRepond([{ id: 1, rayon: 'Epicerie' }])
    const confies: Array<Promise<unknown>> = []
    const rendu = rangerEnArrierePlan({ env, repos, waitUntil: (p) => confies.push(p) }, [
      { id: 1, nom: 'Riz', marque: null },
    ])
    expect(rendu).toBeUndefined()
    expect(confies).toHaveLength(1)
  })
})
