/**
 * Selection d'un ingredient — portage d'IngredientSearch.qml.
 *
 * Portee : la BIBLIOTHEQUE PERSONNELLE (`useIngredients`). Le catalogue CIQUAL
 * et OpenFoodFacts compte des milliers de lignes qui n'ont rien a faire dans
 * la composition d'une recette ; on les fait entrer explicitement par l'ecran
 * d'import, jamais par ce champ.
 *
 * Deux ecarts par rapport au desktop, tous deux dictes par le telephone :
 *
 *   1. La liste de suggestions est DANS LE FLUX, sous le champ, et non en
 *      surimpression. Une liste positionnee en absolu est decoupee par le
 *      conteneur defilant d'une feuille modale — or c'est precisement la que
 *      ce champ sert le plus. Elle pousse donc le contenu vers le bas.
 *
 *   2. Elle s'ouvre des la mise au point, sans attendre une frappe : la
 *      bibliotheque personnelle tient en quelques dizaines de lignes, et
 *      parcourir vaut mieux que taper au pouce.
 *
 * La navigation au clavier est conservee telle quelle. Elle ne sert a rien au
 * doigt, mais l'application s'utilise aussi au bureau, et c'est ce qui rend le
 * champ utilisable au lecteur d'ecran.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatGrams, type Ingredient } from '@prandia/shared'

import { useIngredients } from '../lib/queries.js'
import { FieldShell, useFieldIds } from './Field.js'
import { RayonIcon } from '../icons/index.js'
import { useRayonStyle } from '../lib/useRayonStyle.js'
import { SourceBadge } from './States.js'
import '../styles/components.css'

export interface IngredientPickerProps {
  readonly onPick: (ingredient: Ingredient) => void
  readonly label?: string | undefined
  readonly placeholder?: string | undefined
  readonly hint?: string | undefined
  readonly error?: string | null | undefined
  readonly required?: boolean | undefined
  readonly disabled?: boolean | undefined
  readonly autoFocus?: boolean | undefined
  /** Vide le champ apres selection. Vrai par defaut : on enchaine les ajouts. */
  readonly clearOnPick?: boolean | undefined
  /** Ingredients deja presents, retires des suggestions. */
  readonly excludeIds?: readonly number[] | undefined
  readonly maxResults?: number | undefined
  readonly id?: string | undefined
}

export function IngredientPicker({
  onPick,
  label = 'Ingrédient',
  placeholder = 'Rechercher un ingrédient…',
  hint,
  error,
  required,
  disabled,
  autoFocus,
  clearOnPick = true,
  excludeIds,
  maxResults = 12,
  id,
}: IngredientPickerProps) {
  const ids = useFieldIds(id, { hint, error })
  const listboxId = `${ids.controlId}-listbox`

  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // 200 ms, comme le Timer du desktop. Sans ce delai, chaque lettre part en
  // requete reseau — invisible en SQLite local, ruineux sur un reseau mobile.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), 200)
    return () => clearTimeout(timer)
  }, [text])

  const list = useIngredients(debounced)
  const styleOf = useRayonStyle()

  const suggestions = useMemo(() => {
    const excluded = new Set(excludeIds ?? [])
    return (list.data?.items ?? [])
      .filter((item) => item.id !== null && !excluded.has(item.id))
      .slice(0, maxResults)
  }, [list.data, excludeIds, maxResults])

  // L'index actif peut pointer au-dela de la liste apres une frappe qui la
  // raccourcit : on le borne a l'affichage plutot que de le corriger dans un
  // effet, qui rendrait une frame avec une ligne surlignee inexistante.
  const active = Math.min(activeIndex, Math.max(0, suggestions.length - 1))

  useEffect(() => {
    if (!open) return
    const element = listRef.current?.children[active]
    if (element instanceof HTMLElement) element.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const pick = (ingredient: Ingredient) => {
    onPick(ingredient)
    setOpen(false)
    setActiveIndex(0)
    if (clearOnPick) {
      setText('')
      setDebounced('')
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(Math.min(suggestions.length - 1, active + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(Math.max(0, active - 1))
      return
    }
    if (event.key === 'Enter') {
      const choice = suggestions[active]
      if (open && choice) {
        // Sans ce preventDefault, la touche Entree soumettrait le formulaire
        // qui contient le champ au lieu de valider la suggestion.
        event.preventDefault()
        pick(choice)
      }
      return
    }
    if (event.key === 'Escape') {
      // Echap ferme la liste sans remonter jusqu'a la feuille modale qui
      // contient le champ : une premiere pression ferme la liste, une seconde
      // ferme la feuille.
      if (open) {
        event.stopPropagation()
        setOpen(false)
      }
    }
  }

  const showList = open && !disabled
  // « Deplie » au sens ARIA veut dire qu'il y a quelque chose a parcourir :
  // annoncer une liste ouverte et vide envoie le lecteur d'ecran nulle part.
  const expanded = showList && suggestions.length > 0
  const emptySearch = list.isSuccess && suggestions.length === 0

  return (
    <FieldShell
      ids={ids}
      label={label}
      required={required}
      hint={hint}
      error={error}
      className="field--picker"
    >
      <div className="picker" ref={containerRef}>
        <input
          id={ids.controlId}
          className="field__input"
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={expanded ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={expanded ? `${listboxId}-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={ids.describedBy}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          // Le clavier iOS affiche « rechercher » plutot que « entrée ».
          enterKeyHint="search"
          onChange={(event) => {
            setText(event.target.value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={(event) => {
            // Un tap sur une suggestion declenche le blur AVANT le clic. On ne
            // ferme que si la mise au point sort vraiment du composant.
            const next = event.relatedTarget
            if (!(next instanceof Node) || !containerRef.current?.contains(next)) setOpen(false)
          }}
          onKeyDown={onKeyDown}
        />

        {expanded && (
          <ul className="picker__listbox" id={listboxId} role="listbox" ref={listRef}>
            {suggestions.map((ingredient, index) => (
              <li
                key={ingredient.id ?? index}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={`picker__option${index === active ? ' picker__option--active' : ''}`}
                // preventDefault sur mousedown : empeche le champ de perdre la
                // mise au point, donc la liste de se fermer, avant le clic.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(ingredient)}
              >
                <span className="icon-chip icon-chip--sm" {...styleOf(ingredient.categoryL1).tint}>
                  <RayonIcon glyph={styleOf(ingredient.categoryL1).glyph} size={18} strokeWidth={1.8} />
                </span>
                <span className="picker__body">
                  <span className="picker__name">{ingredient.name}</span>
                  <span className="picker__meta">
                    <SourceBadge source={ingredient.source} />
                    {ingredient.kcal !== null && (
                      <span>{Math.round(ingredient.kcal)} kcal/100 g</span>
                    )}
                    {ingredient.pieceWeightG !== null && (
                      <span className="picker__piece">
                        1 pc = {formatGrams(ingredient.pieceWeightG)}
                      </span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {showList && list.isPending && <p className="picker__status">Recherche…</p>}
        {showList && list.isError && (
          <p className="picker__status picker__status--error" role="alert">
            {list.error instanceof Error ? list.error.message : 'Recherche impossible.'}
          </p>
        )}
        {showList && emptySearch && (
          <p className="picker__status">
            {debounced
              ? `Rien ne correspond à « ${debounced} » dans ta bibliothèque.`
              : 'Ta bibliothèque personnelle est vide.'}
          </p>
        )}
      </div>
    </FieldShell>
  )
}
