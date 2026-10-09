/**
 * Champ de quantite — nombre + unite, portage de QuantityField.qml.
 *
 * LA regle, celle qui tient tout le modele de donnees : la valeur remontee est
 * TOUJOURS en grammes, quelle que soit l'unite affichee. L'unite n'est que du
 * confort de saisie, restituee au rechargement via `recipe_ingredient.unit`.
 * Changer d'unite ne change donc jamais la masse : 1000 g bascule en kg et
 * affiche 1.
 *
 * Piece-aware : quand l'ingredient porte un `pieceWeightG` (1 oeuf ~ 60 g),
 * une entree « pièce (60 g) » apparait EN TETE du menu et devient l'unite par
 * defaut. C'est ainsi que l'utilisateur pense sa recette — « 2 oeufs », pas
 * « 120 g d'oeufs ».
 *
 * Les facteurs de conversion viennent de @prandia/shared/units, jamais d'une
 * table recopiee ici : le desktop en avait deux copies, une en Python et une
 * en QML, et l'import de recette par URL traitait une piece comme un gramme.
 */

import { useMemo, useState } from 'react'
import {
  DEFAULT_UNIT_CODE,
  PIECE_UNIT_CODE,
  UNITS,
  fromGrams,
  isKnownUnit,
  labelFor,
  toGrams,
} from '@prandia/shared'

import { FieldShell, useDecimalInput, useFieldIds } from './Field.js'

/**
 * Unite a selectionner, dans l'ordre de priorite : le choix explicite du
 * parent, puis la piece quand elle existe, puis le gramme.
 */
function resolveUnit(
  preferred: string | null | undefined,
  pieceWeightG: number | null | undefined,
): string {
  const hasPiece = typeof pieceWeightG === 'number' && pieceWeightG > 0
  if (preferred) {
    if (preferred === PIECE_UNIT_CODE) {
      if (hasPiece) return PIECE_UNIT_CODE
    } else if (isKnownUnit(preferred)) {
      return preferred
    }
  }
  return hasPiece ? PIECE_UNIT_CODE : DEFAULT_UNIT_CODE
}

/**
 * Unite reellement utilisable ici et maintenant.
 *
 * Le parent peut changer d'ingredient sans changer d'unite : l'unite « pièce »
 * survit alors un rendu de trop a un `pieceWeightG` devenu nul, et `fromGrams`
 * leve. On retombe sur le gramme le temps que la resynchronisation ci-dessous
 * choisisse la bonne unite.
 */
function usableUnit(unitCode: string, pieceWeightG: number | null | undefined): string {
  if (unitCode === PIECE_UNIT_CODE) {
    return typeof pieceWeightG === 'number' && pieceWeightG > 0
      ? PIECE_UNIT_CODE
      : DEFAULT_UNIT_CODE
  }
  return isKnownUnit(unitCode) ? unitCode : DEFAULT_UNIT_CODE
}

/** Masse -> valeur affichee dans l'unite courante. `null` reste `null`. */
function toDisplay(
  grams: number | null,
  unitCode: string,
  pieceWeightG: number | null | undefined,
): number | null {
  if (grams === null) return null
  return fromGrams(grams, usableUnit(unitCode, pieceWeightG), pieceWeightG ?? null)
}

export interface QuantityFieldProps {
  readonly label: string
  /** Masse en grammes — la valeur STOCKEE. `null` = champ vide. */
  readonly value: number | null
  readonly onChange: (grams: number | null) => void
  /** Poids d'une piece. `null` ou 0 : aucune entree « pièce » dans le menu. */
  readonly pieceWeightG?: number | null | undefined
  /** Unite d'affichage souhaitee ('g', 'kg', '_piece'…). Prime sur l'heuristique. */
  readonly unit?: string | null | undefined
  /** Notifie le choix d'unite pour que le parent puisse le persister. */
  readonly onUnitChange?: ((unitCode: string) => void) | undefined
  readonly hint?: string | undefined
  readonly error?: string | null | undefined
  readonly required?: boolean | undefined
  readonly disabled?: boolean | undefined
  readonly autoFocus?: boolean | undefined
  readonly id?: string | undefined
}

export function QuantityField({
  label,
  value,
  onChange,
  pieceWeightG,
  unit,
  onUnitChange,
  hint,
  error,
  required,
  disabled,
  autoFocus,
  id,
}: QuantityFieldProps) {
  const ids = useFieldIds(id, { hint, error })

  const [unitCode, setUnitCode] = useState(() => resolveUnit(unit, pieceWeightG))
  const activeUnit = usableUnit(unitCode, pieceWeightG)

  const input = useDecimalInput(toDisplay(value, activeUnit, pieceWeightG), (displayed) =>
    onChange(displayed === null ? null : toGrams(displayed, activeUnit, pieceWeightG ?? null)),
  )

  // Le parent peut changer d'ingredient sous le champ (le picker vient de
  // rendre un oeuf a la place d'un litre de lait) : l'unite doit se
  // re-resoudre, et l'affichage se recalculer sans toucher a la masse.
  const [sync, setSync] = useState<{
    unit: string | null | undefined
    piece: number | null | undefined
  }>(() => ({ unit, piece: pieceWeightG }))

  if (sync.unit !== unit || sync.piece !== pieceWeightG) {
    setSync({ unit, piece: pieceWeightG })
    const resolved = resolveUnit(unit, pieceWeightG)
    setUnitCode(resolved)
    input.reset(toDisplay(value, resolved, pieceWeightG))
  }

  const options = useMemo(() => {
    const base = UNITS.map((u) => ({ code: u.code, label: u.label }))
    const hasPiece = typeof pieceWeightG === 'number' && pieceWeightG > 0
    return hasPiece
      ? [{ code: PIECE_UNIT_CODE, label: labelFor(PIECE_UNIT_CODE, pieceWeightG) }, ...base]
      : base
  }, [pieceWeightG])

  const changeUnit = (next: string) => {
    setUnitCode(next)
    // La masse est conservee : on ne rappelle PAS onChange, on se contente de
    // reecrire ce qui est affiche. C'est tout le contrat du composant.
    input.reset(toDisplay(value, next, pieceWeightG))
    onUnitChange?.(next)
  }

  return (
    <FieldShell
      ids={ids}
      label={label}
      required={required}
      hint={hint}
      error={error}
      className="field--quantity"
    >
      <div className="quantity-field">
        <input
          id={ids.controlId}
          className="field__input field__input--number quantity-field__value"
          type="text"
          inputMode="decimal"
          value={input.text}
          onChange={(event) => input.onTextChange(event.target.value)}
          autoFocus={autoFocus}
          required={required}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={ids.describedBy}
        />
        <select
          className="field__select quantity-field__unit"
          value={activeUnit}
          onChange={(event) => changeUnit(event.target.value)}
          disabled={disabled}
          aria-label={`Unité de « ${label} »`}
        >
          {options.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </FieldShell>
  )
}
