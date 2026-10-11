/**
 * La completion des fiches, de bout en bout cote serveur, avec un faux Claude.
 *
 * Ce qui compte et ne se voit qu'a l'usage : le modele ne recoit QUE les
 * rayons de la cuisine, ce qu'il rend hors de la liste n'est jamais ecrit, une
 * cuisine sans rayon recoit quand meme poids cuit et saison, et une completion
 * en arriere-plan qui echoue ne fait pas echouer la creation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { completerEnArrierePlan, completerProduits, demanderCompletion } from './completion.js'
import type { Env } from './http.js'
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
    ingredients: { completer: async (id: number, valeurs: unknown) => void ecrits.push([id, valeurs]) },
  } as unknown as Repositories
  return { repos, ecrits }
}

const env = { ANTHROPIC_API_KEY: 'cle-de-test' } as unknown as Env

/** Claude repond par l'outil, avec les fiches donnees. */
function claudeRepond(fiches: unknown) {
  const appels: Array<{ corps: Record<string, unknown> }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      appels.push({ corps: JSON.parse(init.body) as Record<string, unknown> })
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { fiches } }] }), {
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

describe('completerProduits', () => {
  it('ecrit ce qui est sur, un rayon de la cuisine seulement, les mois en colonne', async () => {
    const { repos, ecrits } = fauxDepots(['Epicerie', 'Fruits et légumes'])
    const appels = claudeRepond([
      { id: 7, rayon: 'Epicerie', poids_cuit: 300, mois_saison: null },
      { id: 9, rayon: 'Conserves', poids_cuit: null, mois_saison: [6, 7, 8, 9] },
    ])
    const rendu = await completerProduits(env, repos, [
      { id: 7, nom: 'Riz basmati', marque: 'Taureau Ailé' },
      { id: 9, nom: 'Courgette', marque: null },
    ])
    expect(rendu.size).toBe(2)
    expect(ecrits).toEqual([
      [7, { rayon: 'Epicerie', poidsCuitG: 300, saison: null }],
      [9, { rayon: null, poidsCuitG: null, saison: '6,7,8,9' }],
    ])
    // L'outil impose la liste des rayons de la cuisine, et rien d'autre.
    const outil = (appels[0]?.corps['tools'] as Array<{ input_schema: unknown }>)[0]
    expect(JSON.stringify(outil)).toContain('Fruits et légumes')
    expect(appels[0]?.corps['model']).toBe('claude-haiku-5-5')
  })

  it('interroge aussi une cuisine sans rayon, pour le poids cuit et la saison', async () => {
    const { repos, ecrits } = fauxDepots([])
    const appels = claudeRepond([{ id: 1, rayon: 'Epicerie', poids_cuit: 300, mois_saison: null }])
    await completerProduits(env, repos, [{ id: 1, nom: 'Riz', marque: null }])
    expect(appels).toHaveLength(1)
    expect(ecrits).toEqual([[1, { rayon: null, poidsCuitG: 300, saison: null }]])
  })

  it('ne marque pas une fiche absente de la reponse : elle sera reproposee', async () => {
    const { repos, ecrits } = fauxDepots(['Epicerie'])
    claudeRepond([{ id: 1, rayon: null, poids_cuit: null, mois_saison: null }])
    await completerProduits(env, repos, [
      { id: 1, nom: 'Yaourt nature', marque: null },
      { id: 2, nom: 'Riz', marque: null },
    ])
    expect(ecrits.map(([id]) => id)).toEqual([1])
  })
})

describe('demanderCompletion', () => {
  it('n’ecrit rien', async () => {
    const { repos, ecrits } = fauxDepots(['Epicerie'])
    claudeRepond([{ id: 1, rayon: 'Epicerie', poids_cuit: 300, mois_saison: null }])
    const rendu = await demanderCompletion(env, repos, [{ id: 1, nom: 'Riz', marque: null }])
    expect(rendu.get(1)).toEqual({ rayon: 'Epicerie', poidsCuitG: 300, moisSaison: null, poidsPieceG: null })
    expect(ecrits).toHaveLength(0)
  })

  it('pour une fiche relue, demande le poids d’une piece et une estimation', async () => {
    const { repos } = fauxDepots(['Epicerie'])
    const appels = claudeRepond([{ id: 1, rayon: null, poids_cuit: 85, mois_saison: null, poids_piece: 30 }])
    const rendu = await demanderCompletion(env, repos, [{ id: 1, nom: 'Echalote, crue', marque: null }], {
      relue: true,
    })
    expect(rendu.get(1)?.poidsPieceG).toBe(30)
    const corps = JSON.stringify(appels[0]?.corps)
    expect(corps).toContain('poids_piece')
    expect(corps).toContain('meilleure estimation')
  })

  it('sans relecture, ne demande jamais le poids d’une piece', async () => {
    const { repos } = fauxDepots(['Epicerie'])
    const appels = claudeRepond([])
    await completerProduits(env, repos, [{ id: 1, nom: 'Echalote, crue', marque: null }])
    expect(JSON.stringify(appels[0]?.corps)).not.toContain('poids_piece')
  })
})

describe('completerEnArrierePlan', () => {
  it('avale une erreur : la creation ne doit jamais echouer pour une completion', async () => {
    const { repos } = fauxDepots(['Epicerie'])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"overloaded"}}', { status: 529 })),
    )
    await expect(completerEnArrierePlan({ env, repos }, [{ id: 1, nom: 'Riz', marque: null }])).resolves.toBeUndefined()
  })

  it('ne part pas sans cle', () => {
    const { repos } = fauxDepots(['Epicerie'])
    const sansCle = {} as unknown as Env
    expect(completerEnArrierePlan({ env: sansCle, repos }, [{ id: 1, nom: 'Riz', marque: null }])).toBeUndefined()
  })

  it('confie le travail au runtime quand il le peut', () => {
    const { repos } = fauxDepots(['Epicerie'])
    claudeRepond([{ id: 1, rayon: 'Epicerie', poids_cuit: null, mois_saison: null }])
    const confies: Array<Promise<unknown>> = []
    const rendu = completerEnArrierePlan({ env, repos, waitUntil: (p) => confies.push(p) }, [
      { id: 1, nom: 'Riz', marque: null },
    ])
    expect(rendu).toBeUndefined()
    expect(confies).toHaveLength(1)
  })
})
