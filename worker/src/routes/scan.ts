/**
 * Lire une photo d'etiquette ou d'emballage.
 *
 * `POST /api/scan?quoi=date|prix|quantite|pesee|produit|nutrition`, corps =
 * l'image (JPEG recadre et reduit par le telephone). Le serveur la fait lire
 * par Claude Haiku avec une question et un outil a schema force
 * (shared/src/scan.ts), verifie la reponse, et la RENVOIE : rien n'est ecrit
 * en base. L'ecran pose les valeurs dans les champs, et elles ne partent
 * qu'avec le bouton d'enregistrement, comme une saisie.
 *
 * La photo n'est PAS conservee : ni R2, ni journal. La cle, le modele, le
 * plafond et les erreurs sont dans anthropic.ts.
 */

import { SCAN_QUESTIONS, interpretScan, isScanKind } from '@prandia/shared'

import { cleClaude, compterAppel, demanderOutil } from '../anthropic.js'
import { HttpError, badRequest, json, route } from '../http.js'

/** Le telephone envoie 1 568 px de cote au plus : quelques centaines de Ko. */
const IMAGE_MAX_OCTETS = 4 * 1024 * 1024

/** Coupe le corps au-dela de `max` octets, dans le flux lui-meme. */
function plafond(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0
  return new TransformStream({
    transform(morceau, controle) {
      total += morceau.byteLength
      if (total > max) {
        controle.error(new HttpError(413, 'scan_too_large', 'Photo trop lourde.'))
        return
      }
      controle.enqueue(morceau)
    },
  })
}

/** Le type tire des OCTETS : seuls ceux que le modele sait lire passent. */
function typeImage(octets: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const egal = (attendu: number[], depuis = 0) => attendu.every((v, i) => octets[depuis + i] === v)
  if (egal([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (egal([0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (egal([0x52, 0x49, 0x46, 0x46]) && egal([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}

function enBase64(octets: Uint8Array): string {
  let binaire = ''
  for (let i = 0; i < octets.length; i += 0x8000) {
    binaire += String.fromCharCode(...octets.subarray(i, i + 0x8000))
  }
  return btoa(binaire)
}

route('POST', '/api/scan', async ({ request, url, env, repos }) => {
  const quoi = url.searchParams.get('quoi')
  if (!isScanKind(quoi)) throw badRequest('Lecture inconnue.', 'scan_kind')
  const cle = cleClaude(env)

  const annonce = Number(request.headers.get('content-length'))
  if (Number.isFinite(annonce) && annonce > IMAGE_MAX_OCTETS) {
    throw new HttpError(413, 'scan_too_large', 'Photo trop lourde.')
  }
  if (request.body === null) throw badRequest('Photo absente.', 'scan_empty')
  let octets: Uint8Array
  try {
    octets = new Uint8Array(await new Response(request.body.pipeThrough(plafond(IMAGE_MAX_OCTETS))).arrayBuffer())
  } catch (erreur: unknown) {
    if (erreur instanceof HttpError) throw erreur
    throw badRequest('Photo illisible. Réessaie.', 'scan_unreadable')
  }
  const type = typeImage(octets)
  if (type === null) throw new HttpError(415, 'scan_not_image', 'Ce fichier n’est pas une photo.')

  await compterAppel(repos)
  const { question, tool } = SCAN_QUESTIONS[quoi]
  const sortie = await demanderOutil(cle, [
    { type: 'image', source: { type: 'base64', media_type: type, data: enBase64(octets) } },
    { type: 'text', text: question },
  ], tool)
  return json(interpretScan(quoi, sortie))
})
