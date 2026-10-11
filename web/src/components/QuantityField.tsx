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
 * Cuisson-aware aussi : quand l'ingredient porte un rendement
 * (`cookedWeightPer100gRaw`, 300 pour le riz), une entree "g cuits" s'ajoute,
 * et le gramme se relit "g crus" pour que les deux se distinguent dans la
 * liste. La masse remontee reste CRUE : c'est elle que lisent les apports, le
 * prix et la liste de courses. Une indication sous le champ dit ce qui sera
 * enregistre, "Soit 67 g crus" : sans elle, rien ne montrerait que les deux
 * nombres different.
 *
 * Les facteurs de conversion viennent de @prandia/shared/units, jamais d'une
 * table recopiee ici : le desktop en avait deux copies, une en Python et une
 * en QML, et l'import de recette par URL traitait une piece comme un gramme.
 */

import { useMemo, useState } from 'react'
import {
  COOKED_UNIT_CODE,
  DEFAULT_UNIT_CODE,
  PIECE_UNIT_CODE,
  UNITS,
  formatGrams,
  fromGrams,
  isKnownUnit,
  labelFor,
  toGrams,
} from '@prandia/shared'

import { FieldShell, useDecimalInput, useFieldIds } from './Field.js'

/** Les deux facteurs qui dependent de l'ingredient, et non d'une table. */
interface Facteurs {
  readonly piece: number | null | undefined
  readonly cuit: number | null | undefined
  /** Poids d'une cuillere a soupe : ne rend aucune unite convertible, il corrige les cuilleres. */
  readonly cuillere?: number | null | undefined
}

const positif = (v: number | null | undefined): v is number => typeof v === 'number' && v > 0

/** L'unite est-elle convertible pour CET ingredient ? */
function convertible(unitCode: string, f: Facteurs): boolean {
  if (unitCode === PIECE_UNIT_CODE) return positif(f.piece)
  if (unitCode === COOKED_UNIT_CODE) return positif(f.cuit)
  return isKnownUnit(unitCode)
}

/**
 * Unite a selectionner, dans l'ordre de priorite : le choix explicite du
 * parent, puis la piece quand elle existe, puis le gramme. Les grammes cuits
 * ne sont JAMAIS un defaut : une recette s'ecrit le plus souvent en cru, et
 * l'on ne doit pas decouvrir apres coup qu'on a saisi l'autre.
 */
function resolveUnit(preferred: string | null | undefined, f: Facteurs): string {
  if (preferred && convertible(preferred, f)) return preferred
  return positif(f.piece) ? PIECE_UNIT_CODE : DEFAULT_UNIT_CODE
}

/**
 * Unite reellement utilisable ici et maintenant.
 *
 * Le parent peut changer d'ingredient sans changer d'unite : l'unite « pièce »
 * ou "g cuits" survit alors un rendu de trop a un facteur devenu nul, et
 * `fromGrams` leve. On retombe sur le gramme le temps que la resynchronisation
 * ci-dessous choisisse la bonne unite.
 */
function usableUnit(unitCode: string, f: Facteurs): string {
  return convertible(unitCode, f) ? unitCode : DEFAULT_UNIT_CODE
}

/** Masse -> valeur affichee dans l'unite courante. `null` reste `null`. */
function toDisplay(grams: number | null, unitCode: string, f: Facteurs): number | null {
  if (grams === null) return null
  return fromGrams(grams, usableUnit(unitCode, f), f.piece ?? null, f.cuit ?? null, f.cuillere ?? null)
}

export interface QuantityFieldProps {
  readonly label: string
  /** Masse en grammes — la valeur STOCKEE. `null` = champ vide. */
  readonly value: number | null
  readonly onChange: (grams: number | null) => void
  /** Poids d'une piece. `null` ou 0 : aucune entree « pièce » dans le menu. */
  readonly pieceWeightG?: number | null | undefined
  /**
   * Rendement a la cuisson, en grammes cuits pour 100 g crus. `null` : aucune
   * entree "g cuits". Toute surface qui saisit un ingredient pouvant se peser
   * cuit doit le passer, sinon le choix n'est simplement pas offert.
   */
  readonly cookedWeightPer100gRaw?: number | null | undefined
  /**
   * Poids d'une cuillere a soupe de l'ingredient. `null` : 15 g, l'eau. Toute
   * surface qui saisit un ingredient en cuilleres doit le passer, sinon deux
   * cuilleres de farine y pesent 30 g quand la recette en compte 16.
   */
  readonly spoonWeightG?: number | null | undefined
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
  cookedWeightPer100gRaw,
  spoonWeightG,
  unit,
  onUnitChange,
  hint,
  error,
  required,
  disabled,
  autoFocus,
  id,
}: QuantityFieldProps) {
  const facteurs: Facteurs = { piece: pieceWeightG, cuit: cookedWeightPer100gRaw, cuillere: spoonWeightG }
  const [unitCode, setUnitCode] = useState(() => resolveUnit(unit, facteurs))
  const activeUnit = usableUnit(unitCode, facteurs)

  const input = useDecimalInput(toDisplay(value, activeUnit, facteurs), (displayed) =>
    onChange(
      displayed === null
        ? null
        : toGrams(displayed, activeUnit, pieceWeightG ?? null, cookedWeightPer100gRaw ?? null, spoonWeightG ?? null),
    ),
  )

  // Le parent peut changer d'ingredient sous le champ (le picker vient de
  // rendre un oeuf a la place d'un litre de lait) : l'unite doit se
  // re-resoudre, et l'affichage se recalculer sans toucher a la masse.
  const [sync, setSync] = useState<{
    unit: string | null | undefined
    piece: number | null | undefined
    cuit: number | null | undefined
    cuillere: number | null | undefined
  }>(() => ({ unit, piece: pieceWeightG, cuit: cookedWeightPer100gRaw, cuillere: spoonWeightG }))

  if (
    sync.unit !== unit ||
    sync.piece !== pieceWeightG ||
    sync.cuit !== cookedWeightPer100gRaw ||
    sync.cuillere !== spoonWeightG
  ) {
    setSync({ unit, piece: pieceWeightG, cuit: cookedWeightPer100gRaw, cuillere: spoonWeightG })
    const resolved = resolveUnit(unit, facteurs)
    setUnitCode(resolved)
    input.reset(toDisplay(value, resolved, facteurs))
  }

  const options = useMemo(() => {
    const aCuit = positif(cookedWeightPer100gRaw)
    // Avec un rendement, "g" devient "g crus" : place a cote de "g cuits", un
    // simple "g" ne dirait pas lequel des deux il est.
    const base = UNITS.flatMap((u) =>
      u.code === DEFAULT_UNIT_CODE && aCuit
        ? [
            { code: u.code, label: 'g crus' },
            { code: COOKED_UNIT_CODE, label: labelFor(COOKED_UNIT_CODE) },
          ]
        : [{ code: u.code, label: labelFor(u.code, null, spoonWeightG) }],
    )
    return positif(pieceWeightG)
      ? [{ code: PIECE_UNIT_CODE, label: labelFor(PIECE_UNIT_CODE, pieceWeightG) }, ...base]
      : base
  }, [pieceWeightG, cookedWeightPer100gRaw, spoonWeightG])

  const changeUnit = (next: string) => {
    setUnitCode(next)
    // La masse est conservee : on ne rappelle PAS onChange, on se contente de
    // reecrire ce qui est affiche. C'est tout le contrat du composant.
    input.reset(toDisplay(value, next, facteurs))
    onUnitChange?.(next)
  }

  // En grammes cuits, ce qui s'enregistre n'est pas ce qu'on lit : on le dit.
  const indication =
    activeUnit === COOKED_UNIT_CODE && value !== null && value > 0
      ? `Soit ${formatGrams(value)} crus${hint ? ` · ${hint}` : ''}`
      : hint
  // Apres l'indication : c'est elle que `aria-describedby` doit designer.
  const ids = useFieldIds(id, { hint: indication, error })

  return (
    <FieldShell
      ids={ids}
      label={label}
      required={required}
      hint={indication}
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
