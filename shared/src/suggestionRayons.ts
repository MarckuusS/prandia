/**
 * Savarin propose des rayons : "d'apres ta bibliotheque, un rayon Conserves
 * rangerait 14 produits aujourd'hui dans Epicerie".
 *
 * Le modele recoit les rayons de la cuisine et les produits de la BIBLIOTHEQUE
 * (pas le catalogue CIQUAL, que personne ne range), et propose au plus
 * `SUGGESTIONS_MAX` rayons nouveaux, chacun avec les produits qui y
 * passeraient. Rien n'est ecrit : l'ecran montre la proposition, la personne
 * coche ce qu'elle garde et cree le rayon, ou refuse.
 *
 * "Rien a proposer" est une reponse normale, et la plus frequente : une
 * proposition faible serait refusee, et apprendrait a ignorer la bulle.
 */

import type { ScanTool } from './scan.js'
import { normalizeName } from './text.js'

export const SUGGESTIONS_MAX = 3
/** Un rayon pour trois produits n'aide pas a s'y retrouver. */
export const SUGGESTION_PRODUITS_MIN = 4
/** La bibliotheque envoyee au modele, bornee : au-dela, la question coute sans rien apprendre de plus. */
export const SUGGESTION_BIBLIOTHEQUE_MAX = 400
/** Sous ce nombre de produits, il n'y a rien a structurer. */
export const SUGGESTION_BIBLIOTHEQUE_MIN = 20

export interface ProduitDeBibliotheque {
  readonly id: number
  readonly nom: string
  /** Son rayon actuel, ou null s'il n'en a pas. */
  readonly rayon: string | null
}

export interface RayonPropose {
  readonly nom: string
  /** Une phrase, adressee a la personne, qui dit pourquoi. */
  readonly raison: string
  readonly produits: readonly number[]
}

export const SUGGESTION_RAYONS_TOOL: ScanTool = {
  name: 'rayons_proposes',
  description: 'Les rayons nouveaux qui rangeraient mieux cette bibliotheque. Liste vide si la structure convient.',
  input_schema: {
    type: 'object',
    properties: {
      propositions: {
        type: 'array',
        maxItems: SUGGESTIONS_MAX,
        items: {
          type: 'object',
          properties: {
            nom: { type: 'string', description: 'Nom court du rayon, en francais, comme un panneau de supermarche.' },
            raison: { type: 'string', description: 'Une phrase qui tutoie la personne et dit ce que le rayon regroupe.' },
            produits: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Les numeros des produits qui passeraient dans ce rayon.',
            },
          },
          required: ['nom', 'raison', 'produits'],
        },
      },
    },
    required: ['propositions'],
  },
}

export function suggestionRayonsQuestion(
  rayons: readonly string[],
  produits: readonly ProduitDeBibliotheque[],
  refuses: readonly string[],
): string {
  const parRayon = new Map<string, ProduitDeBibliotheque[]>()
  for (const p of produits.slice(0, SUGGESTION_BIBLIOTHEQUE_MAX)) {
    const cle = p.rayon ?? ''
    parRayon.set(cle, [...(parRayon.get(cle) ?? []), p])
  }
  const ordre = [...rayons, ...[...parRayon.keys()].filter((r) => r !== '' && !rayons.includes(r)), '']
  const blocs = ordre
    .filter((r) => (parRayon.get(r)?.length ?? 0) > 0)
    .map((r) => {
      const liste = parRayon.get(r) ?? []
      return [`## ${r === '' ? 'Sans rayon' : r} (${liste.length})`, ...liste.map((p) => `${p.id} : ${p.nom}`)].join('\n')
    })
  const vides = rayons.filter((r) => (parRayon.get(r)?.length ?? 0) === 0)

  return [
    'Voici les rayons d’une cuisine, tels que la personne les a nommes, et les produits de sa bibliotheque ranges dans chacun. Ces rayons rangent sa liste de courses dans l’ordre ou elle parcourt le magasin.',
    'Propose au plus 3 rayons NOUVEAUX qui l’aideraient vraiment a s’y retrouver : un rayon trop large qui melange des familles qu’un supermarche francais separe (conserves, epices et condiments, pates et riz, petit-dejeuner, boulangerie, boucherie, poissonnerie, surgeles, hygiene, entretien...), ou des produits sans rayon qui forment une famille.',
    `Chaque proposition regroupe au moins ${SUGGESTION_PRODUITS_MIN} produits de la liste, par leur numero. Un nom court, comme un panneau de magasin. Une raison en une phrase, qui tutoie la personne et cite d’ou viennent les produits (par exemple : "14 de tes produits d’Epicerie sont des conserves : un rayon a part les rendrait plus faciles a trouver.").`,
    'Ne propose JAMAIS un rayon qui existe deja, meme dit autrement, ni un des rayons deja refuses. Ne propose rien plutot qu’une idee faible : une liste vide est la bonne reponse quand les rayons conviennent.',
    ...(vides.length > 0 ? [`Rayons qui existent mais sont vides dans la bibliotheque : ${vides.join(', ')}.`] : []),
    ...(refuses.length > 0 ? [`Rayons deja refuses par la personne : ${refuses.join(', ')}.`] : []),
    '',
    blocs.join('\n\n'),
  ].join('\n')
}

const MOTS_VIDES = new Set(['et', 'de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'en', 'produit', 'rayon'])

/** Les mots qui font le sens d'un nom de rayon, sans accents, articles, "produits" ni pluriel. */
function motsDuRayon(nom: string): Set<string> {
  return new Set(
    normalizeName(nom)
      .replace(/&/g, ' et ')
      .split(/[^a-z0-9]+/)
      .map((m) => (m.length > 3 ? m.replace(/[sx]$/, '') : m))
      .filter((m) => m !== '' && !MOTS_VIDES.has(m)),
  )
}

/**
 * Le rayon propose existe deja quand tous ses mots sont dans un rayon
 * existant : "Produits frais" pour "Frais", "Épices" pour "Épices &
 * condiments", "Oeufs" pour "Produits laitiers & oeufs". L'inverse reste
 * permis : "Épicerie sucrée" PRECISE "Epicerie", c'est le decoupage meme
 * qu'on attend.
 */
export function rayonDejaCouvert(propose: string, existant: string): boolean {
  const mots = motsDuRayon(propose)
  const deja = motsDuRayon(existant)
  return mots.size > 0 && [...mots].every((m) => deja.has(m))
}

/**
 * La reponse, reduite a ce qui tient : un nom de 2 a 40 caracteres qui n'est
 * ni un rayon existant ni un refus, des produits connus, chacun dans UNE seule
 * proposition, et assez de produits pour que le rayon serve.
 */
export function interpretSuggestionRayons(
  entree: unknown,
  rayons: readonly string[],
  refuses: readonly string[],
  idsConnus: ReadonlySet<number>,
): RayonPropose[] {
  if (typeof entree !== 'object' || entree === null) return []
  const brutes = (entree as { propositions?: unknown }).propositions
  if (!Array.isArray(brutes)) return []

  const pris = new Set<number>()
  const rendues: RayonPropose[] = []
  for (const brute of brutes) {
    if (rendues.length >= SUGGESTIONS_MAX) break
    if (typeof brute !== 'object' || brute === null) continue
    const { nom, raison, produits } = brute as { nom?: unknown; raison?: unknown; produits?: unknown }
    if (typeof nom !== 'string' || typeof raison !== 'string' || !Array.isArray(produits)) continue
    const nomPropre = nom.replace(/\s+/g, ' ').trim()
    if (nomPropre.length < 2 || nomPropre.length > 40) continue
    if ([...rayons, ...refuses].some((r) => rayonDejaCouvert(nomPropre, r))) continue
    if (rendues.some((r) => rayonDejaCouvert(nomPropre, r.nom) || rayonDejaCouvert(r.nom, nomPropre))) continue
    const ids = [...new Set(produits.filter((id): id is number => Number.isInteger(id) && idsConnus.has(id)))].filter(
      (id) => !pris.has(id),
    )
    if (ids.length < SUGGESTION_PRODUITS_MIN) continue
    for (const id of ids) pris.add(id)
    rendues.push({ nom: nomPropre, raison: raison.replace(/\s+/g, ' ').trim().slice(0, 240), produits: ids })
  }
  return rendues
}
