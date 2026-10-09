/**
 * Champs de formulaire — le socle de tous les ecrans d'edition.
 *
 * Le desktop composait ses formulaires a la main, widget par widget, dans
 * chaque page QML. Ici chaque champ est un composant : le libelle est toujours
 * associe au controle, l'erreur porte toujours `role="alert"`, la cible de tap
 * fait toujours la largeur de l'ecran. Ces trois regles ne peuvent pas etre
 * oubliees si personne n'ecrit de <input> nu.
 *
 * Deux choix qui reviennent partout :
 *
 *   1. Les proprietes optionnelles sont declarees `?: T | undefined`. Sous
 *      `exactOptionalPropertyTypes`, un simple `?: T` REFUSE une valeur
 *      explicitement `undefined` — or les ecrans ecrivent naturellement
 *      `error={mutation.error?.message}`, qui vaut `undefined` la plupart du
 *      temps. Le `| undefined` explicite est ce qui rend cet usage legal.
 *
 *   2. Les champs numeriques sont des `<input type="text" inputMode="decimal">`
 *      et non des `type="number"`. `type="number"` refuse la virgule decimale
 *      sur un clavier francais, remonte `""` pour toute saisie invalide (on ne
 *      distingue plus « vide » de « 12a »), et la molette peut modifier la
 *      valeur par accident.
 */

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'

import '../styles/components.css'

// ---------------------------------------------------------------------------
// Analyse et rendu des nombres decimaux
// ---------------------------------------------------------------------------

/**
 * Lit un nombre saisi a la francaise. `null` = champ vide OU saisie encore
 * incomplete (« 12, », « - ») : dans les deux cas il n'y a pas de valeur a
 * remonter, et une saisie en cours ne doit jamais faire clignoter une erreur.
 */
export function parseDecimal(raw: string): number | null {
  // La classe des blancs couvre deja l'espace insecable et l'espace fine
  // insecable, celles que ramene un copier-coller de « 1 250 g » depuis
  // l'application elle-meme.
  const cleaned = raw.replace(/\s/g, '').replace(',', '.')
  if (cleaned === '') return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

/** Ecrit un nombre pour un champ de SAISIE : virgule, pas de separateur de milliers. */
export function formatDecimalInput(value: number | null, decimals = 3): string {
  if (value === null) return ''
  const factor = 10 ** decimals
  return String(Math.round(value * factor) / factor).replace('.', ',')
}

/**
 * Egalite a la tolerance du flottant.
 *
 * `fromGrams(toGrams(1.6667))` rend 1.6666999999999998 : une comparaison
 * stricte conclurait a un changement venu de l'exterieur et reecrirait le
 * tampon de saisie sous les doigts de l'utilisateur.
 */
function near(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))
}

export interface DecimalInput {
  /** Ce que l'utilisateur voit, tel qu'il l'a tape. */
  readonly text: string
  readonly onTextChange: (raw: string) => void
  /** Reecrit le tampon depuis une valeur — changement d'unite, reinitialisation. */
  readonly reset: (value: number | null) => void
}

/**
 * Tampon de saisie d'un nombre.
 *
 * Un champ numerique controle par la seule valeur numerique est inutilisable :
 * taper « 1,5 » passe par l'etat intermediaire « 1, » que `Number` ne sait pas
 * representer, et le champ se vide sous les doigts. On conserve donc le TEXTE,
 * et on ne le reecrit que quand la valeur change VRAIMENT de l'exterieur —
 * jamais quand elle revient de notre propre emission.
 */
export function useDecimalInput(
  value: number | null,
  onValue: (value: number | null) => void,
  options: { decimals?: number | undefined; emptyOnZero?: boolean | undefined } = {},
): DecimalInput {
  const { decimals = 3, emptyOnZero = false } = options

  const render = (v: number | null): string =>
    v === null || (emptyOnZero && v === 0) ? '' : formatDecimalInput(v, decimals)

  const [text, setText] = useState(() => render(value))
  const [seen, setSeen] = useState(value)
  const emitted = useRef<number | null>(value)

  // Resynchronisation PENDANT le rendu et non dans un effet : un effet
  // afficherait une frame avec l'ancienne valeur, visible a l'oeil nu au
  // changement d'unite d'un QuantityField.
  if (!near(value, seen)) {
    setSeen(value)
    if (!near(value, emitted.current)) setText(render(value))
  }

  const onTextChange = (raw: string) => {
    setText(raw)
    const parsed = parseDecimal(raw)
    emitted.current = parsed
    onValue(parsed)
  }

  const reset = (next: number | null) => {
    emitted.current = next
    setSeen(next)
    setText(render(next))
  }

  return { text, onTextChange, reset }
}

// ---------------------------------------------------------------------------
// Enveloppe commune
// ---------------------------------------------------------------------------

export interface BaseFieldProps {
  readonly label: string
  /** Texte d'aide, sous le champ. Disparait au profit de l'erreur. */
  readonly hint?: string | undefined
  /** Message d'erreur. Non vide = champ en erreur. */
  readonly error?: string | null | undefined
  readonly required?: boolean | undefined
  readonly disabled?: boolean | undefined
  /** Impose l'identifiant du controle. Sinon `useId` en genere un. */
  readonly id?: string | undefined
}

export interface FieldIds {
  readonly controlId: string
  readonly hintId: string
  readonly errorId: string
  /** Pret pour `aria-describedby` — `undefined` quand il n'y a rien a decrire. */
  readonly describedBy: string | undefined
}

/** Identifiants lies d'un champ. Expose pour les composants qui batissent leur propre controle. */
export function useFieldIds(
  id: string | undefined,
  options: { hint?: string | undefined; error?: string | null | undefined } = {},
): FieldIds {
  const generated = useId()
  const controlId = id ?? generated
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  const described = [
    options.error ? errorId : null,
    options.hint ? hintId : null,
  ].filter((v): v is string => v !== null)

  return {
    controlId,
    hintId,
    errorId,
    describedBy: described.length > 0 ? described.join(' ') : undefined,
  }
}

export interface FieldShellProps {
  readonly ids: FieldIds
  readonly label: string
  readonly required?: boolean | undefined
  readonly hint?: string | undefined
  readonly error?: string | null | undefined
  readonly className?: string | undefined
  readonly children: ReactNode
}

/**
 * Libelle + controle + aide + erreur.
 *
 * Expose pour QuantityField et IngredientPicker, qui composent un controle
 * particulier mais doivent presenter exactement la meme chose autour.
 */
export function FieldShell({
  ids,
  label,
  required,
  hint,
  error,
  className,
  children,
}: FieldShellProps) {
  return (
    <div className={`field${error ? ' field--invalid' : ''}${className ? ` ${className}` : ''}`}>
      <label className="field__label" htmlFor={ids.controlId}>
        {label}
        {required && (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p className="field__hint" id={ids.hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={ids.errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

export type EnterKeyHint = 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send'
export type FieldInputMode = 'text' | 'search' | 'email' | 'url' | 'tel' | 'numeric' | 'decimal'

export interface TextFieldProps extends BaseFieldProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string | undefined
  readonly type?: 'text' | 'search' | 'email' | 'url' | 'tel' | 'password' | undefined
  readonly inputMode?: FieldInputMode | undefined
  readonly enterKeyHint?: EnterKeyHint | undefined
  readonly autoComplete?: string | undefined
  readonly autoFocus?: boolean | undefined
  readonly maxLength?: number | undefined
  readonly inputRef?: Ref<HTMLInputElement> | undefined
  /**
   * Valeurs proposees pendant la frappe, via un `<datalist>` natif.
   *
   * Natif et non liste maison : sous iOS il s'affiche au-dessus du clavier, ce
   * qu'aucune liste positionnee en absolu ne sait faire dans une feuille
   * modale defilante — c'est le meme obstacle qui avait fait descendre les
   * suggestions d'ingredient DANS le flux. Et le champ reste librement
   * saisissable, ce qu'un `<select>` interdirait : on doit pouvoir entrer une
   * enseigne ou l'on n'a jamais releve de prix.
   */
  readonly suggestions?: readonly string[] | undefined
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  enterKeyHint,
  autoComplete,
  autoFocus,
  maxLength,
  inputRef,
  suggestions,
  hint,
  error,
  required,
  disabled,
  id,
}: TextFieldProps) {
  const ids = useFieldIds(id, { hint, error })
  const listId = `${ids.controlId}-suggestions`
  const hasSuggestions = suggestions !== undefined && suggestions.length > 0
  return (
    <FieldShell ids={ids} label={label} required={required} hint={hint} error={error}>
      <input
        ref={inputRef}
        id={ids.controlId}
        className="field__input"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        enterKeyHint={enterKeyHint}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        maxLength={maxLength}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        list={hasSuggestions ? listId : undefined}
      />
      {hasSuggestions && (
        <datalist id={listId}>
          {suggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      )}
    </FieldShell>
  )
}

// ---------------------------------------------------------------------------
// TextArea
// ---------------------------------------------------------------------------

export interface TextAreaProps extends BaseFieldProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder?: string | undefined
  /** Hauteur minimale, en lignes. La zone grandit ensuite avec le contenu. */
  readonly minRows?: number | undefined
  readonly autoFocus?: boolean | undefined
  /**
   * Classe posee sur l'enveloppe. Sert notamment a `field--sans-libelle`,
   * quand le libelle doit rester lu par un lecteur d'ecran sans occuper une
   * ligne a l'oeil.
   */
  readonly className?: string | undefined
  /**
   * Touches interceptees avant la saisie. Sert a l'editeur d'etapes, ou
   * Entree cree l'etape suivante au lieu d'inserer un retour a la ligne.
   */
  readonly onKeyDown?: ((event: KeyboardEvent<HTMLTextAreaElement>) => void) | undefined
}

export function TextArea({
  label,
  value,
  onChange,
  className,
  onKeyDown,
  placeholder,
  minRows = 3,
  autoFocus,
  hint,
  error,
  required,
  disabled,
  id,
}: TextAreaProps) {
  const ids = useFieldIds(id, { hint, error })
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-grandissement. Pas de barre de defilement interne : sur telephone,
  // faire defiler une zone de texte dans une page qui defile deja est une
  // source d'erreur permanente. C'est la page qui defile, jamais le champ.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    // Remise a zero obligatoire avant de lire scrollHeight, sinon la hauteur
    // ne fait que croitre et une ligne supprimee ne la reduit jamais.
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [value])

  return (
    <FieldShell
      ids={ids}
      label={label}
      required={required}
      hint={hint}
      error={error}
      className={className}
    >
      <textarea
        ref={ref}
        id={ids.controlId}
        className="field__textarea"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={minRows}
        autoFocus={autoFocus}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
      />
    </FieldShell>
  )
}

// ---------------------------------------------------------------------------
// NumberField
// ---------------------------------------------------------------------------

export interface NumberFieldProps extends BaseFieldProps {
  readonly value: number | null
  readonly onChange: (value: number | null) => void
  readonly placeholder?: string | undefined
  /** Bornes appliquees A LA SORTIE du champ, jamais pendant la frappe. */
  readonly min?: number | undefined
  readonly max?: number | undefined
  /** Decimales conservees a l'affichage. La valeur remontee n'est pas arrondie. */
  readonly decimals?: number | undefined
  /**
   * Portage de `AppSpinBox.emptyOnZero` : une valeur nulle s'affiche vide.
   * Sert aux macros, ou « 0 g de sucres » et « sucres inconnus » ne sont pas
   * la meme information.
   */
  readonly emptyOnZero?: boolean | undefined
  /** Unite affichee dans une cellule fixe a droite — portage de FixedUnitField.qml. */
  readonly suffix?: string | undefined
  readonly autoFocus?: boolean | undefined
  readonly inputRef?: Ref<HTMLInputElement> | undefined
  /**
   * Classe posee sur l'enveloppe.
   *
   * Sert a la variante `field--ligne`, ou le libelle passe A GAUCHE du
   * controle au lieu d'etre au-dessus. C'est une affaire de mise en page, pas
   * de comportement : le champ reste le meme, avec les memes identifiants
   * lies et le meme bornage a la sortie.
   */
  readonly className?: string | undefined
}

export function NumberField({
  label,
  value,
  onChange,
  placeholder,
  min,
  max,
  decimals = 3,
  emptyOnZero,
  suffix,
  autoFocus,
  inputRef,
  hint,
  error,
  required,
  disabled,
  id,
  className,
}: NumberFieldProps) {
  const ids = useFieldIds(id, { hint, error })
  const input = useDecimalInput(value, onChange, { decimals, emptyOnZero })

  // Bornage a la sortie du champ et non pendant la frappe : saisir « 50 »
  // dans un champ borne a 10 ecraserait le premier chiffre par 10 et le second
  // deviendrait impossible a taper.
  const clampOnBlur = () => {
    if (value === null) return
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value))
    if (clamped !== value) {
      onChange(clamped)
      input.reset(clamped)
    } else {
      // Renormalise « 012,50 » en « 12,5 » une fois la saisie terminee.
      input.reset(value)
    }
  }

  const field = (
    <input
      ref={inputRef}
      id={ids.controlId}
      className="field__input field__input--number"
      type="text"
      // Ouvre le pave numerique avec la virgule sur telephone.
      inputMode="decimal"
      value={input.text}
      onChange={(event) => input.onTextChange(event.target.value)}
      onBlur={clampOnBlur}
      placeholder={placeholder}
      autoFocus={autoFocus}
      required={required}
      disabled={disabled}
      aria-invalid={error ? true : undefined}
      aria-describedby={ids.describedBy}
    />
  )

  return (
    <FieldShell
      ids={ids}
      label={label}
      required={required}
      hint={hint}
      error={error}
      className={className}
    >
      {suffix === undefined ? (
        field
      ) : (
        <div className="field__control">
          {field}
          <span className="field__suffix" aria-hidden="true">
            {suffix}
          </span>
        </div>
      )}
    </FieldShell>
  )
}

// ---------------------------------------------------------------------------
// SelectField
// ---------------------------------------------------------------------------

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean | undefined
}

export interface SelectFieldProps extends BaseFieldProps {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly SelectOption[]
  /** Entree vide en tete, pour « aucun choix ». Sa valeur est `''`. */
  readonly placeholder?: string | undefined
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  hint,
  error,
  required,
  disabled,
  id,
}: SelectFieldProps) {
  const ids = useFieldIds(id, { hint, error })
  return (
    <FieldShell ids={ids} label={label} required={required} hint={hint} error={error}>
      {/* <select> natif et non une liste sur mesure : iOS le rend avec sa roue
          de selection, plus rapide au pouce que n'importe quel menu maison, et
          gratuitement accessible. */}
      <select
        id={ids.controlId}
        className="field__select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
}

// ---------------------------------------------------------------------------
// CheckboxField
// ---------------------------------------------------------------------------

export interface CheckboxFieldProps {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly hint?: string | undefined
  readonly error?: string | null | undefined
  readonly disabled?: boolean | undefined
  readonly id?: string | undefined
}

export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  error,
  disabled,
  id,
}: CheckboxFieldProps) {
  const ids = useFieldIds(id, { hint, error })
  return (
    <div className={`field field--checkbox${error ? ' field--invalid' : ''}`}>
      {/* Le <label> englobe case ET texte : la zone de tap fait la largeur de
          l'ecran, pas les 24 px de la case. Meme raison que .shopping-row. */}
      <label className="checkbox-field" htmlFor={ids.controlId}>
        <input
          id={ids.controlId}
          className="checkbox-field__box"
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={ids.describedBy}
        />
        <span className="checkbox-field__body">
          <span className="checkbox-field__label">{label}</span>
          {hint && (
            <span className="checkbox-field__hint" id={ids.hintId}>
              {hint}
            </span>
          )}
        </span>
      </label>
      {error && (
        <p className="field__error" id={ids.errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DateField
// ---------------------------------------------------------------------------

export interface DateFieldProps extends BaseFieldProps {
  /** Date au format 'AAAA-MM-JJ', ou `null` quand le champ est vide. */
  readonly value: string | null
  readonly onChange: (value: string | null) => void
  readonly min?: string | undefined
  readonly max?: string | undefined
}

export function DateField({
  label,
  value,
  onChange,
  min,
  max,
  hint,
  error,
  required,
  disabled,
  id,
}: DateFieldProps) {
  const ids = useFieldIds(id, { hint, error })
  return (
    <FieldShell ids={ids} label={label} required={required} hint={hint} error={error}>
      {/* type="date" delegue au selecteur natif du telephone. Le format
          d'echange reste 'AAAA-MM-JJ' quelle que soit la langue de l'appareil,
          ce qui correspond exactement a ce que stocke la base.
          Pre-remplir avec la date du jour : `todayLocalIsoDate()` de
          @prandia/shared, JAMAIS `toISOString()` qui propose la veille en
          soiree francaise. */}
      <input
        id={ids.controlId}
        className="field__input"
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        min={min}
        max={max}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
      />
    </FieldShell>
  )
}

// ---------------------------------------------------------------------------
// RadioGroupField
// ---------------------------------------------------------------------------

export interface RadioOption {
  readonly value: string
  readonly label: string
  /** Description sous le libelle. C'est elle qui rend le choix decidable. */
  readonly hint?: string | undefined
  readonly disabled?: boolean | undefined
}

export interface RadioGroupFieldProps {
  /** Intitule du groupe. Rendu dans un <legend>, donc annonce avant chaque choix. */
  readonly legend: string
  readonly value: string | null
  readonly onChange: (value: string) => void
  readonly options: readonly RadioOption[]
  readonly hint?: string | undefined
  readonly error?: string | null | undefined
  readonly disabled?: boolean | undefined
  readonly id?: string | undefined
  /** Cache visuellement le <legend>, quand le titre de carte le repete deja. */
  readonly legendHidden?: boolean | undefined
}

/**
 * Un choix parmi plusieurs, chacun avec sa description.
 *
 * DES <input type="radio"> NATIFS, et non des boutons avec `aria-checked`.
 * Le navigateur donne alors gratuitement ce qu'il faudrait sinon reecrire et
 * maintenir : les fleches qui circulent dans le groupe, la tabulation qui
 * entre sur l'element coche et ressort du groupe entier, et l'annonce
 * "3 sur 5" par le lecteur d'ecran. Aucun de ces trois comportements n'est
 * evident a refaire, et le troisieme est impossible sans le groupe natif.
 *
 * `<fieldset>` + `<legend>` parce qu'un groupe de radios sans intitule laisse
 * entendre "Sedentaire, bouton radio" sans jamais dire de quoi il s'agit.
 *
 * Le <label> englobe la puce ET le texte : la zone de tap fait la largeur de
 * la carte et non les 21 px du rond. Meme raison que CheckboxField.
 */
export function RadioGroupField({
  legend,
  value,
  onChange,
  options,
  hint,
  error,
  disabled,
  id,
  legendHidden,
}: RadioGroupFieldProps) {
  const ids = useFieldIds(id, { hint, error })

  return (
    <fieldset
      className={`radios${error ? ' radios--invalid' : ''}`}
      aria-describedby={ids.describedBy}
    >
      <legend className={`radios__legend${legendHidden === true ? ' radios__legend--muet' : ''}`}>
        {legend}
      </legend>

      {options.map((option) => (
        <label
          key={option.value}
          className={`radio${value === option.value ? ' radio--on' : ''}`}
          htmlFor={`${ids.controlId}-${option.value}`}
        >
          <input
            id={`${ids.controlId}-${option.value}`}
            className="radio__puce"
            type="radio"
            /* Le meme `name` pour tout le groupe : c'est LUI qui fait le
               groupe aux yeux du navigateur, pas le <fieldset>. */
            name={ids.controlId}
            value={option.value}
            checked={value === option.value}
            disabled={disabled === true || option.disabled === true}
            onChange={() => onChange(option.value)}
          />
          <span className="radio__corps">
            <span className="radio__label">{option.label}</span>
            {option.hint !== undefined && <span className="radio__hint">{option.hint}</span>}
          </span>
        </label>
      ))}

      {hint !== undefined && !error && (
        <p className="field__hint" id={ids.hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={ids.errorId} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  )
}
