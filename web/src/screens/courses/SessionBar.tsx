/**
 * L'entree dans la session, depuis la liste de courses.
 *
 * Deux etats, et ils ne se ressemblent pas :
 *
 *   - AUCUNE session : une invitation a demarrer, avec le nom du magasin pour
 *     seule question. C'est la porte d'entree de toute la fonctionnalite ;
 *   - UNE session en cours : un rappel qu'un chariot est ouvert quelque part,
 *     et le chemin pour y revenir. Il apparait des le chargement de l'ecran,
 *     parce que la session vit sur le serveur : reprendre l'application apres
 *     qu'iOS a decharge l'onglet doit ramener le chariot, pas une page vide.
 *
 * Le magasin est demande UNE FOIS. C'est la demande explicite de l'utilisateur,
 * et la raison d'etre de la session : le redemander a chaque article serait
 * insupportable sur trente produits.
 */

import { useEffect, useState, useMemo } from 'react'
import { formatEuros } from '@prandia/shared'

import { TextField } from '../../components/Field.js'
import { Icon } from '../../icons/index.js'
import { Sheet } from '../../components/Sheet.js'
import { ApiError } from '../../lib/api.js'
import { useShoppingSession, useStartSession, useStores } from '../../lib/queries.js'
import { readRecentStores, rememberStore } from './recentStores.js'
import '../../styles/session.css'

export interface SessionBarProps {
  /** Semaine de la liste affichee : c'est elle que la session cochera. */
  readonly isoWeek: string
  /** Ramene l'ecran sur le chariot — la liste et la session partagent l'onglet. */
  readonly onEnterCart: () => void
  /**
   * Code en attente, venu du point d'entree de scan.
   *
   * Ajouter au chariot exige une session OUVERTE : sans elle, il n'existe
   * aucun destinataire et le code serait perdu. On ouvre donc la feuille de
   * demarrage d'office, et on DIT pourquoi — une feuille qui s'ouvre seule,
   * sans explication, passe pour un defaut.
   */
  readonly pendingScan?: { readonly ean: string } | null
}

export function SessionBar({ isoWeek, onEnterCart, pendingScan = null }: SessionBarProps) {
  // Meme cle de cache que l'ecran : aucune requete de plus, et les deux
  // composants voient toujours le meme chariot.
  const query = useShoppingSession()
  const [opening, setOpening] = useState(false)

  const state = query.data
  const session = state !== undefined && state.active ? state.session : null

  // `query.isSuccess` et non `session === null` seul : pendant le chargement,
  // l'absence de session n'est pas une information, et la feuille clignoterait
  // devant quelqu'un qui a deja un chariot ouvert.
  useEffect(() => {
    if (pendingScan !== null && query.isSuccess && session === null) setOpening(true)
  }, [pendingScan, query.isSuccess, session])

  if (session !== null) {
    const count = state?.itemCount ?? session.items.length
    return (
      <div className="session-resume">
        <div className="session-resume__body">
          <p className="session-resume__title">
            <Icon name="ui-cart" size={16} className="icon--inline" /> Courses en cours chez{' '}
            {session.store}
          </p>
          <p className="session-resume__meta">
            {count} article{count > 1 ? 's' : ''}
            {state?.totalEur !== undefined && ` · ${formatEuros(state.totalEur)}`}
          </p>
        </div>
        <button
          type="button"
          className="button button--primary session-resume__action"
          onClick={onEnterCart}
        >
          Reprendre
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="session-entry">
        <div className="session-entry__body">
          <p className="session-entry__title">
            {pendingScan === null ? 'Tu es au magasin ?' : 'Il faut d’abord ouvrir les courses'}
          </p>
          <p className="session-entry__lead">
            {pendingScan === null
              ? 'Scanne chaque produit en le mettant dans le caddie. Tout part au frigo d’un seul coup à la fin.'
              : 'Un produit scanné attend d’être mis au chariot. Choisis le magasin et il y sera ajouté.'}
          </p>
        </div>
        <button
          type="button"
          className="button button--primary session-entry__action"
          onClick={() => setOpening(true)}
        >
          Commencer les courses
        </button>
      </div>

      {opening && (
        <StartSheet
          isoWeek={isoWeek}
          onClose={() => setOpening(false)}
          onStarted={() => {
            setOpening(false)
            onEnterCart()
          }}
          onResume={() => {
            setOpening(false)
            // Le 409 prouve qu'une session existe : c'est le cache local qui
            // est en retard, pas le serveur. On le rafraichit et l'ecran
            // bascule tout seul sur le chariot.
            void query.refetch()
            onEnterCart()
          }}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Ouverture
// ---------------------------------------------------------------------------

function StartSheet({
  isoWeek,
  onClose,
  onStarted,
  onResume,
}: {
  isoWeek: string
  onClose: () => void
  onStarted: () => void
  onResume: () => void
}) {
  const start = useStartSession()
  const [store, setStore] = useState('')
  // Lus une fois : la liste ne bouge pas pendant que la feuille est ouverte.
  const [recent] = useState(readRecentStores)

  /*
   * Enseignes deja saisies, tirees de l'historique de prix — donc PARTAGEES
   * entre les deux telephones du foyer. `recentStores` ne connait que ce que
   * CET appareil a tape : l'un des deux ne verrait jamais les magasins de
   * l'autre.
   *
   * Les deux sources fusionnent, le local d'abord : un magasin saisi il y a
   * dix secondes n'est pas encore dans l'historique, le serveur ne l'ayant vu
   * qu'a la validation.
   */
  const stores = useStores()
  const suggestions = useMemo(() => {
    const seen = new Set<string>()
    const all: string[] = []
    for (const known of [...recent, ...(stores.data?.items ?? []).map((i) => i.store)]) {
      const key = known.trim().toLowerCase()
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      all.push(known)
    }
    return all.slice(0, 8)
  }, [recent, stores.data])

  const name = store.trim()

  const submit = () => {
    if (name === '') return
    start.mutate(
      { store: name, isoWeek },
      {
        onSuccess: () => {
          // Memorise seulement ce qui a REELLEMENT servi : un magasin refuse
          // par un 409 n'a pas ouvert de session.
          rememberStore(name)
          onStarted()
        },
      },
    )
  }

  // Le serveur nomme la session en cours dans son refus : on peut donc
  // proposer de la reprendre au lieu de laisser l'utilisateur devant une
  // erreur qu'il ne sait pas resoudre.
  const conflict =
    start.error instanceof ApiError && start.error.code === 'session_active' ? start.error : null
  const openStore =
    conflict !== null && typeof conflict.extra['store'] === 'string' ? conflict.extra['store'] : null
  const openCount =
    conflict !== null && typeof conflict.extra['itemCount'] === 'number'
      ? conflict.extra['itemCount']
      : null

  return (
    <Sheet
      open
      onClose={onClose}
      title="Commencer les courses"
      dismissible={!start.isPending}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={start.isPending}
          >
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={submit}
            disabled={start.isPending || name === ''}
          >
            {start.isPending ? 'Ouverture…' : 'C’est parti'}
          </button>
        </>
      }
    >
      <TextField
        label="Magasin"
        value={store}
        onChange={setStore}
        placeholder="Lidl, Intermarché, le marché…"
        autoFocus
        required
        autoComplete="off"
        enterKeyHint="go"
        hint="Demandé une seule fois : tous les prix relevés pendant la session seront enregistrés à ce nom."
      />

      {/* Les enseignes deja frequentees, en grandes cibles. */}
      {suggestions.length > 0 && (
        <div className="session-stores">
          {suggestions.map((known) => (
            <button
              key={known}
              type="button"
              className={`chip-toggle${known === name ? ' chip-toggle--on' : ''}`}
              onClick={() => setStore(known)}
              disabled={start.isPending}
            >
              {known}
            </button>
          ))}
        </div>
      )}

      {conflict !== null ? (
        <div className="session-conflict">
          <p className="status status--error" role="alert">
            Une session est déjà ouverte{openStore === null ? '' : ` chez ${openStore}`}
            {openCount === null ? '' : ` — ${openCount} article${openCount > 1 ? 's' : ''}`}.
          </p>
          <button type="button" className="button button--primary" onClick={onResume}>
            Reprendre cette session
          </button>
        </div>
      ) : (
        start.isError && (
          <p className="status status--error" role="alert">
            {start.error.message}
          </p>
        )
      )}
    </Sheet>
  )
}
