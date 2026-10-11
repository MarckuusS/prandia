/**
 * Le prix paye, saisi la ou on le connait : en rangeant les courses.
 *
 * Ce montant n'appartient PAS au lot, et c'est le point le moins evident de
 * tout l'ecran. Un lot est une quantite physique posee dans un frigo ; ce qu'on
 * a paye est une OBSERVATION datee, qui va dans l'historique de prix de
 * l'INGREDIENT. C'est cet historique qui met a jour le prix courant de la
 * fiche, donc le cout de la liste de courses. Stocker le montant sur le lot
 * aurait donne un chiffre exact et parfaitement inutile : il aurait disparu
 * avec le lot, sans jamais rien apprendre au calcul des courses.
 *
 * Le meme formulaire sert a deux endroits — la feuille d'ajout et la fiche d'un
 * lot — mais pas avec la meme mecanique d'enregistrement : l'une l'envoie dans
 * la foulee de la creation du lot, l'autre apres coup. D'ou ce decoupage : ce
 * module tient les CHAMPS et la LECTURE du brouillon, chaque feuille garde sa
 * mutation et decide quoi faire de ses echecs.
 */

import { todayLocalIsoDate, type PaidPriceSuggestion } from '@prandia/shared'

import { NumberField, TextField } from '../../components/Field.js'
import { BoutonScan } from '../../components/ScanEtiquette.js'
import { QuantityField } from '../../components/QuantityField.js'

// ---------------------------------------------------------------------------
// Brouillon
// ---------------------------------------------------------------------------

export interface PriceDraft {
  /** Montant en euros. `null` = l'utilisateur n'a rien saisi, rien ne partira. */
  readonly amountEur: number | null
  /** Quantite payee. Ignoree tant que `quantitySet` est faux. */
  readonly quantityG: number | null
  /**
   * Vrai des que l'utilisateur a touche au champ de quantite.
   *
   * Sans ce drapeau, impossible de distinguer « pas encore rempli, suis le
   * lot » de « vide sur decision de l'utilisateur » : effacer le champ le
   * verrait se re-remplir tout seul sous les doigts au rendu suivant.
   */
  readonly quantitySet: boolean
  readonly store: string
}

export const EMPTY_PRICE_DRAFT: PriceDraft = {
  amountEur: null,
  quantityG: null,
  quantitySet: false,
  store: '',
}

/** Charge utile de `useAddPrice` : l'ingredient vient du hook, pas du corps. */
export interface PriceObservation {
  readonly priceEur: string
  readonly quantityG: number
  readonly store: string | null
  readonly recordedAt: string
  readonly notes: string | null
}

/**
 * Ce que vaut le brouillon au moment d'enregistrer.
 *
 * Trois etats et non un booleen : « vide » et « invalide » ne se traitent pas
 * pareil du tout. Vide est le cas NORMAL — le prix est facultatif, et un lot ne
 * doit jamais rester bloque parce qu'on n'a pas noté ce qu'on a paye. Invalide
 * signale une saisie a moitie faite, qu'il faut montrer avant d'ecrire.
 */
export type PriceReading =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'ready'; readonly entry: PriceObservation }

export function readPrice(draft: PriceDraft, fallbackQuantityG: number | null): PriceReading {
  // Le montant, et lui seul, decide qu'il y a quelque chose a enregistrer : une
  // enseigne tapee sans prix n'est pas une observation.
  if (draft.amountEur === null) return { kind: 'empty' }
  if (draft.amountEur <= 0) {
    return { kind: 'invalid', message: 'Le prix payé doit être supérieur à zéro.' }
  }

  const quantityG = draft.quantitySet ? draft.quantityG : fallbackQuantityG
  if (quantityG === null || quantityG <= 0) {
    return { kind: 'invalid', message: 'Indique la quantité pour laquelle tu as payé ce prix.' }
  }

  return {
    kind: 'ready',
    entry: {
      // Montant en CHAINE decimale et non en flottant : 0,1 € n'a pas de
      // representation binaire exacte, et l'ecart s'accumule sur une liste de
      // courses entiere. `toFixed(2)` produit exactement la forme attendue.
      priceEur: draft.amountEur.toFixed(2),
      quantityG,
      store: draft.store.trim() === '' ? null : draft.store.trim(),
      // Date LOCALE : `toISOString()` proposerait la veille passe 22 h en
      // France l'ete — l'heure ou l'on range justement ses courses.
      recordedAt: todayLocalIsoDate(),
      // Pas de champ notes ici : la feuille en a deja un pour le LOT, et deux
      // champs « note » cote a cote sur 375 px n'auraient trompe que nous.
      notes: null,
    },
  }
}

/**
 * D'ou vient un prix propose, en une phrase : "Ton dernier prix chez Lidl, le
 * 20 septembre." Un montant pre-rempli sans sa source passerait pour un prix
 * lu. Sert au frigo comme au chariot. Le mois en toutes lettres : abrege,
 * "oct." suivi du point final faisait deux points.
 */
export function formatPriceSource(suggestion: PaidPriceSuggestion): string {
  const [annee, mois, jour] = suggestion.from.recordedAt.split('-').map(Number)
  const date = new Date(annee ?? 1970, (mois ?? 1) - 1, jour ?? 1).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    ...(annee === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
  const magasin = suggestion.from.store
  if (suggestion.sameStore && magasin !== null) return `Ton dernier prix chez ${magasin}, le ${date}.`
  return magasin === null
    ? `Ton dernier prix payé, le ${date}.`
    : `Ton dernier prix payé, chez ${magasin} le ${date}.`
}

// ---------------------------------------------------------------------------
// Champs
// ---------------------------------------------------------------------------

export interface PricePaidFieldsProps {
  readonly draft: PriceDraft
  readonly onChange: (draft: PriceDraft) => void
  /** Quantite proposee tant que l'utilisateur n'a pas touche au champ. */
  readonly fallbackQuantityG: number | null
  readonly pieceWeightG?: number | null | undefined
  readonly error?: string | null | undefined
  readonly disabled?: boolean | undefined
}

export function PricePaidFields({
  draft,
  onChange,
  fallbackQuantityG,
  pieceWeightG,
  error,
  disabled,
}: PricePaidFieldsProps) {
  return (
    <>
      <NumberField
        label="Prix payé"
        value={draft.amountEur}
        onChange={(amountEur) => onChange({ ...draft, amountEur })}
        suffix="€"
        min={0}
        decimals={2}
        placeholder="2,30"
        disabled={disabled}
        error={error}
        autoFocus
      />

      <div className="scan-ligne">
        <BoutonScan
          quoi="prix"
          libelle="Scanner le prix"
          className="chip-toggle"
          onLu={(lu) => {
            if (lu.kind === 'prix' && lu.prixEur !== null) onChange({ ...draft, amountEur: lu.prixEur })
          }}
          disabled={disabled}
        />
      </div>

      <QuantityField
        label="Pour cette quantité"
        // « j'ai payé 2,30 € ce paquet de 500 g » : la quantite du prix est
        // celle du lot neuf fois sur dix. Elle la suit donc tant qu'on n'y
        // touche pas, y compris si la quantite du lot change apres coup.
        value={draft.quantitySet ? draft.quantityG : fallbackQuantityG}
        onChange={(quantityG) => onChange({ ...draft, quantityG, quantitySet: true })}
        pieceWeightG={pieceWeightG}
        disabled={disabled}
        hint="Reprise de la quantité du lot — corrige-la si le prix couvre un autre format."
      />

      <TextField
        label="Magasin"
        value={draft.store}
        onChange={(store) => onChange({ ...draft, store })}
        placeholder="Lidl, marché…"
        autoComplete="off"
        disabled={disabled}
        hint="Facultatif — c'est ce qui permettra de comparer deux enseignes plus tard."
      />
    </>
  )
}
