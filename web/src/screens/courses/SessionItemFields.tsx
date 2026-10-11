/**
 * Les QUATRE champs de la confirmation : nom, marque, quantite, prix. Et une
 * date de peremption REPLIEE.
 *
 * Quatre, et pas un de plus. Le magasin a ete demande une fois au depart, les
 * macros sont deja dans le brouillon et n'ont rien a faire devant un rayon, la
 * date du releve est celle du jour. Chaque champ ajoute ici serait paye trente
 * fois par course. La date de peremption l'a ete a la demande, mais REPLIEE
 * derriere un bouton : ne pas la toucher ne coute rien, et elle se donne
 * aussi en rangeant, a la maison.
 *
 * L'ordre suit celui du regard sur l'emballage : ce que c'est, de qui, combien
 * il y en a, combien ca coute. Le prix vient en dernier parce que c'est le
 * seul que l'utilisateur doit VRAIMENT saisir — il finit sous le clavier
 * ouvert, la ou il est le plus accessible.
 */

import { useState } from 'react'
import { formatEuros } from '@prandia/shared'

import { DatePeremption } from '../../components/DatePeremption.js'
import { NumberField, TextField } from '../../components/Field.js'
import { QuantityField } from '../../components/QuantityField.js'
import { Icon } from '../../icons/index.js'
import type { ObservedPrice } from '../../lib/queries.js'
import type { ItemDraft } from './sessionDraft.js'

/** « 2026-07-21 » -> « 21 juil. 2026 ». */
function formatDay(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

export interface SessionItemFieldsProps {
  readonly draft: ItemDraft
  readonly onChange: (draft: ItemDraft) => void
  /** Vrai quand l'article correspond a une ligne de la liste de courses. */
  readonly onList?: boolean | undefined
  /** Prix constates pour ce code-barres. Absent sur un article sans code. */
  readonly observed?: ObservedPrice | undefined
  readonly observedPending?: boolean | undefined
  /** Vrai tant que le montant affiche vient d'Open Prices et non d'une saisie. */
  readonly priceIsSuggested?: boolean | undefined
  /**
   * D'ou vient le montant quand c'est TON dernier prix ("Ton dernier prix chez
   * Lidl, le 20 sept."), tant qu'on n'y a pas touche ; sinon `null`.
   */
  readonly ownPriceSource?: string | null | undefined
  readonly error?: string | null | undefined
  readonly disabled?: boolean | undefined
}

export function SessionItemFields({
  draft,
  onChange,
  onList,
  observed,
  observedPending,
  priceIsSuggested,
  ownPriceSource,
  error,
  disabled,
}: SessionItemFieldsProps) {
  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) =>
    onChange({ ...draft, [key]: value })
  const [dateOuverte, setDateOuverte] = useState(draft.expiryDate !== null)

  return (
    <>
      {/* La correspondance avec la liste est annoncee AVANT les champs : c'est
          l'information qui dit « tu as bien pris ce que tu venais chercher »,
          et elle ne doit pas etre a decouvrir sous le clavier. */}
      {onList === true && (
        <p className="status status--ok session-match" role="status">
          <Icon name="ui-check" size={16} className="icon--inline" /> Cet article était sur ta
          liste
        </p>
      )}

      <TextField
        label="Nom"
        value={draft.name}
        onChange={(value) => set('name', value)}
        required
        disabled={disabled}
        autoComplete="off"
      />

      <TextField
        label="Marque"
        value={draft.brand}
        onChange={(value) => set('brand', value)}
        placeholder="Facultatif"
        disabled={disabled}
        autoComplete="off"
      />

      {/* Piece-aware : « 1 pièce (400 g) » quand la contenance est connue,
          grammes sinon. Le champ reste modifiable en toutes circonstances —
          800 g de boeuf au rayon boucherie ne se deduisent d'aucun code. */}
      <QuantityField
        label="Quantité"
        value={draft.quantityG}
        onChange={(quantityG) => set('quantityG', quantityG)}
        pieceWeightG={draft.pieceWeightG}
        required
        disabled={disabled}
        hint="Ce qui entre vraiment dans le chariot : deux paquets, c'est deux fois la contenance."
      />

      <NumberField
        label="Prix payé"
        value={draft.priceEur}
        onChange={(priceEur) => set('priceEur', priceEur)}
        suffix="€"
        min={0}
        decimals={2}
        emptyOnZero
        placeholder="2,49"
        disabled={disabled}
        hint="Facultatif — sans lui l'article compte dans le chariot, mais pas dans le total."
      />

      {ownPriceSource !== null && ownPriceSource !== undefined && (
        <p className="session-observed">
          {ownPriceSource} Il est pré-rempli : corrige-le si l’étiquette dit autre chose.
        </p>
      )}

      {observedPending === true && <p className="field__hint">Recherche des prix constatés…</p>}

      {/* L'etendue et le nombre de releves accompagnent TOUJOURS le montant :
          une mediane presentee seule passerait pour un prix officiel, alors que
          l'ecart entre deux releves depasse souvent l'euro. */}
      {observed?.found === true && (
        <p className="session-observed">
          Prix médian relevé par Open Prices :{' '}
          <strong>{formatEuros(observed.priceEur ?? null)}</strong>
          {observed.minEur && observed.maxEur && (
            <>
              {' '}
              — observé entre {formatEuros(observed.minEur)} et {formatEuros(observed.maxEur)} sur{' '}
              {observed.sampleCount} relevé{observed.sampleCount > 1 ? 's' : ''}
              {observed.lastSeen ? `, le plus récent du ${formatDay(observed.lastSeen)}` : ''}
            </>
          )}
          .{priceIsSuggested === true && ' Il est pré-rempli : corrige-le si l’étiquette dit autre chose.'}
        </p>
      )}

      {dateOuverte ? (
        <DatePeremption
          value={draft.expiryDate}
          onChange={(expiryDate) => set('expiryDate', expiryDate)}
          hint="Facultatif."
          disabled={disabled}
        />
      ) : (
        <button
          type="button"
          className="button button--secondary button--block"
          onClick={() => setDateOuverte(true)}
          disabled={disabled}
        >
          Ajouter la date de péremption
        </button>
      )}

      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}
