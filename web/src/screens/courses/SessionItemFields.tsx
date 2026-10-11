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
import { formatEuros, formatGrams } from '@prandia/shared'

import { DatePeremption } from '../../components/DatePeremption.js'
import { BoutonScan } from '../../components/ScanEtiquette.js'
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
  /**
   * Le prix a PROPOSER, et d'ou il vient ("Ton dernier prix chez Lidl, le 20
   * septembre."). Jamais ecrit dans le champ sans un toucher.
   */
  readonly proposition?: { readonly priceEur: number; readonly source: string } | null | undefined
  readonly error?: string | null | undefined
  readonly disabled?: boolean | undefined
}

export function SessionItemFields({
  draft,
  onChange,
  onList,
  observed,
  observedPending,
  proposition,
  error,
  disabled,
}: SessionItemFieldsProps) {
  const set = <K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) =>
    onChange({ ...draft, [key]: value })
  const [dateOuverte, setDateOuverte] = useState(draft.expiryDate !== null)

  const [lotOuvert, setLotOuvert] = useState(false)
  const [lot, setLot] = useState<{ nombre: number | null; contenanceG: number | null }>({
    nombre: null,
    contenanceG: null,
  })
  /** Ouvert sur ce qu'on sait deja : la piece connue, et combien la quantite en fait. */
  const ouvrirLot = () => {
    const piece = draft.pieceWeightG
    const nombre =
      piece !== null && piece > 0 && draft.quantityG !== null ? Math.max(1, Math.round(draft.quantityG / piece)) : null
    setLot({ nombre, contenanceG: piece })
    setLotOuvert(true)
  }
  const changerLot = (suite: { nombre: number | null; contenanceG: number | null }) => {
    setLot(suite)
    if (suite.nombre === null || suite.nombre <= 0 || suite.contenanceG === null || suite.contenanceG <= 0) return
    onChange({ ...draft, quantityG: suite.nombre * suite.contenanceG, pieceWeightG: suite.contenanceG })
  }

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

      {/* Un produit que ni la bibliotheque ni OpenFoodFacts ne connaissent :
          une photo de l'emballage remplit le nom, la marque et le poids. */}
      {draft.ingredientId === null && (
        <div className="scan-ligne">
          <BoutonScan
            quoi="produit"
            libelle="Remplir avec une photo"
            className="chip-toggle"
            onLu={(lu) => {
              if (lu.kind !== 'produit') return
              const quantite = lu.contenanceG === null ? null : (lu.nombre ?? 1) * lu.contenanceG
              onChange({
                ...draft,
                name: lu.nom ?? draft.name,
                brand: lu.marque ?? draft.brand,
                quantityG: quantite ?? draft.quantityG,
                pieceWeightG: lu.contenanceG ?? draft.pieceWeightG,
              })
            }}
            disabled={disabled}
          />
        </div>
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

      {/* UN LOT SANS CALCUL : "12 x 125 g" se saisit tel qu'on le lit sur
          l'emballage, et la masse se calcule. La contenance d'une unite devient
          la PIECE de la ligne : la quantite se relit "12 pieces (125 g)", et au
          frigo "1 pot" vaut 125 g, pas le paquet entier. */}
      {lotOuvert ? (
        <div className="session-lot">
          <NumberField
            label="Nombre d’unités"
            value={lot.nombre}
            onChange={(nombre) => changerLot({ ...lot, nombre })}
            min={1}
            decimals={0}
            placeholder="12"
            disabled={disabled}
          />
          <QuantityField
            label="Contenance d’une unité"
            value={lot.contenanceG}
            onChange={(contenanceG) => changerLot({ ...lot, contenanceG })}
            disabled={disabled}
          />
          {lot.nombre !== null && lot.nombre > 0 && lot.contenanceG !== null && lot.contenanceG > 0 && (
            <p className="field__hint">
              {lot.nombre} × {formatGrams(lot.contenanceG)}, soit {formatGrams(lot.nombre * lot.contenanceG)}.
            </p>
          )}
        </div>
      ) : (
        <div className="session-lot__actions">
          <button
            type="button"
            className="button button--ghost session-lot__ouvrir"
            onClick={ouvrirLot}
            disabled={disabled}
          >
            + Saisir un lot (ex. 12 × 125 g)
          </button>
          {/* "12 x 125 g" lu sur l'emballage remplit le lot ; "500 g", une
              unite de 500 g. La valeur reste modifiable avant l'ajout. */}
          <BoutonScan
            quoi="quantite"
            libelle="Scanner"
            className="button button--ghost session-lot__ouvrir"
            onLu={(lu) => {
              if (lu.kind !== 'quantite' || lu.contenanceG === null) return
              setLotOuvert(true)
              changerLot({ nombre: lu.nombre ?? 1, contenanceG: lu.contenanceG })
            }}
            disabled={disabled}
          />
        </div>
      )}

      <NumberField
        label="Prix payé"
        value={draft.priceEur}
        onChange={(priceEur) => set('priceEur', priceEur)}
        suffix="€"
        min={0}
        decimals={2}
        emptyOnZero
        // Pas d'exemple de montant : "2,49" en gris dans un champ vide se
        // lisait comme un prix deja saisi, la ou l'on veut justement qu'un
        // champ vide se voie vide.
        disabled={disabled}
        hint="Facultatif : sans lui, l’article compte dans le chariot mais pas dans le total."
      />

      {/* Un prix PROPOSE, jamais pre-rempli : il ne part qu'au toucher. Le
          bouton disparait une fois le champ rempli, de la main ou par lui. */}
      <div className="session-proposition">
        {/* L'etiquette du rayon, lue par le serveur : le prix de l'ARTICLE,
            jamais le prix au kilo imprime a cote. */}
        <BoutonScan
          quoi="prix"
          libelle="Scanner le prix"
          className="chip-toggle"
          onLu={(lu) => {
            if (lu.kind === 'prix' && lu.prixEur !== null) set('priceEur', lu.prixEur)
          }}
          disabled={disabled}
        />
        {/* Vrac, boucherie, fromage a la coupe : l'etiquette de la balance
            donne le poids ET le prix d'un seul scan. Le poids se relit en
            grammes : un poids pese n'est pas une piece. */}
        <BoutonScan
          quoi="pesee"
          libelle="Étiquette de pesée"
          className="chip-toggle"
          onLu={(lu) => {
            if (lu.kind !== 'pesee') return
            onChange({
              ...draft,
              quantityG: lu.poidsG ?? draft.quantityG,
              priceEur: lu.prixEur ?? draft.priceEur,
            })
          }}
          disabled={disabled}
        />
        {proposition !== null && proposition !== undefined && draft.priceEur === null && (
          <>
            <button
              type="button"
              className="chip-toggle"
              onClick={() => set('priceEur', proposition.priceEur)}
              disabled={disabled}
            >
              Reprendre {formatEuros(proposition.priceEur.toFixed(2))}
            </button>
            <span className="session-proposition__source">{proposition.source}</span>
          </>
        )}
      </div>

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
              , observé entre {formatEuros(observed.minEur)} et {formatEuros(observed.maxEur)} sur{' '}
              {observed.sampleCount} relevé{observed.sampleCount > 1 ? 's' : ''}
              {observed.lastSeen ? `, le plus récent du ${formatDay(observed.lastSeen)}` : ''}
            </>
          )}
          .
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
