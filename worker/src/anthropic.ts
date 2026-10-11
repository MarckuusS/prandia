/**
 * Interroger Claude, pour la lecture des etiquettes et le rangement par rayon.
 *
 * Un seul endroit pour la cle, le modele, le plafond quotidien et la traduction
 * des erreurs : deux copies de ce code finiraient par ne pas dire la meme chose
 * quand les credits sont epuises.
 *
 * Ce qui ne se devine pas :
 *   - la cle est un SECRET de Pages (`ANTHROPIC_API_KEY`), jamais dans le
 *     depot, qui est public ;
 *   - la reponse passe par un OUTIL a schema force (`tool_choice`) : le modele
 *     ne peut rendre que la forme attendue, que l'appelant verifie encore ;
 *   - le corps d'erreur d'Anthropic ne sort jamais tel quel : il peut citer
 *     l'organisation. On n'en garde que la nature.
 */

import type { ScanTool } from '@prandia/shared'
import { parisClock } from '@prandia/shared'

import { HttpError, type Env } from './http.js'
import type { Repositories } from './repos/index.js'

/** Le plus petit modele : lire une date ou choisir un rayon ne demande pas plus. */
export const MODELE_LECTURE = 'claude-haiku-5-5'

/** Bien au-dela d'un usage reel (500 par mois), bien en deca d'une fuite. */
export const APPELS_PAR_JOUR_MAX = 150

const CLE_COMPTEUR = 'scan.compteur'

/** La cle, ou une erreur qui dit que la lecture n'est pas configuree. */
export function cleClaude(env: Env): string {
  const cle = env.ANTHROPIC_API_KEY
  if (cle === undefined || cle === '') {
    throw new HttpError(503, 'scan_unconfigured', 'La lecture des étiquettes n’est pas encore configurée.')
  }
  return cle
}

/**
 * Compte un appel AVANT de le faire : un appel qui echoue a quand meme pu
 * couter, et un bouton bloque en boucle ne doit pas passer outre. Le vrai
 * garde-fou reste le plafond de depense de l'espace de travail Anthropic.
 */
export async function compterAppel(repos: Repositories): Promise<void> {
  const jour = parisClock(new Date()).day
  const compteur = await repos.settings.getJson<{ jour: string; n: number }>(CLE_COMPTEUR, { jour, n: 0 })
  const deja = compteur.jour === jour ? compteur.n : 0
  if (deja >= APPELS_PAR_JOUR_MAX) {
    throw new HttpError(429, 'scan_quota', 'Trop de lectures aujourd’hui. Saisis à la main, ça repart demain.')
  }
  await repos.settings.setJson(CLE_COMPTEUR, { jour, n: deja + 1 })
}

/**
 * Un message, un outil impose, et ce que le modele a passe a l'outil (a
 * verifier par l'appelant). `contenu` est la liste des blocs du message :
 * une image et une question, ou une question seule.
 */
export async function demanderOutil(
  cle: string,
  contenu: readonly unknown[],
  tool: ScanTool,
  maxTokens = 300,
): Promise<unknown> {
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
        model: MODELE_LECTURE,
        max_tokens: maxTokens,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: contenu }],
      }),
      signal: AbortSignal.timeout(25_000),
    })
  } catch {
    throw new HttpError(502, 'scan_unreachable', 'Le service de lecture ne répond pas. Réessaie.')
  }

  if (!reponse.ok) {
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
  return corps.content?.find((bloc) => bloc.type === 'tool_use')?.input
}
