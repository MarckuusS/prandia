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

import { Savarin } from '../../components/Savarin.js'
import { TextField } from '../../components/Field.js'
import { ConfirmDialog, Sheet } from '../../components/Sheet.js'
import { useToast } from '../../components/Toast.js'
import {
  useAbandonSession,
  useCommitSession,
  useShoppingList,
  useStores,
  type CommitResult,
  type SessionState,
} from '../../lib/queries.js'
import { CartLineSheet } from './CartLineSheet.js'
import { lectureDeLArticle, oublierLectures, useLectures, type Lecture } from './lecturesArticle.js'
import type { ScanRequest } from '../../lib/useScanParam.js'
import { ScanToCart } from './ScanToCart.js'
import { TicketCaisse } from './TicketCaisse.js'
import { readRecentStores, rememberStore } from './recentStores.js'
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
  /** "Ranger mes courses" vient d'etre touche : le scan en chaine s'ouvre aussitot. */
  readonly ouvrirChaine?: boolean | undefined
}

export function SessionScreen({
  state,
  session,
  onShowList,
  onCommitted,
  scan,
  onScanTraite,
  ouvrirChaine = false,
}: SessionScreenProps) {
  // La liste de la semaine DE LA SESSION, et non celle qu'affichait l'ecran :
  // c'est elle que la validation cochera, et se tromper de semaine ici ferait
  // mentir tous les compteurs.
  const list = useShoppingList(session.isoWeek)
  const commit = useCommitSession()
  const abandon = useAbandonSession()
  const toast = useToast()

  const [dialog, setDialog] = useState<'none' | 'commit' | 'abandon'>('none')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [ticketOuvert, setTicketOuvert] = useState(false)
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
  // Le vrac pese en caisse attend son poids : la validation le refuserait.
  const aPeserCount = items.filter((item) => item.quantityG === null && item.aPeser).length
  // Ce que Savarin n'a pas su lire (ou lit encore) : un nom, un poids.
  const incomplets = items.filter((item) => item.name.trim() === '' || (item.quantityG === null && !item.aPeser))

  /*
   * LES TROIS ETAPES du rangement : scanner chaque produit, lire le ticket (il
   * donne les prix), terminer. L'etape en cours porte le seul aplat de la
   * rangee : on sait toujours quoi faire ensuite.
   */
  const etape: 1 | 2 | 3 = items.length === 0 ? 1 : pricedCount < items.length ? 2 : 3
  /** Pret a valider, mais sans magasin : la validation le demande. */
  const magasinADemander = incomplets.length === 0 && aPeserCount === 0 && session.store === ''

  const editing = editingId === null ? null : (items.find((item) => item.id === editingId) ?? null)
  // Les lectures de Savarin en arriere-plan : un logo en face de chaque ligne.
  const lectures = useLectures()
  const enLecture = items.filter((item) => lectureDeLArticle(lectures, item.id)?.etat === 'lecture').length
  const cart = [...items].reverse()

  return (
    <section className="screen screen--session">
      <header className="session-head">
        <div className="session-head__top">
          <div className="session-head__store">
            <p className="session-head__name">
              <Icon name="ui-cart" size={16} className="icon--inline" />{' '}
              {session.store === '' ? 'Mes courses' : session.store}
            </p>
            <p className="session-head__count">
              {itemCount} article{itemCount > 1 ? 's' : ''} dans le chariot
            </p>
          </div>
          {/* Le total n'a de sens qu'avec des prix : avant le ticket, il dirait 0 €. */}
          {pricedCount > 0 && <strong className="session-head__total">{formatEuros(state.totalEur ?? '0')}</strong>}
        </div>

        <ol className="etapes" aria-label="Les étapes">
          {(['Scanner les produits', 'Lire le ticket', 'Terminer'] as const).map((libelle, i) => (
            <li
              key={libelle}
              className={`etapes__item${i + 1 < etape ? ' etapes__item--fait' : ''}${i + 1 === etape ? ' etapes__item--courante' : ''}`}
              aria-current={i + 1 === etape ? 'step' : undefined}
            >
              <span className="etapes__numero" aria-hidden="true">
                {i + 1 < etape ? <Icon name="ui-check" size={12} /> : i + 1}
              </span>
              {libelle}
            </li>
          ))}
        </ol>

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
          {/* Entre la liste et Terminer, dans l'ordre des gestes : on passe en
              caisse, on lit le ticket, on termine. */}
          <button
            type="button"
            className={`button ${etape === 2 ? 'button--primary' : 'button--secondary'}`}
            onClick={() => setTicketOuvert(true)}
            disabled={items.length === 0}
          >
            Lire le ticket
          </button>
          <button
            type="button"
            className={`button ${etape === 3 ? 'button--primary' : 'button--secondary'}`}
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
            Pas encore dans le chariot : {remaining.length}
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
            Rien encore. Scanne chaque produit avant de le ranger : le code-barres, puis la face
            avant, le poids et la date. Même ce qui n’était pas sur ta liste.
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
                      {item.name.trim() === '' ? (
                        <span className="session-line__name session-line__name--attente">
                          {lectureDeLArticle(lectures, item.id)?.etat === 'lecture'
                            ? 'Savarin lit la face avant…'
                            : 'Nom à compléter'}
                        </span>
                      ) : (
                        <span className="session-line__name">{item.name}</span>
                      )}
                      <span className="session-line__meta">
                        {item.quantityG === null ? (
                          <span className="badge badge--a-peser">
                            {item.aPeser ? 'à peser en caisse' : 'poids à lire'}
                          </span>
                        ) : (
                          <span>
                            {item.aPeser ? 'environ ' : ''}
                            {formatGrams(item.quantityG)}
                          </span>
                        )}
                        {item.brand !== null && <span>{item.brand}</span>}
                        {onList && <span className="badge badge--pantry">
                            <Icon name="ui-check" size={12} /> sur ta liste
                          </span>}
                      </span>
                    </span>
                    <LogoSavarin lecture={lectureDeLArticle(lectures, item.id)} />
                    <span
                      className={`session-line__price${item.priceEur === null ? ' session-line__price--missing' : ''}`}
                    >
                      {/* Le prix vient du ticket, a la fin : "sans prix" sonnait comme un oubli. */}
                      {item.priceEur === null ? 'prix au ticket' : formatEuros(item.priceEur)}
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
        ouvrirAuDepart={ouvrirChaine}
      />

      {ticketOuvert && (
        <TicketCaisse items={items} magasin={session.store} onClose={() => setTicketOuvert(false)} />
      )}

      {/* Pret, mais sans magasin (ni donne, ni lu sur le ticket) : la
          validation le demande, en grandes cibles. */}
      {dialog === 'commit' && magasinADemander && (
        <ValiderAvecMagasin
          annonce={commitAnnounce(items.length, unknownCount, pricedCount, null)}
          enLecture={enLecture}
          busy={commit.isPending}
          error={commit.error?.message}
          onClose={() => setDialog('none')}
          onConfirm={(magasin) =>
            commit.mutate(magasin, {
              onSuccess: (result) => {
                rememberStore(magasin)
                oublierLectures()
                onCommitted(result)
              },
            })
          }
        />
      )}

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
        open={dialog === 'commit' && !magasinADemander}
        title="Terminer les courses ?"
        message={
          incomplets.length > 0
            ? `${incomplets.length === 1 ? 'Un article est incomplet' : `${incomplets.length} articles sont incomplets`} : nom ou poids encore à lire. Ouvre ${incomplets.length === 1 ? 'sa ligne' : 'leurs lignes'} dans le chariot pour compléter.`
            : aPeserCount > 0
              ? `${aPeserCount === 1 ? 'Un article attend encore son poids' : `${aPeserCount} articles attendent encore leur poids`} : le ticket le donne. Tu peux aussi le saisir dans l’article.`
              : `${enLecture > 0 ? `Savarin lit encore ${enLecture === 1 ? 'les photos d’un article' : `les photos de ${enLecture} articles`} : attends-le, ou ce qu’il lit sera perdu. ` : ''}${commitAnnounce(items.length, unknownCount, pricedCount, session.store)}`
        }
        // Le serveur refuserait la validation : le bouton mene la ou elle se
        // debloque, plutot qu'a une erreur.
        confirmLabel={incomplets.length > 0 ? 'Voir le chariot' : aPeserCount > 0 ? 'Lire le ticket' : 'Tout enregistrer'}
        busy={commit.isPending}
        error={commit.error?.message}
        onClose={() => setDialog('none')}
        onConfirm={() => {
          if (incomplets.length > 0) {
            setDialog('none')
            return
          }
          if (aPeserCount > 0) {
            setDialog('none')
            setTicketOuvert(true)
            return
          }
          commit.mutate(undefined, {
            onSuccess: (result) => {
              oublierLectures()
              onCommitted(result)
            },
          })
        }}
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
              oublierLectures()
              setDialog('none')
              toast.show({ message: 'Session abandonnée.' })
            },
          })
        }
      />
    </section>
  )
}

/**
 * Savarin en face d'une ligne du chariot : il reflechit pendant qu'il lit les
 * photos, il reste, encadre, une fois l'article rempli, jusqu'a ce qu'on
 * rouvre la ligne (on peut aussi ne jamais la rouvrir : l'article est deja
 * rempli). Une lecture ratee porte un "!" : la ligne dit pourquoi, et relance.
 */
function LogoSavarin({ lecture }: { readonly lecture: Lecture | undefined }) {
  if (lecture === undefined || (lecture.etat === 'lue' && lecture.vue)) return null
  const etiquette =
    lecture.etat === 'lecture'
      ? 'Savarin lit les photos'
      : lecture.etat === 'lue'
        ? 'Rempli par Savarin'
        : 'Lecture de Savarin ratée'
  return (
    <span className={`session-line__savarin session-line__savarin--${lecture.etat}`} role="img" aria-label={etiquette}>
      <Savarin size={20} occupe={lecture.etat === 'lecture'} />
      {lecture.etat === 'echec' && <span className="session-line__savarin-signal">!</span>}
    </span>
  )
}

/**
 * La validation, quand le magasin manque encore : ni donne au depart, ni lu
 * sur le ticket. Les prix sont enregistres a son nom ; les enseignes deja
 * frequentees (cet appareil, puis l'historique des prix du foyer) sont
 * proposees en grandes cibles.
 */
function ValiderAvecMagasin({
  annonce,
  enLecture,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  readonly annonce: string
  readonly enLecture: number
  readonly busy: boolean
  readonly error: string | undefined
  readonly onClose: () => void
  readonly onConfirm: (magasin: string) => void
}) {
  const [magasin, setMagasin] = useState('')
  const [recents] = useState(readRecentStores)
  const stores = useStores()
  const suggestions = useMemo(() => {
    const vus = new Set<string>()
    const tous: string[] = []
    for (const connu of [...recents, ...(stores.data?.items ?? []).map((i) => i.store)]) {
      const cle = connu.trim().toLowerCase()
      if (cle === '' || vus.has(cle)) continue
      vus.add(cle)
      tous.push(connu)
    }
    return tous.slice(0, 8)
  }, [recents, stores.data])
  const nom = magasin.trim()

  return (
    <Sheet
      open
      onClose={onClose}
      title="Terminer les courses"
      dismissible={!busy}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="button" className="button button--primary" onClick={() => onConfirm(nom)} disabled={busy || nom === ''}>
            {busy ? 'Enregistrement…' : 'Tout enregistrer'}
          </button>
        </>
      }
    >
      <TextField
        label="Où as-tu fait ces courses ?"
        value={magasin}
        onChange={setMagasin}
        placeholder="Lidl, Carrefour, le marché…"
        autoComplete="off"
        hint="Les prix seront enregistrés à ce nom."
      />
      {suggestions.length > 0 && (
        <div className="session-stores">
          {suggestions.map((connu) => (
            <button
              key={connu}
              type="button"
              className={`chip-toggle${connu === nom ? ' chip-toggle--on' : ''}`}
              onClick={() => setMagasin(connu)}
              disabled={busy}
            >
              {connu}
            </button>
          ))}
        </div>
      )}
      <p className="card__lead">
        {enLecture > 0
          ? `Savarin lit encore ${enLecture === 1 ? 'les photos d’un article' : `les photos de ${enLecture} articles`} : attends-le, ou ce qu’il lit sera perdu. `
          : ''}
        {annonce}
      </p>
      {error !== undefined && (
        <p className="status status--error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  )
}

/** Ce que la validation va faire, en toutes lettres et au futur. */
function commitAnnounce(
  itemCount: number,
  unknownCount: number,
  pricedCount: number,
  store: string | null,
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
        : `${pricedCount} prix seront enregistrés${store === null ? '' : ` chez ${store}`}.`,
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
            {/* Ils arrivent dans "À ranger" : aucun n'a encore sa place. */}
            <strong>{result.stockedCount}</strong> article
            {result.stockedCount > 1 ? 's' : ''} à ranger
          </li>
          <li>
            <strong>{result.createdCount}</strong> nouvelle{result.createdCount > 1 ? 's' : ''}{' '}
            fiche{result.createdCount > 1 ? 's' : ''} en bibliothèque
          </li>
          <li>
            <strong>{result.pricedCount}</strong> prix relevé{result.pricedCount > 1 ? 's' : ''}{' '}
            chez {result.store}
          </li>
          {result.pricedCount > 0 && (
            <li>
              Total payé : <strong>{formatEuros(result.totalEur)}</strong>
            </li>
          )}
        </ul>

        <p className="card__lead">Ta liste de courses a été cochée en conséquence.</p>

        {/* La suite du rangement : les produits attendent dans "À ranger", où
            "Tout ranger comme d'habitude" les met en place d'un geste. */}
        <div className="session-summary__actions">
          <Link to="/frigo?ou=ranger" className="button button--primary lien-surface">
            Ranger au frigo
          </Link>
          <button type="button" className="button button--secondary" onClick={onClose}>
            Revenir à ma liste
          </button>
        </div>
      </div>
    </section>
  )
}
