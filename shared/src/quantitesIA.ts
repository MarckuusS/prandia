/**
 * Estimer en grammes, par Claude, les quantites qu'un site ne donne pas en
 * poids : "1/2 sachet de romarin seche", "1/4 de pot de creme", "1 piece",
 * "sel, poivre".
 *
 * Les regles de `importAmount` (une gousse 5 g, un sachet 10 g, un pot 125 g)
 * donnent un ordre de grandeur sans rien savoir de la recette. Le modele, lui,
 * recoit la recette ENTIERE (titre, portions, site, toutes les lignes) et juge
 * a la coherence : un demi-sachet de romarin d'un kit pese quelques grammes,
 * un demi-pot de creme pour deux portions fait autour de 75 g. Les sites de
 * kits livrent des sachets et des pots a la portion, plus petits que ceux du
 * commerce : la consigne le dit.
 *
 * Ce qui ne se devine pas :
 *   - RIEN N'EST ECRIT : la revue d'import montre la valeur, encadree comme
 *     tout ce que l'IA remplit, et la personne la corrige avant de creer ;
 *   - les lignes sont numerotees a partir de 1 pour le modele (c'est ainsi
 *     qu'il les lit) et rendues par leur INDEX a l'ecran ; `interpretQuantites`
 *     fait la conversion et ne rend que les lignes demandees ;
 *   - hors de 0,1 g a 5 kg, l'estimation n'est pas gardee : la ligne garde la
 *     valeur supposee par les regles, et son "a verifier".
 */

import type { ScanTool } from './scan.js'

/** Lignes a estimer par appel : une recette en compte rarement plus de vingt. */
export const QUANTITES_MAX = 40
export const GRAMMES_IA_MIN = 0.1
export const GRAMMES_IA_MAX = 5000

export interface LigneAEstimer {
  /** Index de la ligne dans la recette (a partir de 0). */
  readonly index: number
  /** La fiche retenue pour la ligne, quand il y en a une : elle precise le produit. */
  readonly fiche: string | null
  /** Ce que pese une unite vendue de cette fiche, quand on le sait. */
  readonly contenanceG: number | null
}

export interface RecettePourIA {
  readonly titre: string
  readonly portions: number | null
  readonly site: string | null
  /** Toutes les lignes, telles qu'ecrites : la coherence se lit sur l'ensemble. */
  readonly lignes: readonly string[]
  readonly aEstimer: readonly LigneAEstimer[]
}

export const QUANTITES_TOOL: ScanTool = {
  name: 'quantites_estimees',
  description: 'Le poids en grammes de chaque ligne demandee, dans cette recette, ou null.',
  input_schema: {
    type: 'object',
    properties: {
      estimations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ligne: { type: 'integer', description: 'Le numero de la ligne, tel que donne.' },
            grammes: { type: ['number', 'null'] },
          },
          required: ['ligne', 'grammes'],
        },
      },
    },
    required: ['estimations'],
  },
}

export function quantitesQuestion(recette: RecettePourIA): string {
  const toutes = recette.lignes.map((ligne, i) => `${i + 1}. ${ligne}`).join('\n')
  const demandees = recette.aEstimer
    .map((a) => {
      const produit =
        a.fiche === null
          ? ''
          : ` (produit retenu : ${a.fiche}${a.contenanceG !== null ? `, vendu par ${a.contenanceG} g` : ''})`
      return `${a.index + 1}${produit}`
    })
    .join('\n')
  const entete = [
    `Recette "${recette.titre}"`,
    recette.portions !== null ? `pour ${recette.portions} portions` : null,
    recette.site !== null ? `publiee par ${recette.site}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(', ')
  return [
    `${entete}. Ses lignes d’ingredients, telles qu’ecrites :`,
    toutes,
    '',
    'Pour les lignes listees plus bas, la quantite n’est pas donnee en poids (fraction de sachet ou de pot, piece, pincee, ou rien du tout). Estime en grammes ce que la ligne represente DANS CETTE RECETTE.',
    'Raisonne sur la coherence : un demi-sachet de romarin seche pese quelques grammes, pas un kilo ; un demi-pot de creme pour deux portions fait autour de 75 g. Les sites de kits a cuisiner (HelloFresh, Quitoque, Marley Spoon) livrent des sachets et des pots a la portion, plus petits que ceux du commerce. Tiens compte du nombre de portions et des autres quantites de la recette.',
    'null seulement si la ligne ne permet aucune estimation.',
    '',
    'Lignes a estimer :',
    demandees,
  ].join('\n')
}

/**
 * Les estimations sures, par INDEX de ligne : un numero demande, un poids
 * dans ses bornes, arrondi a ce qui se pese (le dixieme sous 10 g, le gramme
 * au-dessus).
 */
export function interpretQuantites(entree: unknown, indexes: readonly number[]): Map<number, number> {
  const attendus = new Set(indexes)
  const resultat = new Map<number, number>()
  const estimations =
    entree !== null && typeof entree === 'object' ? (entree as Record<string, unknown>)['estimations'] : null
  if (!Array.isArray(estimations)) return resultat
  for (const e of estimations) {
    if (e === null || typeof e !== 'object') continue
    const { ligne, grammes } = e as Record<string, unknown>
    if (typeof ligne !== 'number' || !Number.isInteger(ligne)) continue
    const index = ligne - 1
    if (!attendus.has(index) || resultat.has(index)) continue
    if (typeof grammes !== 'number' || !Number.isFinite(grammes)) continue
    if (grammes < GRAMMES_IA_MIN || grammes > GRAMMES_IA_MAX) continue
    resultat.set(index, grammes < 10 ? Math.round(grammes * 10) / 10 : Math.round(grammes))
  }
  return resultat
}
