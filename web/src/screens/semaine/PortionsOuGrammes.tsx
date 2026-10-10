/**
 * Servir une recette en portions OU en grammes.
 *
 * Une entree recette ne stocke que des PORTIONS : c'est la regle XOR du
 * planning, et c'est ce que lisent tous les calculs. Les grammes sont donc
 * convertis a la saisie par le poids cuit d'une portion
 * (`cookedGramsPerPortion`, le meme calcul que le poids cuit de la fiche
 * recette). L'unite `g` est enregistree a cote, exactement comme pour un
 * ingredient (migration 0011), pour que le repas se relise et se rouvre en
 * grammes au lieu de "0,85 portion".
 *
 * Le mode Grammes n'est offert que si la recette pese quelque chose : sans
 * ligne, il n'y a rien a diviser.
 */

import { cookedGramsPerPortion, formatGrams, type Recipe } from '@prandia/shared'

import { NumberField } from '../../components/Field.js'
import { UNITE_GRAMMES } from './totals.js'

/** Bornes du modele, en portions : celles du champ Portions. */
const PORTIONS_MIN = 0.25
const PORTIONS_MAX = 50

const formatPortions = (portions: number): string =>
  `${portions.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} portion${portions >= 2 ? 's' : ''}`

export interface PortionsOuGrammesProps {
  /** La recette COMPLETE, lignes et ingredients compris ; `undefined` le temps du chargement. */
  readonly recipe: Recipe | undefined
  readonly defaultPortions: number
  readonly portions: number | null
  readonly onPortions: (portions: number | null) => void
  readonly unit: string | null
  readonly onUnit: (unit: string | null) => void
  readonly disabled?: boolean | undefined
}

export function PortionsOuGrammes({
  recipe,
  defaultPortions,
  portions,
  onPortions,
  unit,
  onUnit,
  disabled,
}: PortionsOuGrammesProps) {
  const parPortion = recipe === undefined ? null : cookedGramsPerPortion(recipe)
  const enGrammes = unit === UNITE_GRAMMES && parPortion !== null

  return (
    <>
      <div className="segmented" role="group" aria-label="Quantité servie">
        <button
          type="button"
          className={`segmented__tab${enGrammes ? '' : ' segmented__tab--active'}`}
          aria-pressed={!enGrammes}
          onClick={() => onUnit(null)}
          disabled={disabled}
        >
          Portions
        </button>
        <button
          type="button"
          className={`segmented__tab${enGrammes ? ' segmented__tab--active' : ''}`}
          aria-pressed={enGrammes}
          onClick={() => onUnit(UNITE_GRAMMES)}
          disabled={disabled === true || parPortion === null}
        >
          Grammes
        </button>
      </div>

      {enGrammes ? (
        <NumberField
          label="Quantité"
          required
          suffix="g"
          // Arrondi au gramme a l'affichage seulement : les portions gardent
          // toute leur precision, sans quoi 350 g se rouvriraient en 349.
          value={portions === null ? null : Math.round(portions * parPortion)}
          onChange={(grammes) => onPortions(grammes === null ? null : grammes / parPortion)}
          min={Math.max(1, Math.ceil(PORTIONS_MIN * parPortion))}
          max={Math.floor(PORTIONS_MAX * parPortion)}
          decimals={0}
          disabled={disabled}
          hint={`${portions !== null && portions > 0 ? `Soit ${formatPortions(portions)}. ` : ''}Une portion pèse ${formatGrams(parPortion)} une fois cuite.`}
        />
      ) : (
        <NumberField
          label="Portions"
          required
          value={portions}
          onChange={onPortions}
          min={PORTIONS_MIN}
          max={PORTIONS_MAX}
          decimals={2}
          disabled={disabled}
          hint={`De 0,25 à 50 portions. La recette est prévue pour ${defaultPortions}.`}
        />
      )}

      {recipe !== undefined && parPortion === null && (
        <p className="field__hint">
          Cette recette n’a pas encore d’ingrédients : elle ne se dose qu’en portions.
        </p>
      )}
    </>
  )
}
