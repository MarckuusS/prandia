/**
 * La photo de garde d'une recette : la lire, la deposer, la retirer.
 *
 * PREMIER MODULE DU PROJET QUI ECRIT DANS R2, et R2 n'a pas les proprietes de
 * D1. Trois consequences a garder en tete en relisant ce fichier :
 *
 * 1. AUCUNE TRANSACTION NE COUVRE LES DEUX MAGASINS. L'ordre des ecritures est
 *    la seule garantie dont on dispose, et la regle tient en une phrase : D1 ne
 *    doit jamais designer un objet qui n'existe pas. Au depot on ecrit donc R2
 *    d'abord ; au retrait on ecrit D1 d'abord. Le bon sens echoue toujours
 *    invisiblement (un objet orphelin de quelques centaines de kilooctets,
 *    balaye au depot suivant), le mauvais echoue toujours visiblement (une
 *    image cassee sur la fiche, donc une application qui ment).
 *
 * 2. R2 EST LE SEUL MAGASIN DE CE PROJET SANS COLONNE DE FOYER, et sans
 *    possibilite d'en avoir une. Dans D1, un `AND household_id = ?` oublie rend
 *    une liste vide parce que le depot porte le foyer structurellement. Ici,
 *    TOUT le cloisonnement est derive : il n'existe que parce que chaque route
 *    passe par `repos.recipes.get()` AVANT de toucher au bucket. Le point le
 *    plus subtil du fichier est que verifier l'appartenance de la RECETTE
 *    n'implique pas verifier l'appartenance de la CLE : c'est pour cela que la
 *    cle n'est jamais fournie par le client, mais lue en base ou fabriquee ici.
 *
 * 3. LE CONTENU EST DE L'UTILISATEUR. Le `content-type` d'une requete est une
 *    declaration, pas un fait, et la reponse ne le rejoue jamais. Voir la route
 *    de lecture pour le detail des en-tetes, dont chacune repond a un scenario
 *    precis.
 */

import {
  PHOTO,
  PHOTO_BODY_MAX,
  type PhotoSize,
  checkJpegSegments,
  coverKey,
  detectImageKind,
  nameRefusedFormat,
  photoPrefix,
  vignetteKey,
} from '@prandia/shared'

import { logActivity } from '../activity.js'
import { HttpError, type Env, intParam, json, notFound, route } from '../http.js'

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Les en-tetes de service d'un contenu televerse par l'utilisateur.
 *
 * ELLES NE PASSENT PAS PAR `json()`, qui force `cache-control: no-store` : une
 * photo doit se mettre en cache, c'est tout l'interet de la cle versionnee.
 * Precedent deja pris par `session.ts`, qui construit sa Response a la main
 * pour poser un `set-cookie`. Que ce commentaire existe est deliberé : sans
 * lui, quelqu'un ramenera cette route au helper commun.
 *
 * Chaque ligne repond a un scenario, aucune n'est de la superstition :
 *
 * - `content-type` est une CONSTANTE LITTERALE, et `writeHttpMetadata` n'est
 *   jamais appele. Cette methode, que la documentation Cloudflare montre en
 *   exemple, rejoue le type que le client avait declare a l'envoi : un SVG
 *   televerse en `image/svg+xml` puis ouvert en navigation de premier niveau
 *   serait un document, et ses scripts liraient `/api/profile` sur notre
 *   origine, c'est-a-dire le poids, la taille et l'annee de naissance.
 * - `sandbox` est la seule en-tete qui neutralise ce scenario meme si tout le
 *   reste echoue : origine opaque, ni cookie ni acces meme-origine. Elle
 *   n'empeche pas un `<img>` de fonctionner.
 * - `private`, jamais `public` : la reponse depend du cookie. `vary: Cookie`
 *   le redit a ceux qui ne lisent que lui.
 * - `immutable` n'est legitime QUE parce que l'URL porte l'empreinte du
 *   contenu en `?v=`. Les deux se tiennent debout mutuellement : une cle fixe
 *   avec `immutable`, ce serait l'ancienne photo pendant un an, sur l'appareil
 *   meme qui vient de la remplacer.
 */
const enTetesPhoto = (etag: string): Record<string, string> => ({
  'content-type': 'image/jpeg',
  'cache-control': 'private, max-age=31536000, immutable',
  etag,
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'content-disposition': 'inline; filename="photo.jpg"',
  vary: 'Cookie',
})

route('GET', '/api/recipes/:id/image', async ({ repos, env, params, url, request }) => {
  const id = intParam(params, 'id')

  const taille = url.searchParams.get('size') ?? 'cover'
  if (taille !== 'cover' && taille !== 'thumb') {
    throw new HttpError(400, 'invalid_size', "Taille d'image inconnue.")
  }

  // AVANT TOUT APPEL A R2. `get()` filtre sur le foyer en base : c'est le seul
  // endroit ou le cloisonnement de cette photo est reellement verifie.
  const recipe = await repos.recipes.get(id)

  /*
   * UN SEUL 404 POUR DEUX CAS, et c'est deliberé. Distinguer "cette recette
   * n'existe pas" de "elle existe mais n'a pas de photo" ferait de cette route
   * un oracle d'existence entre cuisines : on apprendrait, en balayant les
   * identifiants, combien de recettes portent les foyers voisins.
   */
  if (recipe === null || recipe.imageKey === null) {
    throw notFound('Aucune photo pour cette recette.')
  }

  const cle = taille === 'thumb' ? vignetteKey(recipe.imageKey) : recipe.imageKey

  // `onlyIf` confie les requetes conditionnelles a R2, qui les traite
  // nativement : inutile de comparer les ETag a la main.
  const objet = await env.MEDIA.get(cle, { onlyIf: request.headers })

  /*
   * ABSENT VAUT 404, PAS 500. C'est le cas de la cle pendante : une ligne qui
   * designe un objet jamais televerse, exactement ce que la migration 0015
   * nettoie. Le desktop faisait le meme choix, `absolute_photo_path` rendant
   * `None` plutot que de lever.
   */
  if (objet === null) throw notFound('Aucune photo pour cette recette.')

  const entetes = enTetesPhoto(objet.httpEtag)

  // R2 rend un objet SANS corps quand la precondition est deja satisfaite.
  // Avec `immutable` le cas est rare, mais apres une eviction de cache un 304
  // economise deux cents kilooctets sur le reseau d'un magasin.
  if (!('body' in objet)) return new Response(null, { status: 304, headers: entetes })

  return new Response(objet.body, { headers: entetes })
})

// ---------------------------------------------------------------------------
// Depot
// ---------------------------------------------------------------------------

/**
 * Un plafond d'octets, ecrit dans l'unite qui lui convient.
 *
 * Le plafond de la vignette est de deux cent mille octets : arrondi en
 * megaoctets, il s'affichait « 0 Mo maximum », ce qui ne veut rien dire et
 * laisse croire a un bogue plutot qu'a une limite.
 */
const poidsLisible = (octets: number): string =>
  octets >= 1_000_000
    ? `${Math.round(octets / 1_000_000)} Mo`
    : `${Math.round(octets / 1_000)} ko`

const tropLourd = (taille: PhotoSize) =>
  new HttpError(
    413,
    'image_too_large',
    `Cette photo est trop lourde (${poidsLisible(PHOTO[taille].maxBytes)} maximum après réduction).`,
  )

/**
 * Un flux qui ERREUR au-dela d'un plafond, au lieu de le laisser passer.
 *
 * `request.formData()` ne borne RIEN et alloue ce qui arrive. Un corps de cent
 * megaoctets, la limite de requete d'un Worker, tue un isolat de cent
 * vingt-huit, et cette mort n'est PAS une exception rattrapable : le
 * `try/catch` du routeur ne s'execute pas, l'utilisateur recoit une erreur
 * Cloudflare brute, et le journal ne dit rien.
 */
function limiteur(max: number): TransformStream<Uint8Array, Uint8Array> {
  let vus = 0
  return new TransformStream({
    transform(morceau, controleur) {
      vus += morceau.byteLength
      if (vus > max) {
        controleur.error(new HttpError(413, 'image_too_large', 'Envoi trop volumineux.'))
        return
      }
      controleur.enqueue(morceau)
    },
  })
}

/**
 * Borne le corps AVANT que `formData()` ne l'avale.
 *
 * `content-length` est un rejet precoce et gratuit, PAS une garantie : il peut
 * etre absent (transfert par morceaux) ou annoncer moins que ce qui arrive.
 * D'ou la seconde borne, posee dans le flux lui-meme. On reconstruit une
 * Response avec le MEME content-type, car c'est lui qui porte la frontiere
 * multipart, sur un flux plafonne, et c'est cette Response qu'on decoupe.
 */
async function corpsBorne(request: Request, max: number): Promise<FormData> {
  const annonce = Number(request.headers.get('content-length'))
  if (Number.isFinite(annonce) && annonce > max) {
    throw new HttpError(413, 'image_too_large', 'Envoi trop volumineux.')
  }
  const type = request.headers.get('content-type') ?? ''
  if (request.body === null) throw new HttpError(400, 'invalid_body', 'Envoi vide.')

  try {
    return await new Response(request.body.pipeThrough(limiteur(max)), {
      headers: { 'content-type': type },
    }).formData()
  } catch (erreur: unknown) {
    // Le plafond du flux remonte ici : on le relaie tel quel plutot que de le
    // maquiller en corps illisible, sinon "trop lourd" deviendrait "illisible"
    // et l'utilisateur ne saurait pas quoi corriger.
    if (erreur instanceof HttpError) throw erreur
    throw new HttpError(400, 'invalid_body', 'Envoi illisible. Réessaie.')
  }
}

/** Une partie du formulaire, validee jusqu'aux octets. */
async function partieValidee(form: FormData, nom: PhotoSize): Promise<Uint8Array> {
  /*
   * LES TYPES SONT EN RETARD SUR LE RUNTIME ICI, et c'est verifie plutot que
   * suppose : dans la version de `@cloudflare/workers-types` de ce depot,
   * `FormData.get` est declare `(name: string) => string | null`, sans `File`.
   * Le runtime rend pourtant bien un fichier pour une partie de type fichier,
   * c'est la specification et c'est ce que workerd implemente. On restaure donc
   * la verite du runtime par un type explicite, ce qui laisse la validation
   * ci-dessous faire son travail, plutot que de la contourner.
   *
   * Le narrowing se fait par `typeof` et non par `instanceof` : le type
   * contient une primitive, et `instanceof` sur une union qui en contient une
   * est refuse a la compilation. Une partie recue en chaine, c'est un client
   * qui a envoye un champ texte la ou on attend un fichier.
   */
  const partie = form.get(nom) as unknown as Blob | string | null
  if (partie === null || typeof partie === 'string') {
    throw new HttpError(422, 'image_missing', "L'envoi est incomplet. Réessaie.")
  }
  // La taille AVANT toute lecture : inutile de charger en memoire ce qu'on
  // refusera.
  if (partie.size > PHOTO[nom].maxBytes) throw tropLourd(nom)

  const octets = new Uint8Array(await partie.arrayBuffer())

  if (detectImageKind(octets) === null) {
    const nomme = nameRefusedFormat(octets)
    throw new HttpError(
      415,
      'unsupported_image',
      nomme === null
        ? 'Envoie une photo au format JPEG.'
        : `Envoie une photo au format JPEG. Le fichier reçu est ${nomme}.`,
    )
  }

  if (checkJpegSegments(octets) !== 'ok') {
    throw new HttpError(
      422,
      'image_metadata',
      'Cette photo porte des métadonnées (position, appareil) ou ne se lit pas. Choisis-la depuis l’application plutôt que de l’envoyer directement.',
    )
  }

  return octets
}

/** Les huit premiers octets du SHA-256, en hexadecimal. */
async function empreinte(octets: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', octets)
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((o) => o.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Efface de R2 tout ce qui concerne une recette sauf la paire a garder.
 *
 * NE FAIT JAMAIS ECHOUER LA REQUETE, meme doctrine que `logActivity`. Au depot,
 * la photo est deja ecrite et referencee : echouer ici ferait recommencer
 * l'utilisateur et creerait un debris de plus au lieu d'en retirer un.
 */
async function balayer(env: Env, recipeId: number, aGarder: string | null): Promise<void> {
  const garder = new Set(aGarder === null ? [] : [aGarder, vignetteKey(aGarder)])
  try {
    const liste = await env.MEDIA.list({ prefix: photoPrefix(recipeId) })
    const morts = liste.objects.map((o) => o.key).filter((k) => !garder.has(k))
    if (morts.length > 0) await env.MEDIA.delete(morts)
  } catch {
    // Silence assume : voir ci-dessus.
  }
}

route('POST', '/api/recipes/:id/image', async ({ repos, env, params, request, user }) => {
  const id = intParam(params, 'id')

  const recipe = await repos.recipes.get(id)
  if (recipe === null) throw notFound('Recette introuvable.')

  const form = await corpsBorne(request, PHOTO_BODY_MAX)
  const grande = await partieValidee(form, 'cover')
  const vignette = await partieValidee(form, 'thumb')

  const cle = coverKey(id, await empreinte(grande))

  // R2 D'ABORD, D1 ENSUITE. Voir l'en-tete du fichier : c'est la seule
  // garantie dont on dispose, et elle a un sens.
  try {
    // Le content-type est une CONSTANTE, jamais celui du client : c'est ce qui
    // sera relu si un jour quelqu'un appelle `writeHttpMetadata`.
    const meta = { httpMetadata: { contentType: 'image/jpeg' } }
    await env.MEDIA.put(cle, grande, meta)
    await env.MEDIA.put(vignetteKey(cle), vignette, meta)
  } catch {
    throw new HttpError(
      502,
      'storage_unreachable',
      "La photo n'a pas pu être enregistrée. Réessaie.",
    )
  }

  const remplacement = recipe.imageKey !== null
  await repos.recipes.setImageKey(id, cle)
  await balayer(env, id, cle)

  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'recipe',
    entityId: id,
    label: recipe.name,
    details: { photo: remplacement ? 'remplacee' : 'ajoutee' },
  })

  // JAMAIS 204 : `apiFetch` refuse toute reponse qui n'est pas du JSON.
  return json({ id, imageKey: cle })
})

route('DELETE', '/api/recipes/:id/image', async ({ repos, env, params, user }) => {
  const id = intParam(params, 'id')

  const recipe = await repos.recipes.get(id)
  if (recipe === null) throw notFound('Recette introuvable.')

  // D1 D'ABORD, l'inverse du depot et pour la meme raison : on cesse de
  // designer l'objet avant de l'effacer, jamais l'inverse.
  if (recipe.imageKey !== null) {
    await repos.recipes.setImageKey(id, null)
    await logActivity(env.DB, user, {
      action: 'update',
      entity: 'recipe',
      entityId: id,
      label: recipe.name,
      details: { photo: 'retiree' },
    })
  }
  await balayer(env, id, null)

  // IDEMPOTENTE : deux appuis sur un mauvais reseau rendent 200 les deux fois.
  return json({ id, imageKey: null })
})

export { balayer }
