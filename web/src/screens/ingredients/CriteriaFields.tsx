/**
 * L'editeur de bornes chiffrees, partage par la bibliotheque et l'import.
 *
 * Il vivait dans l'ecran Ingredients. Des que l'import a du filtrer lui aussi,
 * le copier aurait cree deux comportements a maintenir d'accord — et ils
 * auraient diverge au premier ajustement.
 *
 * La forme n'est pas une grille de champs min/max mais une LISTE DE REGLES :
 * on ajoute « Protéines ≥ 20 », puis « Sel ≤ 1 ». On ne paie que ce qu'on
 * demande, et n'importe quel nutriment est atteignable — ce que douze champs
 * figes n'offraient pas.
 *
 * CHAQUE REGLE EST UN COMPOSANT, et ce n'est pas un detail d'organisation :
 * la saisie decimale exige un hook par ligne (voir `CriterionRow`).
 */

import type { Criterion } from '@prandia/shared'

import { useDecimalInput } from '../../components/Field.js'
import { Icon } from '../../icons/index.js'

export interface CriterionFieldDef {
  readonly code: string
  readonly label: string
  readonly unit: string
}

/**
 * Une regle : nutriment, sens, valeur.
 *
 * Le champ passe par `useDecimalInput`, qui garde le TEXTE tape a cote de la
 * valeur. Sans lui, le champ etait controle par le seul nombre : taper « 0,5 »
 * passe par l'etat « 0, », que `Number` ramene a 0, qui se reformate en « 0 »
 * — la virgule disparaissait sous les doigts et aucune decimale n'etait
 * saisissable. C'est bloquant sur le sel, dont les valeurs pour 100 g sont
 * presque toujours inferieures a 1.
 */
function CriterionRow({
  criterion,
  fields,
  onChange,
  onRemove,
}: {
  readonly criterion: Criterion
  readonly fields: readonly CriterionFieldDef[]
  readonly onChange: (patch: Partial<Criterion>) => void
  readonly onRemove: () => void
}) {
  const champ = fields.find((f) => f.code === criterion.field)
  const valeur = useDecimalInput(criterion.value, (v) => onChange({ value: v ?? 0 }), {
    decimals: 3,
  })

  return (
    <div className="ing-criterion">
      <select
        className="field__select ing-criterion__field"
        value={criterion.field}
        onChange={(e) => onChange({ field: e.target.value })}
        aria-label="Nutriment ou propriété"
      >
        {fields.map((f) => (
          <option key={f.code} value={f.code}>
            {f.label}
          </option>
        ))}
      </select>

      <select
        className="field__select ing-criterion__bound"
        value={criterion.bound}
        onChange={(e) => onChange({ bound: e.target.value as 'min' | 'max' })}
        aria-label="Sens de la borne"
      >
        {/* Les symboles plutot que « au moins » / « au plus » : dans une ligne
            qui se lit « Protéines ≥ 20 g/100 g », le signe se comprend d'un
            coup d'oeil la ou les mots demandaient d'etre lus. Les valeurs
            stockees restent `min` et `max` : les liens deja partages
            continuent de fonctionner. */}
        <option value="min">≥</option>
        <option value="max">≤</option>
      </select>

      {/* `type="text"` et non `number` : le clavier francais produit une
          virgule, que `type="number"` refuse dans plusieurs navigateurs. */}
      <input
        type="text"
        inputMode="decimal"
        className="search-field ing-criterion__value"
        value={valeur.text}
        onChange={(e) => valeur.onTextChange(e.target.value)}
        aria-label={`Valeur en ${champ?.unit ?? ''}`}
      />
      <span className="ing-criterion__unit">{champ?.unit}</span>

      <button
        type="button"
        className="button button--danger ing-criterion__remove"
        onClick={onRemove}
        aria-label="Retirer cette borne"
      >
        <Icon name="ui-close" size={16} />
      </button>
    </div>
  )
}

export function CriteriaFields({
  criteria,
  onChange,
  fields,
  hint,
}: {
  readonly criteria: readonly Criterion[]
  readonly onChange: (criteria: Criterion[]) => void
  readonly fields: readonly CriterionFieldDef[]
  readonly hint?: string
}) {
  return (
    <fieldset className="ing-choices">
      <legend className="ing-choices__legend">Bornes chiffrées</legend>

      {criteria.map((criterion, index) => (
        <CriterionRow
          key={`${criterion.field}-${index}`}
          criterion={criterion}
          fields={fields}
          onChange={(patch) =>
            onChange(criteria.map((c, i) => (i === index ? { ...c, ...patch } : c)))
          }
          onRemove={() => onChange(criteria.filter((_, i) => i !== index))}
        />
      ))}

      <button
        type="button"
        className="button button--secondary"
        onClick={() =>
          // Les proteines par defaut, et non le premier champ de la liste :
          // c'est la borne qu'on pose le plus souvent, et « Énergie ≥ 10 » ne
          // filtre rien.
          onChange([
            ...criteria,
            {
              field: fields.some((f) => f.code === 'proteins')
                ? 'proteins'
                : (fields[0]?.code ?? 'kcal'),
              bound: 'min',
              value: 10,
            },
          ])
        }
      >
        <Icon name="ui-plus" size={16} className="icon--inline" /> Ajouter une borne
      </button>

      <p className="field__hint">
        {hint ??
          'Toutes les bornes doivent être satisfaites. Un ingrédient dont la valeur n’est pas renseignée n’en satisfait aucune — sinon « moins de 1 g de sel » ramènerait les fiches vides.'}
      </p>
    </fieldset>
  )
}
