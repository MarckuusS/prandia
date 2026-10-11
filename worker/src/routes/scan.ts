/**
 * Lire une photo d'etiquette ou d'emballage.
 *
 * `POST /api/scan?quoi=date|prix|quantite|nom|marque|nutrition`, corps =
 * l'image (JPEG recadre et reduit par le telephone). Le serveur la fait lire
 * par Claude Haiku avec une question et un outil a schema force
 * (shared/src/scan.ts), verifie la reponse, et la RENVOIE : rien n'est ecrit
 * en base. L'ecran pose les valeurs dans les champs, et elles ne partent
 * qu'avec le bouton d'enregistrement, comme une saisie.
 *
 * La photo n'est PAS conservee : ni R2, ni journal. La cle, le modele, le
 * plafond et les erreurs sont dans anthropic.ts, la photo recue dans
 * imageRecue.ts.
 */

import { SCAN_QUESTIONS, interpretScan, isScanKind } from '@prandia/shared'

import { cleClaude, compterAppel, demanderOutil } from '../anthropic.js'
import { badRequest, json, route } from '../http.js'
import { imageDuCorps } from '../imageRecue.js'

/** Le telephone envoie 1 568 px de cote au plus : quelques centaines de Ko. */
const IMAGE_MAX_OCTETS = 4 * 1024 * 1024

route('POST', '/api/scan', async ({ request, url, env, repos }) => {
  const quoi = url.searchParams.get('quoi')
  if (!isScanKind(quoi)) throw badRequest('Lecture inconnue.', 'scan_kind')
  const cle = cleClaude(env)
  const image = await imageDuCorps(request, IMAGE_MAX_OCTETS)

  await compterAppel(repos)
  const { question, tool } = SCAN_QUESTIONS[quoi]
  const sortie = await demanderOutil(cle, [image, { type: 'text', text: question }], tool)
  return json(interpretScan(quoi, sortie))
})
