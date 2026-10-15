/**
 * L'entree dans les courses, depuis la liste.
 *
 * LES COURSES SE RANGENT A LA MAISON (decision du 2026-10-15). En magasin, on
 * coche sa liste et rien d'autre ; de retour, "Ranger mes courses" ouvre le
 * chariot ET le scan en chaine d'un seul toucher : chaque produit, son
 * code-barres puis ses photos, avant de le ranger. Le ticket donnera les prix
 * et le magasin. Plus aucune question au depart : le magasin etait demande
 * ici, il est lu sur le ticket, ou demande a la toute fin s'il manque encore.
 *
 * Deux etats :
 *   - AUCUNE session : l'invitation a ranger ses courses ;
 *   - UNE session en cours : le chemin pour y revenir. Elle vit sur le serveur :
 *     reprendre l'application apres qu'iOS a decharge l'onglet ramene le
 *     chariot, pas une page vide.
 */

import { useEffect } from 'react'
import { formatEuros } from '@prandia/shared'

import { Icon } from '../../icons/index.js'
import { ApiError } from '../../lib/api.js'
import { useShoppingSession, useStartSession } from '../../lib/queries.js'
import '../../styles/session.css'

export interface SessionBarProps {
  /** Semaine de la liste affichee : c'est elle que la session cochera. */
  readonly isoWeek: string
  /**
   * Ramene l'ecran sur le chariot (la liste et les courses partagent
   * l'onglet). `chaine` : ouvrir aussitot le scan en chaine.
   */
  readonly onEnterCart: (chaine: boolean) => void
  /**
   * Code en attente, venu du point d'entree de scan. Ajouter au chariot exige
   * des courses ouvertes : on les ouvre d'office, plus rien n'est a demander.
   */
  readonly pendingScan?: { readonly ean: string } | null
}

export function SessionBar({ isoWeek, onEnterCart, pendingScan = null }: SessionBarProps) {
  // Meme cle de cache que l'ecran : aucune requete de plus, et les deux
  // composants voient toujours le meme chariot.
  const query = useShoppingSession()
  const start = useStartSession()

  const state = query.data
  const session = state !== undefined && state.active ? state.session : null

  const demarrer = (chaine: boolean) =>
    start.mutate(
      { isoWeek },
      {
        onSuccess: () => onEnterCart(chaine),
        onError: (erreur) => {
          // Des courses sont deja ouvertes : c'est le cache local qui est en
          // retard, pas le serveur. On le rafraichit et l'on y entre.
          if (erreur instanceof ApiError && erreur.code === 'session_active') {
            void query.refetch()
            onEnterCart(false)
          }
        },
      },
    )

  // `query.isSuccess` et non `session === null` seul : pendant le chargement,
  // l'absence de session n'est pas une information.
  useEffect(() => {
    if (pendingScan !== null && query.isSuccess && session === null && !start.isPending) demarrer(false)
    // `demarrer` est recree a chaque rendu ; seule l'arrivee d'un code compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScan, query.isSuccess, session])

  if (session !== null) {
    const count = state?.itemCount ?? session.items.length
    const avecPrix = session.items.some((item) => item.priceEur !== null)
    return (
      <div className="session-resume">
        <div className="session-resume__body">
          <p className="session-resume__title">
            <Icon name="ui-cart" size={16} className="icon--inline" /> Courses à ranger
            {session.store === '' ? '' : ` (${session.store})`}
          </p>
          <p className="session-resume__meta">
            {count} article{count > 1 ? 's' : ''}
            {avecPrix && state?.totalEur !== undefined && ` · ${formatEuros(state.totalEur)}`}
          </p>
        </div>
        <button
          type="button"
          className="button button--primary session-resume__action"
          onClick={() => onEnterCart(false)}
        >
          Reprendre
        </button>
      </div>
    )
  }

  return (
    <div className="session-entry">
      <div className="session-entry__body">
        <p className="session-entry__title">Tes courses sont faites ?</p>
        <p className="session-entry__lead">
          En magasin, coche ta liste. À la maison, avant de ranger, scanne chaque produit : le code-barres,
          puis la face avant, le poids et la date. La photo du ticket donnera les prix.
        </p>
        {start.isError && !(start.error instanceof ApiError && start.error.code === 'session_active') && (
          <p className="status status--error" role="alert">
            {start.error.message}
          </p>
        )}
      </div>
      <button
        type="button"
        className="button button--primary session-entry__action"
        onClick={() => demarrer(true)}
        disabled={start.isPending}
      >
        {start.isPending ? 'Ouverture…' : 'Ranger mes courses'}
      </button>
    </div>
  )
}
