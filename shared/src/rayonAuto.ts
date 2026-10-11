/**
 * Ranger un produit dans un rayon, par un modele de langage (Claude Haiku).
 *
 * Un produit cree depuis un code-barres, le chariot ou un import arrive sans
 * rayon : sans couleur, sans icone, au fond de "Sans rayon" ou "Autres". Le
 * modele recoit le nom et la marque, et la liste des rayons DE LA CUISINE,
 * tels que la personne les a nommes. Il ne peut repondre qu'un de ces noms,
 * ou rien : l'outil porte la liste en `enum`, et `interpretClassement` la
 * reverifie. Un rayon invente creerait une categorie que l'ecran des rayons
 * ne connait pas.
 *
 * Pourquoi pas les categories d'OpenFoodFacts d'abord. Elles disent
 * "en:yogurts", pas "Produits laitiers & oeufs" : il faudrait de toute facon
 * traduire vers les rayons de cette cuisine, ce que fait le modele. A trois
 * millimes de centime le produit, une seconde mecanique n'en valait pas la
 * peine.
 *
 * Un appel range jusqu'a `RANGEMENT_MAX` produits a la fois : la liste des
 * rayons n'est payee qu'une fois.
 */

import type { ScanTool } from './scan.js'
import { normalizeName } from './text.js'

export const RANGEMENT_MAX = 40

export interface ProduitARanger {
  readonly id: number
  readonly nom: string
  readonly marque: string | null
}

export function rayonTool(rayons: readonly string[]): ScanTool {
  return {
    name: 'rayons_choisis',
    description: 'Range chaque produit dans un rayon de la liste, ou null si aucun ne convient.',
    input_schema: {
      type: 'object',
      properties: {
        classement: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              rayon: { type: ['string', 'null'], enum: [...rayons, null] },
            },
            required: ['id', 'rayon'],
          },
        },
      },
      required: ['classement'],
    },
  }
}

export function rayonQuestion(rayons: readonly string[], produits: readonly ProduitARanger[]): string {
  const liste = rayons.map((r) => `- ${r}`).join('\n')
  const lignes = produits.map((p) => `${p.id} : ${p.nom}${p.marque ? ` (${p.marque})` : ''}`).join('\n')
  return [
    'Voici les rayons d’une cuisine, tels que la personne les a nommes :',
    liste,
    '',
    'Range chaque produit ci-dessous dans le rayon ou on le chercherait en magasin. Reponds avec exactement un nom de la liste. Si aucun ne convient vraiment, rayon vaut null.',
    '',
    lignes,
  ].join('\n')
}

/**
 * Le classement rendu, reduit a ce qui est sur : un identifiant demande, un
 * rayon qui existe (casse et accents pres, rendu sous son nom exact).
 */
export function interpretClassement(
  entree: unknown,
  rayons: readonly string[],
  ids: readonly number[],
): Map<number, string> {
  const parNom = new Map(rayons.map((r) => [normalizeName(r), r]))
  const attendus = new Set(ids)
  const resultat = new Map<number, string>()
  const classement = (entree !== null && typeof entree === 'object' ? (entree as Record<string, unknown>)['classement'] : null)
  if (!Array.isArray(classement)) return resultat
  for (const ligne of classement) {
    if (ligne === null || typeof ligne !== 'object') continue
    const { id, rayon } = ligne as Record<string, unknown>
    if (typeof id !== 'number' || !attendus.has(id) || typeof rayon !== 'string') continue
    const exact = parNom.get(normalizeName(rayon))
    if (exact !== undefined) resultat.set(id, exact)
  }
  return resultat
}
