/**
 * Tout ce qui se DEDUIT d'une recette : nutrition, energie, cout, poids cuit,
 * et la mise a l'echelle temporaire des portions.
 *
 * Aucune formule n'est ecrite ici. `aggregateRecipe`, `energyBreakdown`,
 * `recipeCost` et `cookedWeightG` viennent de @prandia/shared, ou le Worker les
 * lit aussi : c'est ce qui garantit que le total affiche sur le telephone et
 * celui calcule pour la liste de courses ne peuvent pas diverger. Le desktop
 * avait la meme regle et la meme raison.
 *
 * LA subtilite de cet ecran, celle que le desktop signalait par un bandeau
 * orange : la mise a l'echelle ne touche PAS tout. Ce qui est servi a une
 * personne ne change pas quand on cuisine pour huit au lieu de quatre.
 *
 *   mis a l'echelle : quantites affichees, totaux, cout total, poids cuit
 *   invariant       : par portion (nutrition et cout), pour 100 g
 */

import { useMemo } from 'react'
import {
  aggregateRecipe,
  cookedWeightG,
  energyBreakdown,
  formatEuros,
  formatGrams,
  recipeCost,
  type NutritionTotal,
  type RecipeCost,
  type RecipeLine,
} from '@prandia/shared'

import { MacrosRing } from '../../components/MacrosDonut.js'
import { NutrientLabel } from '../../components/NutrientLabel.js'
import { Icon } from '../../icons/index.js'
import { massShare } from '../semaine/totals.js'
import { formatNumber, plural, scaleLines, toRecipeLines, type RecipeDraft } from './draft.js'

// ---------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------

export interface Derived {
  /** Facteur de mise a l'echelle. Vaut 1 quand l'utilisateur n'a rien force. */
  readonly ratio: number
  readonly isScaled: boolean
  /** Portions effectivement affichees — celles de la recette, sauf override. */
  readonly displayedPortions: number
  readonly total: NutritionTotal
  readonly perPortion: NutritionTotal
  readonly per100g: NutritionTotal
  /** Masse crue totale, deja mise a l'echelle. */
  readonly totalWeightG: number
  readonly unknownMacroLines: number
  readonly cost: RecipeCost
  /** Cout total mis a l'echelle. Le cout par portion, lui, vit dans `cost`. */
  readonly scaledCostTotal: RecipeCost['total']
  /** Masse servie apres cuisson, deja mise a l'echelle. */
  readonly cookedWeightTotalG: number
  /** Vrai des qu'un ingredient renseigne son ratio de cuisson : sinon on affiche du cru. */
  readonly hasCookingRatio: boolean
}

/**
 * Les deux agregations sont faites sur DEUX jeux de lignes, l'un mis a
 * l'echelle et l'autre non, plutot qu'en multipliant les totaux apres coup.
 * C'est ce qui evite de reecrire une regle de trois par grandeur derivee — et
 * la division par le nombre de portions reste celle de @prandia/shared.
 */
export function useDerived(draft: RecipeDraft, displayPortions: number | null): Derived {
  return useMemo(() => {
    const portions = Math.max(1, Math.round(draft.defaultPortions))
    const displayedPortions = displayPortions ?? portions
    const ratio = displayedPortions / portions

    const rawLines = toRecipeLines(draft.lines)
    const scaled: RecipeLine[] = scaleLines(rawLines, ratio)

    const base = aggregateRecipe({ lines: rawLines, defaultPortions: portions })
    const scaledAgg =
      ratio === 1 ? base : aggregateRecipe({ lines: scaled, defaultPortions: portions })

    const cost = recipeCost({ lines: rawLines, defaultPortions: portions })
    const scaledCost = ratio === 1 ? cost : recipeCost({ lines: scaled, defaultPortions: portions })

    return {
      ratio,
      isScaled: ratio !== 1,
      displayedPortions,
      total: scaledAgg.total,
      perPortion: base.perPortion,
      // Invariant par construction : numerateur et denominateur sont mis a
      // l'echelle ensemble. On prend malgre tout la version non mise a
      // l'echelle, qui evite d'accumuler l'erreur du flottant.
      per100g: base.per100g,
      totalWeightG: scaledAgg.totalWeightG,
      unknownMacroLines: base.linesWithUnknownMacros.length,
      cost,
      scaledCostTotal: scaledCost.total,
      cookedWeightTotalG: scaled.reduce(
        (sum, line) => sum + cookedWeightG(line.ingredient, line.quantityG),
        0,
      ),
      hasCookingRatio: rawLines.some((line) => line.ingredient.cookedWeightPer100gRaw !== null),
    }
  }, [draft.lines, draft.defaultPortions, displayPortions])
}

// ---------------------------------------------------------------------------
// Mise a l'echelle
// ---------------------------------------------------------------------------

/** Ordre et decimales du reglement UE 1169/2011, repris tel quel du desktop. */
const NUTRIENT_ROWS: ReadonlyArray<{
  readonly label: string
  readonly key: keyof NutritionTotal
  readonly unit: string
  readonly decimals: number
  readonly sub?: boolean
  readonly color?: string
}> = [
  { label: 'Énergie', key: 'kcal', unit: 'kcal', decimals: 0, color: 'energy' },
  { label: 'Lipides', key: 'fats', unit: 'g', decimals: 1, color: 'fats' },
  { label: 'dont saturés', key: 'saturatedFats', unit: 'g', decimals: 1, sub: true, color: 'saturated' },
  { label: 'Glucides', key: 'carbs', unit: 'g', decimals: 1, color: 'carbs' },
  { label: 'dont sucres', key: 'sugars', unit: 'g', decimals: 1, sub: true, color: 'sugars' },
  { label: 'Fibres', key: 'fiber', unit: 'g', decimals: 1, color: 'fiber' },
  { label: 'Protéines', key: 'proteins', unit: 'g', decimals: 1, color: 'proteins' },
  { label: 'Sel', key: 'salt', unit: 'g', decimals: 2, color: 'salt' },
]

/**
 * L'anneau PUIS le tableau, dans UNE SEULE carte.
 *
 * L'ordre est une regle du projet, pas une preference de mise en page : la
 * figure montre, le tableau chiffre ce qu'elle montre. Le tableau vivait ici et
 * l'anneau dans une carte separee EN DESSOUS, ce qui inversait la lecture et
 * laissait deux cartes blanches dire la meme chose.
 *
 * LA COLONNE "PART" EST LA DEUXIEME, entre le nom et les trois echelles, et
 * cette place est raisonnee. Les trois echelles forment une famille ; la part
 * n'en fait pas partie, puisqu'elle est la MEME pour les trois : une proportion
 * de masse ne change pas quand on divise par le nombre de portions. La poser en
 * cinquieme colonne l'aurait de plus rejetee hors de l'ecran, ce tableau
 * defilant deja horizontalement sur un telephone.
 */
export function NutritionCard({ derived }: { readonly derived: Derived }) {
  const columns: ReadonlyArray<readonly [string, NutritionTotal]> = [
    ['Pour 100 g', derived.per100g],
    ['Par portion', derived.perPortion],
    ['Recette entière', derived.total],
  ]

  return (
    <div className="card">
      <h3 className="card__title">Valeurs nutritionnelles</h3>

      {/* Le nombre au centre est celui des 100 g ; les ARCS, eux, valent pour
          les trois echelles a la fois. */}
      <MacrosRing total={derived.per100g} centerCaption="kcal / 100 g" />

      <div className="table-scroll">
        <table className="nutrition-table nutrition-table--macros">
          <thead>
            <tr>
              <th scope="col">Pour</th>
              <th scope="col">Part</th>
              {columns.map(([label]) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NUTRIENT_ROWS.map((row) => (
              <tr key={row.key} className={row.sub ? 'nutrition-table__row--sub' : undefined}>
                {/* Le meme composant que l'ecran Semaine. Deux tableaux qui
                    disent la meme chose ne doivent pas la dire differemment :
                    ici c'etait une pastille de couleur, la-bas le pictogramme
                    du nutriment. */}
                <th scope="row">
                  <NutrientLabel nutrient={row.key} label={row.label} sub={row.sub ?? false} />
                </th>
                {/* Vide pour l'energie, le sel et les sous-lignes : l'energie
                    EST le total, le sel n'appartient a aucune des quatre
                    familles, et sucres et satures sont deja comptes dans la
                    leur. Leur donner une part ferait une colonne qui ne
                    totalise pas 100. */}
                <td className="nutrition-table__part">
                  {massShare(derived.per100g, row.key)}
                </td>
                {columns.map(([label, totals]) => (
                  <td key={label}>
                    {formatNumber(totals[row.key], row.decimals)}
                    <span className="unit"> {row.unit}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <WeightNote derived={derived} />

      {derived.unknownMacroLines > 0 && (
        <p className="note">
          {derived.unknownMacroLines} {plural(derived.unknownMacroLines, 'ingrédient')}{' '}
          {plural(derived.unknownMacroLines, 'a', 'ont')} des valeurs manquantes : ces totaux sont
          sous-estimés.
        </p>
      )}

      <EnergyNote total={derived.total} />
    </div>
  )
}

/**
 * Le desktop mettait cette estimation en sous-titre de colonne. En 375 px les
 * colonnes n'ont pas la place : l'information passe sous le tableau, ou elle se
 * lit d'ailleurs mieux.
 */
function WeightNote({ derived }: { readonly derived: Derived }) {
  if (derived.totalWeightG <= 0) return null
  const perPortion = derived.cookedWeightTotalG / Math.max(1, derived.displayedPortions)
  return (
    <p className="note">
      {formatGrams(derived.totalWeightG)} d’ingrédients crus, soit{' '}
      {derived.hasCookingRatio ? '≈ ' : ''}
      {formatGrams(Math.round(derived.cookedWeightTotalG))}{' '}
      {derived.hasCookingRatio ? 'une fois cuits' : 'servis'} — {formatGrams(Math.round(perPortion))}{' '}
      par portion.
      {!derived.hasCookingRatio &&
        ' Aucun ingrédient ne renseigne son gain de cuisson : le poids cuit est estimé à l’identique.'}
    </p>
  )
}

/**
 * Signale l'ecart entre l'energie declaree et celle recalculee par Atwater.
 *
 * Le desktop affichait la valeur recalculee au centre du donut et la valeur
 * declaree dans le tableau juste a cote, sans jamais dire qu'elles different.
 */
function EnergyNote({ total }: { readonly total: NutritionTotal }) {
  const breakdown = energyBreakdown(total)
  if (breakdown.divergence < 0.1) return null
  return (
    <p className="note">
      Le calcul à partir des macros donne {Math.round(breakdown.atwaterKcal)} kcal, contre{' '}
      {Math.round(breakdown.declaredKcal)} kcal mesurées. L’écart vient des données source — les
      valeurs affichées sont celles mesurées.
    </p>
  )
}

// ---------------------------------------------------------------------------
// Cout
// ---------------------------------------------------------------------------

export function CostCard({ derived }: { readonly derived: Derived }) {
  const missing = derived.cost.missing.length
  return (
    <div className={`card${derived.isScaled ? ' card--scaled' : ''}`}>
      <h3 className="card__title">Coût</h3>
      <dl className="kv">
        <div className="kv__pair">
          <dt>{derived.isScaled ? `Total pour ${derived.displayedPortions} portions` : 'Total'}</dt>
          <dd>{formatEuros(derived.scaledCostTotal)}</dd>
        </div>
        <div className="kv__pair">
          <dt>Par portion</dt>
          <dd>{formatEuros(derived.cost.perPortion)}</dd>
        </div>
      </dl>
      {missing > 0 && (
        <p className="note note--warning">
          <Icon name="ui-alert" size={14} className="icon--inline" /> {missing}{' '}
          {plural(missing, 'ingrédient')} sans prix, {plural(missing, 'exclu')} du total.
        </p>
      )}
    </div>
  )
}
