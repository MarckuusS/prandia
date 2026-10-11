/**
 * Importer une recette depuis un lien : lire la page, proposer les ingredients.
 *
 * LE SERVEUR LIT LA PAGE, PAS LE NAVIGATEUR. Un site de cuisine n'autorise pas
 * une autre origine a lire ses pages (CORS) : le telephone ne peut pas les
 * recuperer lui-meme. Le Worker va donc la chercher, en lit le bloc "Recipe"
 * (voir shared/src/importRecette.ts), et RIEN N'EST ECRIT ici : la route rend
 * une proposition. La recette ne nait qu'apres la revue, par la route de
 * creation habituelle, qui verifie a nouveau que chaque ingredient est de la
 * cuisine.
 *
 * La photo suit le meme chemin pour la meme raison, et repart vers le
 * navigateur, qui la reduit comme une photo prise au telephone : `workerd` n'a
 * aucun decodeur d'image (voir photos.ts).
 */

import { z } from 'zod'
import {
  ECART_SUR,
  QUANTITES_MAX,
  QUANTITES_TOOL,
  SEUIL_RETENU,
  SEUIL_SUR,
  extractJsonLdBlocks,
  extractOgImage,
  importFtsQuery,
  interpretQuantites,
  lienRecette,
  matchScore,
  parseIngredientLine,
  parseRecipeJsonLd,
  quantitesQuestion,
  searchTerms,
  type Ingredient,
} from '@prandia/shared'

import { cleClaude, compterAppel, demanderOutil } from '../anthropic.js'
import { HttpError, badRequest, json, parseOrThrow, readJson, route } from '../http.js'
import type { Repositories } from '../repos/index.js'

const corpsSchema = z.object({ url: z.string().max(4000) })

/**
 * Un navigateur ordinaire, qui se nomme a la fin. Plusieurs sites de cuisine
 * refusent un client inconnu ; celui-ci agit pour une personne qui lit la page,
 * exactement comme l'apercu d'un lien dans une messagerie.
 */
const AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1 Prandia/0.2'

const DELAI_MS = 15_000
/** Le bloc recette est petit, la page parfois enorme : au-dela, on coupe. */
const PAGE_MAX = 3_000_000
const PHOTO_MAX = 15_000_000
/** Une recette de soixante ingredients est deja une erreur de lecture. */
const LIGNES_MAX = 60
const CANDIDATS_MAX = 5
/** Sous ce score, aucun mot de la ligne ne se retrouve dans la fiche. */
const PROPOSITION_MIN = 0.25

function adresse(brut: string): URL {
  const lien = lienRecette(brut)
  if (lien === null) {
    throw badRequest('Ce texte ne contient pas de lien vers un site de recettes.', 'import_bad_url')
  }
  return new URL(lien)
}

async function chercher(url: URL, accept: string): Promise<Response> {
  let reponse: Response
  try {
    reponse = await fetch(url.toString(), {
      headers: { 'User-Agent': AGENT, Accept: accept, 'Accept-Language': 'fr-FR,fr;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(DELAI_MS),
    })
  } catch {
    throw new HttpError(502, 'import_unreachable', 'Le site ne répond pas. Vérifie le lien, ou réessaie dans un moment.')
  }
  if (reponse.status === 401 || reponse.status === 403 || reponse.status === 429) {
    throw new HttpError(
      502,
      'import_refused',
      'Ce site refuse d’être lu par l’application. Il faudra saisir cette recette à la main.',
    )
  }
  if (!reponse.ok) {
    throw new HttpError(502, 'import_http', `Le site a répondu par une erreur (${reponse.status}).`)
  }
  return reponse
}

/**
 * Le corps, sans jamais depasser `max` octets EN MEMOIRE : `arrayBuffer()`
 * chargerait d'abord tout, et une page de cent megaoctets tuerait l'isolat.
 * `couper` : rendre le debut (une page) ou refuser (une photo tronquee est une
 * photo cassee).
 */
async function lireBorne(reponse: Response, max: number, couper: boolean): Promise<Uint8Array> {
  const annonce = Number(reponse.headers.get('content-length') ?? 0)
  if (!couper && annonce > max) {
    throw new HttpError(413, 'import_too_large', 'Cette image est trop lourde pour être importée.')
  }
  const lecteur = reponse.body?.getReader()
  if (lecteur === undefined) return new Uint8Array()
  const morceaux: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await lecteur.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await lecteur.cancel()
      if (!couper) throw new HttpError(413, 'import_too_large', 'Cette image est trop lourde pour être importée.')
      morceaux.push(value.subarray(0, value.byteLength - (total - max)))
      total = max
      break
    }
    morceaux.push(value)
  }
  const tout = new Uint8Array(total)
  let decalage = 0
  for (const m of morceaux) {
    tout.set(m, decalage)
    decalage += m.byteLength
  }
  return tout
}

/**
 * Les fiches qui pourraient correspondre a une ligne, de la meilleure a la
 * moins bonne. Une seule requete (voir `importCandidates` pour son ordre),
 * puis le classement fin par `matchScore`. La bibliotheque garde un bonus : une
 * fiche qu'on a choisie un jour vaut mieux qu'une fiche du catalogue.
 */
async function candidats(repos: Repositories, termes: readonly string[]): Promise<Array<{ ingredient: Ingredient; score: number }>> {
  const tete = termes[0]
  if (tete === undefined) return []
  const trouves = await repos.ingredients.importCandidates(tete, importFtsQuery(termes))
  return trouves
    .map((ingredient) => ({
      ingredient,
      score: matchScore(ingredient.name, termes) + (ingredient.inLibrary ? 0.15 : 0),
    }))
    // Pas un mot en commun avec la ligne : ce n'est pas une proposition.
    // "Trompette de la mort" ne doit pas proposer de la mortadelle.
    .filter((c) => c.score > PROPOSITION_MIN)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATS_MAX)
}

/** La page de la recette, et l'adresse reellement servie (redirections comprises). */
async function lirePage(url: URL): Promise<{ html: string; base: string }> {
  const reponse = await chercher(url, 'text/html,application/xhtml+xml')
  const type = reponse.headers.get('content-type') ?? ''
  if (type !== '' && !/html|xml/i.test(type)) {
    throw new HttpError(422, 'import_not_html', 'Ce lien ne mène pas à une page web.')
  }
  const html = new TextDecoder().decode(await lireBorne(reponse, PAGE_MAX, true))
  return { html, base: reponse.url || url.toString() }
}

/**
 * Deux images possibles : celle du bloc recette, parfois une simple vignette,
 * puis l'image de partage de la page, presque toujours grande. Souvent
 * relatives au site ("/img/gratin.jpg") : resolues contre la page reellement
 * servie. L'ecran garde la premiere assez grande.
 */
function imagesDeLaPage(html: string, base: string, imageRecette: string | null): string[] {
  const resoudre = (brute: string | null): string | null => {
    if (brute === null) return null
    try {
      return lienRecette(new URL(brute, base).toString())
    } catch {
      return null
    }
  }
  return [...new Set([resoudre(imageRecette), resoudre(extractOgImage(html))])].filter(
    (u): u is string => u !== null,
  )
}

function recetteDeLaPage(html: string) {
  const recette = parseRecipeJsonLd(extractJsonLdBlocks(html))
  if (recette === null) {
    throw new HttpError(
      422,
      'import_no_recipe',
      'Aucune recette lisible sur cette page : le site ne la publie pas dans un format que Prandia sait lire.',
    )
  }
  return recette
}

route('POST', '/api/recipe-import', async ({ repos, request }) => {
  const { url: brut } = parseOrThrow(corpsSchema, await readJson(request))
  const url = adresse(brut)
  const { html, base } = await lirePage(url)
  const recette = recetteDeLaPage(html)

  const lignes = await Promise.all(
    recette.ingredients.slice(0, LIGNES_MAX).map(async (raw) => {
      const lue = parseIngredientLine(raw)
      const classes = await candidats(repos, searchTerms(lue.name))
      const meilleur = classes[0]
      const second = classes[1]
      return {
        raw,
        quantity: lue.quantity,
        unit: lue.unit,
        name: lue.name,
        portion: lue.portion,
        candidates: classes.map((c) => c.ingredient),
        choiceId: meilleur !== undefined && meilleur.score >= SEUIL_RETENU ? meilleur.ingredient.id : null,
        // Sure : une note haute ET un ecart net avec le suivant. "Huile" va aussi
        // bien a l'huile d'olive qu'a l'huile de colza.
        sure:
          meilleur !== undefined &&
          meilleur.score >= SEUIL_SUR &&
          (second === undefined || meilleur.score - second.score >= ECART_SUR),
      }
    }),
  )

  const imageUrls = imagesDeLaPage(html, base, recette.imageUrl)

  return json({
    recipe: { ...recette, imageUrl: imageUrls[0] ?? null, imageUrls, sourceUrl: url.toString() },
    lines: lignes,
  })
})

/**
 * Les seules adresses des photos d'une page, pour reprendre la photo du site
 * d'une recette deja creee (une photo manquee a l'import). Ne lit RIEN en
 * base : relancer tout l'import chercherait des candidats pour chaque ligne,
 * des milliers de lignes lues pour une photo.
 */
route('POST', '/api/recipe-import/images', async ({ request }) => {
  const { url: brut } = parseOrThrow(corpsSchema, await readJson(request))
  const url = adresse(brut)
  const { html, base } = await lirePage(url)
  return json({ imageUrls: imagesDeLaPage(html, base, recetteDeLaPage(html).imageUrl) })
})

/** Les signatures des formats qu'un navigateur sait decoder. */
function typeImage(octets: Uint8Array): string | null {
  const debut = (n: number) => Array.from(octets.subarray(0, n))
  const egal = (attendu: number[], depuis = 0) => attendu.every((v, i) => octets[depuis + i] === v)
  if (egal([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (egal([0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (egal([0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (egal([0x52, 0x49, 0x46, 0x46]) && egal([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  if (debut(12).length === 12 && egal([0x66, 0x74, 0x79, 0x70], 4)) return 'image/avif'
  return null
}

/**
 * La photo d'une recette, relayee telle quelle vers le navigateur qui la
 * reduira.
 *
 * Le type servi vient des OCTETS, jamais de l'en-tete du site : meme regle que
 * photos.ts, et pour la meme raison, un SVG ou une page HTML renvoyes sous
 * notre adresse seraient des documents dont les scripts liraient l'API. S'y
 * ajoutent `nosniff`, une CSP `sandbox` et une piece jointe : ouverte par
 * erreur dans un onglet, la reponse ne s'executerait pas.
 */
route('POST', '/api/recipe-import/photo', async ({ request }) => {
  const { url: brut } = parseOrThrow(corpsSchema, await readJson(request))
  const reponse = await chercher(adresse(brut), 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8')
  const octets = await lireBorne(reponse, PHOTO_MAX, false)
  const type = typeImage(octets)
  if (type === null) throw new HttpError(422, 'import_not_image', 'L’image de cette recette est illisible.')
  return new Response(octets, {
    headers: {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'attachment',
    },
  })
})

const quantitesSchema = z
  .object({
    titre: z.string().trim().min(1).max(300),
    portions: z.number().int().positive().max(100).nullable(),
    site: z.string().trim().max(200).nullable(),
    lignes: z.array(z.string().max(300)).min(1).max(80),
    aEstimer: z
      .array(
        z.object({
          index: z.number().int().nonnegative(),
          fiche: z.string().trim().max(200).nullable(),
          contenanceG: z.number().positive().max(20_000).nullable(),
        }),
      )
      .min(1)
      .max(QUANTITES_MAX),
  })
  .refine((corps) => corps.aEstimer.every((a) => a.index < corps.lignes.length), {
    message: 'Ligne à estimer hors de la recette.',
  })

/**
 * Estimer en grammes les quantites que le site ne donne pas en poids
 * (shared/src/quantitesIA.ts). Rien n'est ecrit : la revue les affiche,
 * encadrees, et la personne les corrige avant de creer la recette. Un seul
 * appel pour toute la recette : la coherence se juge sur l'ensemble.
 */
route('POST', '/api/recipe-import/quantites', async ({ repos, env, request }) => {
  const recette = parseOrThrow(quantitesSchema, await readJson(request))
  const cle = cleClaude(env)
  await compterAppel(repos)
  const sortie = await demanderOutil(cle, [{ type: 'text', text: quantitesQuestion(recette) }], QUANTITES_TOOL, 1500)
  const estimations = interpretQuantites(
    sortie,
    recette.aEstimer.map((a) => a.index),
  )
  return json({ estimations: [...estimations].map(([index, grammes]) => ({ index, grammes })) })
})
