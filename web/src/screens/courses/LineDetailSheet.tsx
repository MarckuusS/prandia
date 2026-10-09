/**
 * Detail d'une ligne de courses.
 *
 * Le desktop n'avait aucune action au niveau de la ligne : ni clic, ni menu
 * contextuel, ni moyen de savoir d'ou sortait une quantite ou de corriger un
 * prix manquant. L'inventaire de parite releve les deux frictions ; cette
 * feuille y repond en un seul endroit, atteignable d'un pouce depuis la ligne.
 *
 * Elle reste secondaire : on peut faire ses courses entieres sans jamais
 * l'ouvrir. Rien d'indispensable ne doit donc y etre enferme.
 */

import { useState } from 'react'
import { Link } from 'react-router'
import {
  formatEuros,
  formatGrams,
  formatShoppingQuantity,
  todayLocalIsoDate,
  type ShoppingItem,
} from '@prandia/shared'

import { NumberField, TextField } from '../../components/Field.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Sheet } from '../../components/Sheet.js'
import { ErrorState, LoadingRows, SourceBadge } from '../../components/States.js'
import { useAddPrice, useCalendar } from '../../lib/queries.js'
import { explainQuantity } from './provenance.js'

export interface LineDetailSheetProps {
  readonly isoWeek: string
  readonly item: ShoppingItem
  readonly checked: boolean
  readonly onToggle: (next: boolean) => void
  readonly onClose: () => void
}

export function LineDetailSheet({ isoWeek, item, checked, onToggle, onClose }: LineDetailSheetProps) {
  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            Fermer
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              onToggle(!checked)
              onClose()
            }}
          >
            {checked ? 'Décocher' : 'Cocher'}
          </button>
        </>
      }
    >
      <dl className="kv">
        <div className="kv__pair">
          <dt>Quantité</dt>
          <dd>{formatShoppingQuantity(item)}</dd>
        </div>
        <div className="kv__pair">
          <dt>Coût</dt>
          {/* Absence = « — », jamais 0 : un prix inconnu n'est pas un prix nul. */}
          <dd>{formatEuros(item.costEur)}</dd>
        </div>
        <div className="kv__pair">
          <dt>Déjà au frigo</dt>
          <dd>{item.inPantryG > 0 ? formatGrams(item.inPantryG) : '—'}</dd>
        </div>
        <div className="kv__pair">
          <dt>Rayon</dt>
          <dd>{item.categoryL1 ?? '—'}</dd>
        </div>
      </dl>

      <p className="line-detail__links">
        <SourceBadge source={item.source} />
        <Link className="line-detail__link" to={`/ingredients/${item.ingredientId}`}>
          Voir la fiche de l’ingrédient
        </Link>
      </p>

      <Provenance ingredientId={item.ingredientId} isoWeek={isoWeek} />

      <PriceCapture item={item} />
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// D'ou vient la quantite
// ---------------------------------------------------------------------------

function Provenance({ ingredientId, isoWeek }: { ingredientId: number; isoWeek: string }) {
  // La semaine n'est chargee qu'a l'ouverture de la feuille, ce composant
  // n'existant pas avant. Elle est le plus souvent deja en cache, l'onglet
  // Semaine partageant la meme cle de requete.
  const week = useCalendar(isoWeek)
  const sources = week.data ? explainQuantity(ingredientId, week.data) : []

  return (
    <section className="line-detail__section">
      <h3 className="line-detail__title">D’où vient cette quantité</h3>

      {week.isPending && <LoadingRows rows={2} />}
      {week.isError && <ErrorState error={week.error} onRetry={() => void week.refetch()} />}

      {week.isSuccess && sources.length === 0 && (
        <p className="line-detail__empty">
          Aucun repas de la semaine ne la réclame — le planning a dû changer depuis le dernier
          calcul.
        </p>
      )}

      {sources.length > 0 && (
        <ul className="row-list row-list--flush">
          {sources.map((source) => (
            <li key={source.key} className="row row--static">
              <span className="row__body">
                <span className="row__title">
                  {source.recipeId === null ? (
                    source.title
                  ) : (
                    <Link className="line-detail__link" to={`/recettes/${source.recipeId}`}>
                      {source.title}
                    </Link>
                  )}
                </span>
                <span className="row__meta">{source.when}</span>
              </span>
              <span className="row__value">{formatGrams(source.quantityG)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Saisie rapide du prix
// ---------------------------------------------------------------------------

/**
 * Le prix se lit sur l'etiquette, dans le rayon, a l'instant ou l'on constate
 * qu'il manque. C'est le seul moment ou l'utilisateur l'a sous les yeux : le
 * desktop l'obligeait a s'en souvenir jusqu'a l'onglet Ingredients.
 *
 * L'enregistrement passe par l'historique des prix (`POST .../prices`), pas par
 * une modification directe de l'ingredient : c'est l'historique qui fait foi et
 * qui met a jour le prix courant en cascade.
 */
function PriceCapture({ item }: { item: ShoppingItem }) {
  const add = useAddPrice(item.ingredientId)
  // Un prix connu se corrige rarement : le formulaire reste replie, alors
  // qu'un prix manquant est justement ce qu'on vient traiter ici.
  const [open, setOpen] = useState(item.costEur === null)
  const [priceEur, setPriceEur] = useState<number | null>(null)
  const [quantityG, setQuantityG] = useState<number | null>(1000)
  const [store, setStore] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)

  if (!open) {
    return (
      <section className="line-detail__section">
        <button type="button" className="button button--secondary button--block" onClick={() => setOpen(true)}>
          Corriger le prix
        </button>
      </section>
    )
  }

  const submit = () => {
    if (priceEur === null || priceEur <= 0) {
      setInvalid('Le prix doit être strictement positif.')
      return
    }
    if (quantityG === null || quantityG <= 0) {
      setInvalid('Une quantité (g) doit être strictement positive.')
      return
    }
    setInvalid(null)
    add.mutate(
      {
        // Montant serialise en chaine decimale, comme partout dans l'API : un
        // flottant ne represente pas exactement 1,15 €.
        priceEur: priceEur.toFixed(2),
        quantityG,
        store: store.trim() === '' ? null : store.trim(),
        // Date LOCALE : `toISOString()` proposerait la veille passe 22 h en
        // France l'ete.
        recordedAt: todayLocalIsoDate(),
        notes: null,
      },
      {
        onSuccess: () => {
          setPriceEur(null)
          setStore('')
          setOpen(false)
        },
      },
    )
  }

  return (
    <section className="line-detail__section">
      <h3 className="line-detail__title">
        {item.costEur === null ? 'Aucun prix connu' : 'Nouveau relevé de prix'}
      </h3>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <NumberField
          label="Prix relevé"
          value={priceEur}
          onChange={setPriceEur}
          decimals={2}
          min={0}
          suffix="€"
          required
          error={invalid}
        />
        <QuantityField
          label="Pour cette quantité"
          value={quantityG}
          onChange={setQuantityG}
          pieceWeightG={item.pieceWeightG}
          // Forcee au kilo : c'est l'unite des etiquettes de rayon. Sans cela,
          // un ingredient a la piece s'ouvrirait sur « 16,7 pieces ».
          unit="kg"
          required
        />
        <TextField
          label="Magasin"
          value={store}
          onChange={setStore}
          placeholder="Lidl, marché…"
          hint="Facultatif — utile pour comparer plus tard."
        />
        <button type="submit" className="button button--primary button--block" disabled={add.isPending}>
          {add.isPending ? 'Enregistrement…' : 'Enregistrer le prix'}
        </button>
        {add.isError && (
          <p className="text-error" role="alert">
            {add.error.message}
          </p>
        )}
      </form>
    </section>
  )
}
