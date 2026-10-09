/**
 * Selecteur de semaine ISO — fleche precedente, libelle, fleche suivante.
 *
 * Extrait de ShoppingScreen et WeekScreen, qui en portaient deux copies
 * divergentes : celle de la liste de courses avait un `aria-label` sur ses
 * fleches, celle du planning n'en avait pas. Le planning, le frigo et
 * l'historique en ont tous besoin — d'ou l'extraction.
 *
 * Se branche directement sur `useIsoWeekParam` :
 *
 *   const week = useIsoWeekParam()
 *   <WeekPicker {...week} />
 *
 * Les classes CSS vivent deja dans styles/app.css (.week-picker) : rien a
 * ajouter dans components.css.
 */

import { nextIsoWeek, previousIsoWeek } from '@prandia/shared'

export interface WeekPickerProps {
  readonly isoWeek: string
  /** Vraie quand `isoWeek` est la semaine en cours : le libelle change et le bouton se desarme. */
  readonly isCurrent: boolean
  readonly onChange: (isoWeek: string) => void
  /** Retour a la semaine courante — le libelle central en est le bouton. */
  readonly onToday: () => void
}

export function WeekPicker({ isoWeek, isCurrent, onChange, onToday }: WeekPickerProps) {
  return (
    <div className="week-picker">
      <button
        type="button"
        className="week-picker__arrow"
        onClick={() => onChange(previousIsoWeek(isoWeek))}
        aria-label="Semaine précédente"
      >
        <span aria-hidden="true">‹</span>
      </button>
      <button
        type="button"
        className="week-picker__label"
        onClick={onToday}
        disabled={isCurrent}
      >
        {/* `slice(6)` plutot qu'un parse : la cle est toujours 'AAAA-Www', et
            parseIsoWeek leverait sur une valeur douteuse alors qu'un libelle
            n'a aucune raison de faire tomber l'ecran. */}
        <span className="week-picker__week">Semaine {isoWeek.slice(6)}</span>
        <span className="week-picker__year">
          {isCurrent ? 'cette semaine' : isoWeek.slice(0, 4)}
        </span>
      </button>
      <button
        type="button"
        className="week-picker__arrow"
        onClick={() => onChange(nextIsoWeek(isoWeek))}
        aria-label="Semaine suivante"
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  )
}
