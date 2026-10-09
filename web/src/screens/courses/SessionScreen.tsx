/**
 * Le chariot — l'ecran tenu a une main, debout, dans un rayon.
 *
 * Trois informations ne quittent JAMAIS l'ecran : le magasin, le nombre
 * d'articles, le total qui monte. Elles vivent dans un en-tete collant. Et le
 * gros bouton Scanner reste fixe au-dessus de la barre d'onglets, sous le
 * pouce : c'est le geste qu'on repete trente fois, il ne se cherche pas.
 *
 * ---------------------------------------------------------------------------
 * LA CORRESPONDANCE AVEC LA LISTE
 * ---------------------------------------------------------------------------
 * Un article scanne qui etait sur la liste doit se voir. Le serveur fait deja
 * le rapprochement (`matchedIngredientIds`) : on s'en sert pour un compteur
 * « 7 sur 12 » en tete et pour la liste de ce qui reste a prendre.
 *
 * Une ligne deja cochee AVANT d'entrer en magasin — parce que le frigo la
 * couvrait — compte comme prise, sinon le compteur n'atteindrait jamais son
 * total et laisserait croire qu'on a oublie quelque chose.
 *
 * ---------------------------------------------------------------------------
 * L'ORDRE DU CHARIOT
 * ---------------------------------------------------------------------------
 * Du plus recent au plus ancien. On ne relit pas son chariot depuis le debut :
 * on verifie ce qu'on vient d'y mettre, et c'est tout. Le plus ancien article
 * est celui dont on est le plus sur.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { Icon } from '../../icons/index.js'
import { formatEuros, formatGrams, formatShoppingQuantity, type ShoppingSession } from '@prandia/shared'

import { ConfirmDialog } from '../../components/Sheet.js'
import { useToast } from '../../components/Toast.js'
import {
  useAbandonSession,
  useCommitSession,
  useShoppingList,
  type CommitResult,
  type SessionState,
} from '../../lib/queries.js'
import { CartLineSheet } from './CartLineSheet.js'
import type { ScanRequest } from '../../lib/useScanParam.js'
import { ScanToCart } from './ScanToCart.js'
import '../../styles/session.css'

export interface SessionScreenProps {
  readonly state: SessionState
  /** La session, deja tiree de `state` par l'appelant : le type evite un test de plus. */
  readonly session: ShoppingSession
  /** Bascule vers la liste de courses, qui partage cet onglet. */
  readonly onShowList: () => void
  /** Remonte le bilan de la validation : la session, elle, vient de disparaitre. */
  readonly onCommitted: (result: CommitResult) => void
  /** Code venu de l'URL, a traiter exactement comme s'il sortait de la camera. */
  readonly scan: ScanRequest | null
  /** Remonte que le code a ete pris en charge : l'ecran doit l'oublier. */
  readonly onScanTraite: () => void
}

export function SessionScreen({ state, session, onShowList, onCommitted, scan, onScanTraite }: SessionScreenProps) {
  // La liste de la semaine DE LA SESSION, et non celle qu'affichait l'ecran :
  // c'est elle que la validation cochera, et se tromper de semaine ici ferait
  // mentir tous les compteurs.
  const list = useShoppingList(session.isoWeek)
  const commit = useCommitSession()
  const abandon = useAbandonSession()
  const toast = useToast()

  const [dialog, setDialog] = useState<'none' | 'commit' | 'abandon'>('none')
  const [editingId, setEditingId] = useState<string | null>(null)
  // Ouvert quand le chariot est vide : au depart, ce qui reste a prendre EST
  // la liste entiere et c'est la seule chose utile a l'ecran. Passe le premier
  // article, le chariot reprend la vedette.
  const [remainingOpen, setRemainingOpen] = useState(() => session.items.length === 0)

  const items = session.items
  const itemCount = state.itemCount ?? items.length

  const matched = useMemo(
    () => new Set(state.matchedIngredientIds ?? []),
    [state.matchedIngredientIds],
  )
  const listItems = useMemo(() => list.data?.items ?? [], [list.data])
  const checked = useMemo(
    () => new Set(list.data?.checkedIngredientIds ?? []),
    [list.data],
  )
  const listIngredientIds = useMemo(
    () => new Set(listItems.map((item) => item.ingredientId)),
    [listItems],
  )

  const remaining = listItems.filter(
    (item) => !matched.has(item.ingredientId) && !checked.has(item.ingredientId),
  )
  const takenCount = listItems.length - remaining.length

  // Un article sans identifiant sera cree — ou rattache a une fiche existante
  // — a la validation. Dans les deux cas il entre en bibliotheque, et c'est ce
  // que l'annonce doit dire.
  const unknownCount = items.filter((item) => item.ingredientId === null).length
  const pricedCount = items.filter((item) => item.priceEur !== null).length

  const editing = editingId === null ? null : (items.find((item) => item.id === editingId) ?? null)
  const cart = [...items].reverse()

  return (
    <section className="screen screen--session">
      <header className="session-head">
        <div className="session-head__top">
          <div className="session-head__store">
            <p className="session-head__name">
              <Icon name="ui-cart" size={16} className="icon--inline" /> {session.store}
            </p>
            <p className="session-head__count">
              {itemCount} article{itemCount > 1 ? 's' : ''} dans le chariot
            </p>
          </div>
          <strong className="session-head__total">{formatEuros(state.totalEur ?? '0')}</strong>
        </div>

        {listItems.length > 0 && (
          <div className="session-progress">
            <div className="session-progress__track">
              <span
                className="session-progress__bar"
                style={{ width: `${Math.round((takenCount / listItems.length) * 100)}%` }}
              />
            </div>
            <p className="session-progress__label">
              {takenCount} sur {listItems.length} article{listItems.length > 1 ? 's' : ''} de ta
              liste
            </p>
          </div>
        )}

        <div className="session-head__actions">
          <button type="button" className="button button--secondary" onClick={onShowList}>
            Ma liste
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setDialog('commit')}
            disabled={items.length === 0}
          >
            Terminer
          </button>
        </div>
      </header>

      {remaining.length > 0 ? (
        <details
          className="session-remaining"
          open={remainingOpen}
          onToggle={(event) => setRemainingOpen(event.currentTarget.open)}
        >
          <summary className="session-remaining__summary">
            Reste à prendre — {remaining.length}
          </summary>
          <ul className="session-remaining__list">
            {/* Deja trie par rayon puis par nom cote serveur : on suit le
                magasin sans avoir a regrouper quoi que ce soit ici. */}
            {remaining.map((item) => (
              <li className="session-remaining__row" key={item.ingredientId}>
                <span className="session-remaining__name">{item.name}</span>
                <span className="session-remaining__quantity">
                  {formatShoppingQuantity(item)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        listItems.length > 0 && (
          <p className="status status--ok session-done">
            Tout ce qui était sur ta liste est dans le chariot.
          </p>
        )
      )}

      <div className="session-cart">
        <h2 className="session-cart__title">Chariot</h2>

        {items.length === 0 ? (
          <p className="session-cart__empty">
            Rien encore. Scanne ton premier produit en le posant dans le caddie — même s’il n’est
            pas sur ta liste.
          </p>
        ) : (
          <ul className="session-cart__list">
            {cart.map((item) => {
              const onList = item.ingredientId !== null && listIngredientIds.has(item.ingredientId)
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="session-line"
                    onClick={() => setEditingId(item.id)}
                  >
                    <span className="session-line__body">
                      <span className="session-line__name">{item.name}</span>
                      <span className="session-line__meta">
                        <span>{formatGrams(item.quantityG)}</span>
                        {item.brand !== null && <span>{item.brand}</span>}
                        {onList && <span className="badge badge--pantry">
                            <Icon name="ui-check" size={12} /> sur ta liste
                          </span>}
                      </span>
                    </span>
                    <span
                      className={`session-line__price${item.priceEur === null ? ' session-line__price--missing' : ''}`}
                    >
                      {item.priceEur === null ? 'sans prix' : formatEuros(item.priceEur)}
                    </span>
                    <span className="session-line__chevron" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Loin des autres commandes, et sous le chariot : on ne tombe pas
          dessus par accident en visant « Terminer ». */}
      <button
        type="button"
        className="button button--ghost session-abandon"
        onClick={() => setDialog('abandon')}
      >
        Abandonner cette session
      </button>

      <ScanToCart
        listIngredientIds={listIngredientIds}
        scan={scan}
        onScanTraite={onScanTraite}
      />

      {editing !== null && (
        <CartLineSheet
          item={editing}
          onList={editing.ingredientId !== null && listIngredientIds.has(editing.ingredientId)}
          onClose={() => setEditingId(null)}
          onRemoved={(name) => {
            setEditingId(null)
            toast.show({ message: `${name} retiré du chariot.` })
          }}
        />
      )}

      {/* Annoncer AVANT de faire : apres trente scans, « c'est enregistré »
          arrive trop tard pour qu'on puisse encore verifier quoi que ce soit. */}
      <ConfirmDialog
        open={dialog === 'commit'}
        title="Terminer les courses ?"
        message={commitAnnounce(items.length, unknownCount, pricedCount, session.store)}
        confirmLabel="Tout enregistrer"
        busy={commit.isPending}
        error={commit.error?.message}
        onClose={() => setDialog('none')}
        onConfirm={() => commit.mutate(undefined, { onSuccess: onCommitted })}
      />

      <ConfirmDialog
        open={dialog === 'abandon'}
        title="Abandonner les courses ?"
        message={`Le chariot et ses ${items.length} article${items.length > 1 ? 's' : ''} seront perdus, sans moyen de les retrouver. Rien n’a encore été écrit dans ton frigo ni dans ta bibliothèque : il n’y a rien d’autre à défaire.`}
        confirmLabel="Abandonner"
        danger
        busy={abandon.isPending}
        error={abandon.error?.message}
        onClose={() => setDialog('none')}
        onConfirm={() =>
          abandon.mutate(undefined, {
            onSuccess: () => {
              setDialog('none')
              toast.show({ message: 'Session abandonnée.' })
            },
          })
        }
      />
    </section>
  )
}

/** Ce que la validation va faire, en toutes lettres et au futur. */
function commitAnnounce(
  itemCount: number,
  unknownCount: number,
  pricedCount: number,
  store: string,
): string {
  const lines = [
    itemCount === 1 ? '1 article ira au frigo.' : `${itemCount} articles iront au frigo.`,
  ]
  if (unknownCount > 0) {
    lines.push(
      unknownCount === 1
        ? '1 produit encore inconnu rejoindra ta bibliothèque.'
        : `${unknownCount} produits encore inconnus rejoindront ta bibliothèque.`,
    )
  }
  if (pricedCount > 0) {
    lines.push(
      pricedCount === 1
        ? `1 prix sera enregistré chez ${store}.`
        : `${pricedCount} prix seront enregistrés chez ${store}.`,
    )
  }
  lines.push('Ta liste de la semaine sera cochée en conséquence.')
  return lines.join(' ')
}

// ---------------------------------------------------------------------------
// Bilan
// ---------------------------------------------------------------------------

/**
 * Ce qui a REELLEMENT ete ecrit, apres coup.
 *
 * Cet ecran survit a la session : elle n'existe plus quand il s'affiche. C'est
 * voulu — trente articles scannes meritent mieux qu'un retour silencieux a la
 * liste, et les chiffres viennent du serveur, pas d'une estimation locale.
 */
export function SessionSummary({
  result,
  onClose,
}: {
  readonly result: CommitResult
  readonly onClose: () => void
}) {
  return (
    <section className="screen">
      <div className="card session-summary">
        <h2 className="card__title">Courses enregistrées chez {result.store}</h2>

        <ul className="session-summary__list">
          <li>
            <strong>{result.stockedCount}</strong> article
            {result.stockedCount > 1 ? 's' : ''} rangé{result.stockedCount > 1 ? 's' : ''} au frigo
          </li>
          <li>
            <strong>{result.createdCount}</strong> nouvelle{result.createdCount > 1 ? 's' : ''}{' '}
            fiche{result.createdCount > 1 ? 's' : ''} en bibliothèque
          </li>
          <li>
            <strong>{result.pricedCount}</strong> prix relevé{result.pricedCount > 1 ? 's' : ''}{' '}
            chez {result.store}
          </li>
          <li>
            Total payé : <strong>{formatEuros(result.totalEur)}</strong>
          </li>
        </ul>

        <p className="card__lead">Ta liste de courses a été cochée en conséquence.</p>

        <div className="session-summary__actions">
          <button type="button" className="button button--primary" onClick={onClose}>
            Revenir à ma liste
          </button>
          <Link to="/frigo" className="button button--secondary lien-surface">
            Voir le frigo
          </Link>
        </div>
      </div>
    </section>
  )
}
