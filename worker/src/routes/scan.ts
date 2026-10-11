/**
 * Lire une photo d'etiquette : la date, le prix ou la quantite.
 *
 * `POST /api/scan?quoi=date|prix|quantite`, corps = l'image (JPEG reduit par le
 * telephone). Le serveur la fait lire par Claude Haiku avec une question et un
 * outil a schema force (shared/src/scan.ts), verifie la reponse, et la RENVOIE :
 * rien n'est ecrit en base. L'ecran pose la valeur dans le champ, et elle ne
 * part qu'avec le bouton d'enregistrement, comme une saisie.
 *
 * Ce qui ne se devine pas :
 *   - la cle est un SECRET de Pages (`ANTHROPIC_API_KEY`), jamais dans le
 *     depot, qui est public. Absente, la route le dit au lieu de planter ;
 *   - un plafond par jour et par cuisine protege les credits d'une boucle ou
 *     d'un bouton qui se bloquerait. Le vrai garde-fou reste le plafond de
 *     depense pose dans la Console Anthropic ;
 *   - la photo n'est PAS conservee : ni R2, ni journal.
 */

import { SCAN_QUESTIONS, interpretScan, isScanKind, parisClock } from '@prandia/shared'

import { HttpError, badRequest, json, route } from '../http.js'

/** Le plus petit modele de vision : lire une date ne demande pas plus. */
const MODELE = 'claude-haiku-5-5'

/** Le telephone envoie 1 024 px de cote au plus : quelques centaines de Ko. */
const IMAGE_MAX_OCTETS = 3 * 1024 * 1024

/** Bien au-dela d'un usage reel (500 par mois), bien en deca d'une fuite. */
const LECTURES_PAR_JOUR_MAX = 150

const CLE_COMPTEUR = 'scan.compteur'

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

  const cle = env.ANTHROPIC_API_KEY
  if (cle === undefined || cle === '') {
    throw new HttpError(503, 'scan_unconfigured', 'La lecture des étiquettes n’est pas encore configurée.')
  }

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

  // Le compteur est compte AVANT l'appel : une lecture qui echoue a quand
  // meme pu couter, et un bouton bloque en boucle ne doit pas passer outre.
  const jour = parisClock(new Date()).day
  const compteur = await repos.settings.getJson<{ jour: string; n: number }>(CLE_COMPTEUR, { jour, n: 0 })
  const deja = compteur.jour === jour ? compteur.n : 0
  if (deja >= LECTURES_PAR_JOUR_MAX) {
    throw new HttpError(429, 'scan_quota', 'Trop de lectures aujourd’hui. Saisis à la main, ça repart demain.')
  }
  await repos.settings.setJson(CLE_COMPTEUR, { jour, n: deja + 1 })

  const { question, tool } = SCAN_QUESTIONS[quoi]
  let reponse: Response
  try {
    reponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cle,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODELE,
        max_tokens: 300,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: type, data: enBase64(octets) } },
              { type: 'text', text: question },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new HttpError(502, 'scan_unreachable', 'Le service de lecture ne répond pas. Réessaie.')
  }

  if (!reponse.ok) {
    // Le corps d'erreur d'Anthropic ne sort jamais tel quel : il peut citer
    // l'organisation. On n'en garde que la nature.
    const detail = await reponse.text().catch(() => '')
    if (reponse.status === 401 || reponse.status === 403) {
      throw new HttpError(502, 'scan_key', 'La clé de lecture est refusée. Vérifie ANTHROPIC_API_KEY.')
    }
    if (/credit balance/i.test(detail)) {
      throw new HttpError(502, 'scan_credit', 'Les crédits de lecture sont épuisés pour ce mois.')
    }
    // Le plafond de depense de l'espace de travail "Prandia", pose dans la
    // Console : c'est lui qui arrete les lectures, et il faut le dire, sinon
    // l'ecran n'affiche qu'un code d'erreur.
    if (/usage limit|spend limit/i.test(detail)) {
      throw new HttpError(502, 'scan_limit', 'Le plafond de dépense des lectures est atteint pour ce mois.')
    }
    if (reponse.status === 429 || reponse.status === 529) {
      throw new HttpError(503, 'scan_busy', 'Le service de lecture est occupé. Réessaie dans un instant.')
    }
    throw new HttpError(502, 'scan_error', `Le service de lecture a répondu ${reponse.status}.`)
  }

  const corps = (await reponse.json()) as { content?: Array<{ type?: string; input?: unknown }> }
  const appel = corps.content?.find((bloc) => bloc.type === 'tool_use')
  return json(interpretScan(quoi, appel?.input))
})
