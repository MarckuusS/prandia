/**
 * La semaine ISO consultee, rangee dans l'URL.
 *
 * Extrait de ShoppingScreen et WeekScreen, qui en portaient deux copies.
 *
 * Pourquoi l'URL et non un `useState` : en magasin, l'application est mise en
 * arriere-plan puis reprise, parfois rechargee par le systeme quand la memoire
 * manque. Un etat local disparait avec elle et ramene l'utilisateur a la
 * semaine courante au milieu de ses courses. Un parametre d'URL survit au
 * rechargement, rend le lien partageable, et fait du bouton Retour du telephone
 * un « annuler » naturel.
 *
 * Le parametre est en francais (`?semaine=`) parce qu'il est visible par
 * l'utilisateur — c'est de l'interface, pas du code.
 */

import { useSearchParams } from 'react-router'
import { currentIsoWeek, isValidIsoWeek } from '@prandia/shared'

export interface IsoWeekParam {
  /** Semaine affichee. Toujours valide : une valeur douteuse retombe sur la semaine courante. */
  readonly isoWeek: string
  readonly currentWeek: string
  readonly isCurrent: boolean
  /** Change de semaine. Nommee pour se brancher telle quelle sur WeekPicker. */
  readonly onChange: (isoWeek: string) => void
  readonly onToday: () => void
}

export function useIsoWeekParam(paramName = 'semaine'): IsoWeekParam {
  // Calculee sur l'heure LOCALE du telephone : « cette semaine » est celle de
  // l'utilisateur, pas celle du serveur, qui vit en UTC.
  const currentWeek = currentIsoWeek()
  const [searchParams, setSearchParams] = useSearchParams()

  const requested = searchParams.get(paramName)
  // Validation systematique : le parametre vient de l'URL, donc de n'importe
  // ou. Une semaine invalide doit afficher la semaine courante, pas propager
  // une exception jusqu'a l'ecran.
  const isoWeek = requested !== null && isValidIsoWeek(requested) ? requested : currentWeek

  const onChange = (week: string) => {
    // On repart des parametres existants au lieu de les remplacer : un ecran
    // peut ranger autre chose dans l'URL (le jour selectionne, un filtre), et
    // changer de semaine ne doit pas l'effacer.
    const next = new URLSearchParams(searchParams)
    // La semaine courante est l'etat par defaut : on la laisse hors de l'URL
    // pour que l'adresse partagee reste « la semaine en cours » et non une
    // semaine figee qui vieillira.
    if (week === currentWeek) next.delete(paramName)
    else next.set(paramName, week)

    // `replace` : chaque fleche n'ajoute pas une entree d'historique, sans quoi
    // le bouton Retour obligerait a remonter semaine par semaine.
    setSearchParams(next, { replace: true })
  }

  return {
    isoWeek,
    currentWeek,
    isCurrent: isoWeek === currentWeek,
    onChange,
    onToday: () => onChange(currentWeek),
  }
}
