/**
 * Historique des prix — portage de PriceHistoryDialog.qml.
 *
 * Le point de bascule du modele : `ingredient.price_eur` n'est PAS saisissable.
 * C'est un cache de la derniere observation relevee ici. L'utilisateur note ce
 * qu'il voit en rayon, le prix de reference suit tout seul.
 *
 * Trois choix propres au telephone :
 *
 *   1. Le tableau a 7 colonnes du desktop devient une carte par observation.
 *      Le « € / 100 g » y est mis en avant : c'est la seule colonne qui permet
 *      de comparer deux enseignes, tout le reste est du contexte.
 *
 *   2. La date et l'enseigne SURVIVENT a un ajout, le prix et les notes sont
 *      vides. C'est le comportement du desktop et il est excellent : on est
 *      chez Auchan, on saisit cinq prix d'affilee.
 *
 *   3. La suppression demande confirmation, alors que le desktop supprimait
 *      sans filet. Une croix de 44 px se rate au doigt, et la table est
 *      volontairement sans modification : une observation supprimee par erreur
 *      se resaisit entierement.
 */

import { useState, type FormEvent } from 'react'
import { formatEuros, formatGrams, pricePerG, todayLocalIsoDate, type Ingredient } from '@prandia/shared'

import { DateField, NumberField, TextField } from '../../components/Field.js'
import { Icon } from '../../icons/index.js'
import { useStores } from '../../lib/queries.js'
import { ConfirmDialog, Sheet } from '../../components/Sheet.js'
import { ErrorState, LoadingRows } from '../../components/States.js'
import {
  useAddPrice,
  useDeletePrice,
  usePriceHistory,
  type PriceEntry,
} from '../../lib/queries.js'
import '../../styles/ingredients.css'

/** Quantite proposee par defaut, dans l'ordre : celle de la fiche, puis 100 g. */
const defaultQuantity = (ingredient: Ingredient): number => ingredient.priceQuantityG ?? 100

export interface PriceHistorySheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly ingredient: Ingredient
}

export function PriceHistorySheet({ open, onClose, ingredient }: PriceHistorySheetProps) {
  const id = ingredient.id
  const history = usePriceHistory(open && id !== null ? id : null)

  return (
    <Sheet open={open} onClose={onClose} title={`Prix · ${ingredient.name}`}>
      {id === null ? (
        <p className="card__lead">Enregistre d’abord l’ingrédient pour pouvoir relever son prix.</p>
      ) : (
        <>
          <PriceForm ingredient={ingredient} ingredientId={id} entries={history.data?.items ?? []} />

          {history.isPending && <LoadingRows rows={3} />}
          {history.isError && (
            <ErrorState error={history.error} onRetry={() => void history.refetch()} />
          )}
          {history.isSuccess && <PriceList ingredientId={id} entries={history.data.items} />}
        </>
      )}
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Saisie
// ---------------------------------------------------------------------------

function PriceForm({
  ingredient,
  ingredientId,
  entries,
}: {
  ingredient: Ingredient
  ingredientId: number
  entries: readonly PriceEntry[]
}) {
  const add = useAddPrice(ingredientId)

  const [recordedAt, setRecordedAt] = useState<string | null>(todayLocalIsoDate())
  const [store, setStore] = useState('')
  const [quantityG, setQuantityG] = useState<number | null>(defaultQuantity(ingredient))
  const [price, setPrice] = useState<number | null>(null)
  const [notes, setNotes] = useState('')

  /*
   * Enseignes proposees pendant la frappe.
   *
   * Deux sources, dans cet ordre : celles deja saisies pour CET ingredient —
   * les plus probables, on rachete au meme endroit — puis toutes celles du
   * foyer, les plus frequentes d'abord.
   *
   * Le commentaire precedent affirmait qu'aucune route `/api/stores` n'existait
   * et se limitait donc a l'ingredient courant. Elle existe : elle a ete
   * ajoutee pour la session de courses, et personne n'est revenu ici.
   */
  const stores = useStores()
  const knownStores = [
    ...new Set([
      ...entries.map((entry) => entry.store).filter((s): s is string => !!s),
      ...(stores.data?.items ?? []).map((s) => s.store),
    ]),
  ]

  const canSubmit =
    price !== null && price > 0 && quantityG !== null && quantityG > 0 && recordedAt !== null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit || price === null || quantityG === null || recordedAt === null) return

    add.mutate(
      {
        // Les montants transitent en CHAINE decimale, jamais en nombre : un
        // flottant ne represente pas 0,1 € et l'ecart s'accumule sur une liste
        // de courses. `toFixed(2)` produit exactement la forme attendue.
        priceEur: price.toFixed(2),
        quantityG,
        store: store.trim() === '' ? null : store.trim(),
        recordedAt,
        notes: notes.trim() === '' ? null : notes.trim(),
      },
      {
        onSuccess: () => {
          // Date et enseigne conservees : on saisit en rafale, devant le rayon.
          setPrice(null)
          setNotes('')
          setQuantityG(defaultQuantity(ingredient))
        },
      },
    )
  }

  return (
    <form className="form" onSubmit={submit}>
      <DateField label="Date du relevé" value={recordedAt} onChange={setRecordedAt} required />

      <TextField
        label="Enseigne"
        value={store}
        onChange={setStore}
        placeholder="Lidl, Auchan…"
        autoComplete="off"
        suggestions={knownStores}
        id="price-store"
      />
      {knownStores.length > 0 && (
        <ul className="ing-store-suggestions">
          {knownStores.map((known) => (
            <li key={known}>
              <button
                type="button"
                className={`ing-chip${store === known ? ' ing-chip--on' : ''}`}
                onClick={() => setStore(known)}
              >
                {known}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="form__row">
        <NumberField
          label="Quantité"
          value={quantityG}
          onChange={setQuantityG}
          suffix="g"
          min={0}
          max={100000}
          decimals={1}
          required
        />
        <NumberField
          label="Prix payé"
          value={price}
          onChange={setPrice}
          suffix="€"
          min={0}
          decimals={2}
          required
        />
      </div>

      <TextField label="Notes" value={notes} onChange={setNotes} placeholder="Promo, format familial… (optionnel)" />

      {add.isError && (
        <p className="field__error" role="alert">
          {add.error.message}
        </p>
      )}

      <button type="submit" className="button button--primary button--block" disabled={!canSubmit || add.isPending}>
        {add.isPending ? 'Enregistrement…' : '+ Ajouter ce relevé'}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Releves
// ---------------------------------------------------------------------------

/** Prix ramene a 100 g — la seule valeur qui permette de comparer deux enseignes. */
function per100g(entry: PriceEntry): string {
  const perGram = pricePerG({ priceEur: entry.priceEur, priceQuantityG: entry.quantityG })
  return perGram === null ? '—' : formatEuros(perGram.mul(100))
}

function PriceList({ ingredientId, entries }: { ingredientId: number; entries: readonly PriceEntry[] }) {
  const remove = useDeletePrice(ingredientId)
  const [pending, setPending] = useState<PriceEntry | null>(null)

  if (entries.length === 0) {
    return (
      <p className="card__lead">
        Aucune observation enregistrée. Le prix de référence reste vide tant qu’aucun relevé n’existe.
      </p>
    )
  }

  // La route rend les releves du plus recent au plus ancien : le premier de la
  // liste est celui qui alimente le prix de reference de la fiche.
  const newest = entries[0]
  const oldest = entries[entries.length - 1]

  return (
    <section className="ing-history">
      <p className="ing-history__summary">
        {entries.length} observation{entries.length > 1 ? 's' : ''}
        {newest && oldest && ` · du ${oldest.recordedAt} au ${newest.recordedAt}`}
      </p>

      <ul className="ing-history__list">
        {entries.map((entry, index) => (
          <li key={entry.id} className="ing-observation">
            <div className="ing-observation__body">
              <p className="ing-observation__head">
                <span className="ing-observation__per100">{per100g(entry)} / 100 g</span>
                {index === 0 && <span className="badge badge--season">prix de référence</span>}
              </p>
              <p className="ing-observation__meta">
                {entry.recordedAt}
                {' · '}
                {entry.store ?? 'enseigne non précisée'}
                {' · '}
                {formatEuros(entry.priceEur)} pour {formatGrams(entry.quantityG)}
              </p>
              {entry.notes && <p className="ing-observation__notes">{entry.notes}</p>}
            </div>
            <button
              type="button"
              className="ing-observation__remove"
              onClick={() => setPending(entry)}
              aria-label={`Supprimer le relevé du ${entry.recordedAt}`}
            >
              <Icon name="ui-close" size={16} />
            </button>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={pending !== null}
        title="Supprimer ce relevé ?"
        message={
          pending
            ? `Le relevé du ${pending.recordedAt} (${formatEuros(pending.priceEur)} pour ${formatGrams(pending.quantityG)}) sera définitivement effacé. Les relevés ne se modifient pas : pour corriger une faute de frappe, supprime puis ressaisis.`
            : ''
        }
        confirmLabel="Supprimer"
        danger
        busy={remove.isPending}
        error={remove.error?.message}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending === null) return
          remove.mutate(pending.id, { onSuccess: () => setPending(null) })
        }}
      />
    </section>
  )
}
