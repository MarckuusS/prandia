/**
 * Completer une fiche par un modele de langage (Claude Haiku) : son rayon, son
 * poids cuit, ses mois de saison.
 *
 * Trois champs qu'on ne remplit presque jamais a la main, faute de les savoir
 * par coeur, et que le modele connait pour un produit courant. Un seul appel
 * pour les trois, et pour quarante produits a la fois : la liste des rayons
 * et les consignes ne sont payees qu'une fois.
 *
 * Ce qui ne se devine pas :
 *   - la reponse ne REMPLIT QUE LES CHAMPS VIDES. Une valeur saisie par la
 *     personne n'est jamais remplacee (c'est le depot qui y veille, dans la
 *     requete meme, pour qu'une saisie faite pendant l'appel l'emporte) ;
 *   - le rayon est ferme sur les rayons DE LA CUISINE (`enum`, puis revu par
 *     `interpretCompletion`) : un rayon invente creerait une categorie que
 *     l'ecran des rayons ne connait pas ;
 *   - "dans le doute, null" est la consigne, et les bornes la font tenir : un
 *     poids cuit hors de 20 a 800 g, ou sans ecart avec le cru, n'est pas
 *     garde ; une saison de douze mois n'en est pas une (le badge "de saison"
 *     s'allumerait toute l'annee), elle redevient null.
 */

import type { ScanTool } from './scan.js'
import { normalizeName } from './text.js'

/** Produits par appel : au-dela, la reponse s'allonge sans rien economiser. */
export const COMPLETION_MAX = 40

export interface ProduitACompleter {
  readonly id: number
  readonly nom: string
  readonly marque: string | null
}

/** Ce que le modele propose pour un produit ; `null` = rien de sur. */
export interface Completion {
  readonly rayon: string | null
  /** Poids, en grammes, de 100 g de cru une fois cuit. */
  readonly poidsCuitG: number | null
  /** Mois de saison (1 a 12), tries ; `null` hors saisonnalite. */
  readonly moisSaison: readonly number[] | null
}

/** Bornes d'un poids cuit plausible : une viande perd un quart, un riz triple. */
export const POIDS_CUIT_MIN = 20
export const POIDS_CUIT_MAX = 800

export function completionTool(rayons: readonly string[]): ScanTool {
  const champs: Record<string, unknown> = {
    id: { type: 'integer' },
    poids_cuit: {
      type: ['number', 'null'],
      description: 'Grammes atteints par 100 g de cet aliment cru apres sa cuisson habituelle, ou null.',
    },
    mois_saison: {
      type: ['array', 'null'],
      items: { type: 'integer', minimum: 1, maximum: 12 },
      description: 'Mois ou le produit frais est de saison en France, ou null.',
    },
  }
  // Une cuisine sans rayon ne se voit pas demander de rayon : la seule
  // reponse possible serait "aucun".
  if (rayons.length > 0) champs['rayon'] = { type: ['string', 'null'], enum: [...rayons, null] }
  return {
    name: 'fiches_completees',
    description: 'Complete chaque produit : rayon, poids cuit, mois de saison. null quand on ne sait pas.',
    input_schema: {
      type: 'object',
      properties: {
        fiches: {
          type: 'array',
          items: { type: 'object', properties: champs, required: Object.keys(champs) },
        },
      },
      required: ['fiches'],
    },
  }
}

export function completionQuestion(rayons: readonly string[], produits: readonly ProduitACompleter[]): string {
  const lignes = produits.map((p) => `${p.id} : ${p.nom}${p.marque ? ` (${p.marque})` : ''}`).join('\n')
  const partieRayon =
    rayons.length > 0
      ? [
          'Voici les rayons d’une cuisine, tels que la personne les a nommes :',
          ...rayons.map((r) => `- ${r}`),
          '',
          'rayon : celui ou l’on chercherait le produit en magasin, exactement un nom de la liste. Si aucun ne convient vraiment, null.',
        ]
      : []
  return [
    ...partieRayon,
    'poids_cuit : le poids en grammes qu’atteignent 100 g de l’aliment CRU apres sa cuisson habituelle (riz blanc : environ 300 ; pates : environ 230 ; lentilles : environ 250 ; viande : environ 75). null si l’aliment se mange tel quel, s’il est deja cuit ou transforme (yaourt, fromage, pain, conserve, plat prepare, boisson, condiment), ou si la cuisson ne change pas notablement son poids.',
    'mois_saison : les mois (1 a 12) ou le produit FRAIS est de saison en France metropolitaine : fruits, legumes, champignons, certains poissons et fruits de mer. null pour un produit disponible toute l’annee ou transforme (epicerie, conserve, surgele, laitage, viande, boisson).',
    'Dans le doute, null : un champ vide vaut mieux qu’une valeur fausse.',
    '',
    lignes,
  ].join('\n')
}

function poidsCuit(valeur: unknown): number | null {
  if (typeof valeur !== 'number' || !Number.isFinite(valeur)) return null
  if (valeur < POIDS_CUIT_MIN || valeur > POIDS_CUIT_MAX) return null
  // Sans ecart avec le cru, le champ n'apprend rien et ferait proposer une
  // saisie "en cuit" inutile.
  if (Math.abs(valeur - 100) < 5) return null
  return Math.round(valeur * 10) / 10
}

function moisSaison(valeur: unknown): number[] | null {
  if (!Array.isArray(valeur)) return null
  const mois = [...new Set(valeur.filter((m): m is number => Number.isInteger(m) && m >= 1 && m <= 12))].sort(
    (a, b) => a - b,
  )
  return mois.length === 0 || mois.length === 12 ? null : mois
}

/**
 * La reponse, reduite a ce qui est sur : un identifiant demande, un rayon qui
 * existe (casse et accents pres, rendu sous son nom exact), un poids et des
 * mois dans leurs bornes.
 *
 * Un produit DONT LA LIGNE EST PRESENTE est rendu meme quand tout y est null :
 * le modele a ete interroge, il n'a rien de sur, on ne le reinterrogera pas.
 * Un produit absent de la reponse (coupee) n'est pas rendu, et le sera au
 * prochain passage.
 */
export function interpretCompletion(
  entree: unknown,
  rayons: readonly string[],
  ids: readonly number[],
): Map<number, Completion> {
  const parNom = new Map(rayons.map((r) => [normalizeName(r), r]))
  const attendus = new Set(ids)
  const resultat = new Map<number, Completion>()
  const fiches = entree !== null && typeof entree === 'object' ? (entree as Record<string, unknown>)['fiches'] : null
  if (!Array.isArray(fiches)) return resultat
  for (const ligne of fiches) {
    if (ligne === null || typeof ligne !== 'object') continue
    const champs = ligne as Record<string, unknown>
    const id = champs['id']
    if (typeof id !== 'number' || !attendus.has(id) || resultat.has(id)) continue
    const rayon = champs['rayon']
    resultat.set(id, {
      rayon: typeof rayon === 'string' ? (parNom.get(normalizeName(rayon)) ?? null) : null,
      poidsCuitG: poidsCuit(champs['poids_cuit']),
      moisSaison: moisSaison(champs['mois_saison']),
    })
  }
  return resultat
}

/** Les mois tels que les stocke `season_months` : "6,7,8,9". */
export function moisCsv(mois: readonly number[] | null): string | null {
  return mois === null || mois.length === 0 ? null : mois.join(',')
}

const NOMS_MOIS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const

const nomMois = (m: number) => NOMS_MOIS[m - 1] ?? String(m)
const deMois = (m: number) => (/^[aeiouyéèêàâîôû]/i.test(nomMois(m)) ? `d’${nomMois(m)}` : `de ${nomMois(m)}`)

/**
 * La saison en clair : "de juin à septembre", "d’octobre à mars" (a cheval sur
 * l'annee), ou la liste des mois quand ils ne se suivent pas.
 */
export function saisonLisible(mois: readonly number[]): string {
  const tries = [...new Set(mois)].filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b)
  if (tries.length === 0) return ''
  if (tries.length === 1) return `en ${nomMois(tries[0] ?? 1)}`
  // Une plage continue, eventuellement a cheval sur decembre et janvier : on
  // cherche le mois de depart, celui dont le precedent n'est pas de saison.
  const dedans = new Set(tries)
  const departs = tries.filter((m) => !dedans.has(m === 1 ? 12 : m - 1))
  if (departs.length === 1) {
    const debut = departs[0] ?? 1
    const fin = ((debut - 1 + tries.length - 1) % 12) + 1
    return `${deMois(debut)} à ${nomMois(fin)}`
  }
  return tries.map(nomMois).join(', ')
}
