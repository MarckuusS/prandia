/**
 * Une photo recue dans le corps d'une requete, prete pour Claude : bornee en
 * taille DANS le flux (un `content-length` peut mentir ou manquer), typee par
 * ses OCTETS (jamais par l'en-tete du client), encodee en base64.
 *
 * Servait d'abord a la seule lecture d'etiquette (routes/scan.ts) ; le ticket
 * de caisse (routes/courses.ts) en a besoin aussi, d'ou ce module.
 */

import { HttpError, badRequest } from './http.js'

export type TypeImage = 'image/jpeg' | 'image/png' | 'image/webp'

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
function typeImage(octets: Uint8Array): TypeImage | null {
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

/** Le corps entier, borne a `max` octets. */
async function octetsDuCorps(request: Request, max: number): Promise<Uint8Array> {
  const annonce = Number(request.headers.get('content-length'))
  if (Number.isFinite(annonce) && annonce > max) {
    throw new HttpError(413, 'scan_too_large', 'Photo trop lourde.')
  }
  if (request.body === null) throw badRequest('Photo absente.', 'scan_empty')
  try {
    return new Uint8Array(await new Response(request.body.pipeThrough(plafond(max))).arrayBuffer())
  } catch (erreur: unknown) {
    if (erreur instanceof HttpError) throw erreur
    throw badRequest('Photo illisible. Réessaie.', 'scan_unreadable')
  }
}

function blocImage(octets: Uint8Array): Record<string, unknown> {
  const type = typeImage(octets)
  if (type === null) throw new HttpError(415, 'scan_not_image', 'Ce fichier n’est pas une photo.')
  return { type: 'image', source: { type: 'base64', media_type: type, data: enBase64(octets) } }
}

/** Le bloc image d'un message Claude, tire du corps de la requete. */
export async function imageDuCorps(request: Request, max: number): Promise<Record<string, unknown>> {
  return blocImage(await octetsDuCorps(request, max))
}

/**
 * PLUSIEURS photos dans un seul corps, mises bout a bout : l'en-tete
 * `x-photos` donne la taille de chacune ("48211,51007"). Pas de
 * `request.formData()`, qui ne borne rien (un corps de 100 Mo tue l'isolat) :
 * le corps est plafonne dans le flux comme pour une photo seule, et chaque
 * morceau est type par ses propres octets.
 */
export async function imagesDuCorps(
  request: Request,
  max: number,
  nombreMax: number,
): Promise<Array<Record<string, unknown>>> {
  const tailles = (request.headers.get('x-photos') ?? '').split(',').map(Number)
  if (tailles.length > nombreMax || !tailles.every((t) => Number.isInteger(t) && t > 0)) {
    throw badRequest('Photos absentes ou trop nombreuses.', 'scan_empty')
  }
  const octets = await octetsDuCorps(request, max)
  if (tailles.reduce((total, t) => total + t, 0) !== octets.length) {
    throw badRequest('Photos illisibles. Réessaie.', 'scan_unreadable')
  }
  let debut = 0
  return tailles.map((taille) => {
    const bloc = blocImage(octets.subarray(debut, debut + taille))
    debut += taille
    return bloc
  })
}
