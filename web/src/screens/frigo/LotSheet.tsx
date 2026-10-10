/**
 * Fiche d'un lot : consommer, modifier, retirer.
 *
 * C'est le geste qui MANQUAIT au desktop. Le viewmodel exposait bien
 * `updateStock`, mais aucun fichier QML ne l'appelait : pour corriger une
 * quantite il fallait supprimer le lot et le ressaisir. Or « j'ai utilise la
 * moitie du paquet » est l'operation la plus frequente en cuisine.
 *
 * D'ou l'ordre des sections : la consommation d'abord, en trois boutons, parce
 * qu'elle se fait debout, une main occupee ; la modification fine ensuite, pour
 * les cas ou l'on connait le chiffre exact.
 *
 * Retirer une quantite superieure ou egale au lot le fait DISPARAITRE : la
 * table porte un CHECK (quantity_g > 0), un lot vide n'existe pas. C'est la
 * reponse de l'API qui le dit, pas une deduction cote client.
 *
 * On y releve aussi le PRIX PAYE, apres coup : le ticket ressort de la poche
 * une fois les courses rangees, et l'ecran Ingredients est loin. Le montant ne
 * touche pas le lot, il rejoint l'historique de prix de l'ingredient — voir
 * PricePaid.
 */

import { useState } from 'react'
import { Link } from 'react-router'
import { formatEuros, formatGrams, type PantryMovementReason } from '@prandia/shared'

import { DateField, TextField } from '../../components/Field.js'
import { QuantityField } from '../../components/QuantityField.js'
import { ConfirmDialog, Sheet } from '../../components/Sheet.js'
import { Icon } from '../../icons/index.js'
import { useToast } from '../../components/Toast.js'
import {
  useAddPrice,
  useAddStock,
  useConsumeStock,
  useDeleteStock,
  useUpdateStock,
  type PantryResponse,
} from '../../lib/queries.js'
import { formatExpiryDate, formatExpiryLabel, formatLotQuantity, type Lot } from './lots.js'
import { EMPTY_PRICE_DRAFT, PricePaidFields, readPrice, type PriceDraft } from './PricePaid.js'

const NOTES_MAX_LENGTH = 500

/** Raccourcis de consommation. Le dernier vide le lot, donc le supprime. */
const SHARES = [
  { fraction: 0.25, label: '− ¼', description: 'Retirer un quart du lot' },
  { fraction: 0.5, label: '− ½', description: 'Retirer la moitié du lot' },
  { fraction: 1, label: 'Tout', description: 'Tout consommer : le lot disparaît' },
] as const

/**
 * Masse retiree par un raccourci, arrondie au dixieme de gramme : sans cet
 * arrondi, un quart de 333 g laisserait 249,74999999999997 g en base.
 */
const shareAmount = (grams: number, fraction: number): number =>
  Math.round(grams * fraction * 10) / 10

export interface LotSheetProps {
  readonly lot: Lot
  readonly onClose: () => void
}

export function LotSheet({ lot, onClose }: LotSheetProps) {
  const update = useUpdateStock()
  const consume = useConsumeStock()
  const remove = useDeleteStock()
  // Sert uniquement a l'annulation : remettre au frigo ce qui vient d'en sortir.
  const add = useAddStock()
  const addPrice = useAddPrice(lot.stock.ingredientId)
  const toast = useToast()

  const [quantityG, setQuantityG] = useState<number | null>(lot.stock.quantityG)
  const [expiryDate, setExpiryDate] = useState<string | null>(lot.stock.expiryDate)
  const [notes, setNotes] = useState(lot.stock.notes ?? '')
  const [price, setPrice] = useState<PriceDraft>(EMPTY_PRICE_DRAFT)
  const [priceOpen, setPriceOpen] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Une consommation change la quantite du serveur sous le champ : le tampon
  // doit suivre. On compare les NOMBRES et non les objets — le cache remplace
  // la liste entiere a chaque ecriture, et comparer les identites effacerait
  // la saisie en cours a la premiere revalidation venue.
  const [seenQuantity, setSeenQuantity] = useState(lot.stock.quantityG)
  if (seenQuantity !== lot.stock.quantityG) {
    setSeenQuantity(lot.stock.quantityG)
    setQuantityG(lot.stock.quantityG)
  }

  const busy = update.isPending || consume.isPending || remove.isPending || addPrice.isPending
  const invalidQuantity = quantityG === null || quantityG <= 0
  const failure = update.error ?? consume.error ?? remove.error ?? addPrice.error

  // La quantite du prix suit celle du champ, pas celle enregistree : on corrige
  // souvent les deux dans le meme geste (« finalement c'etait 480 g a 2,30 € »).
  const priceReading = readPrice(price, quantityG ?? lot.stock.quantityG)
  const priceError = attempted && priceReading.kind === 'invalid' ? priceReading.message : null

  /**
   * Remet au frigo un lot qui vient d'en sortir.
   *
   * Le lot revient avec un NOUVEL identifiant : rien ne permet de ressusciter
   * une ligne supprimee a l'identique. Sans consequence ici, un lot de frigo
   * n'etant reference par rien d'autre, contrairement a un ingredient, qu'une
   * recette peut pointer.
   */
  const restore = (quantityG: number) => {
    void add.mutateAsync({
      ingredientId: lot.stock.ingredientId,
      quantityG,
      expiryDate: lot.stock.expiryDate,
      storage: lot.stock.storage,
      unit: lot.stock.unit,
      notes: lot.stock.notes,
    })
  }

  /*
   * `mutateAsync` et non `mutate(…, { onSuccess })` : une consommation totale
   * ou une suppression fait disparaitre le lot, donc demonter cette feuille des
   * que le cache est ecrit. Les rappels passes a `mutate` ne sont plus appeles
   * apres le demontage — le message de confirmation se perdrait. La suite du
   * `await` vit dans cette fermeture et s'execute quoi qu'il arrive.
   *
   * Le `catch` est vide a dessein : l'erreur reste exposee par `mutation.error`,
   * affichee en bas de la feuille, et l'echec ne demonte rien.
   */
  /*
   * `motif` est demande a l'appelant, jamais devine.
   *
   * Un pot fini et un pot perime laissaient la meme trace. Le seul instant ou
   * la question a une reponse vraie est celui du geste : prendre une part d'un
   * lot, c'est cuisiner, donc "consomme" ; vider un lot perime est un autre
   * bouton, avec un autre mot. C'est ce qui rend le bilan du gaspillage vrai
   * plutot que decoratif.
   */
  const takeShare = async (fraction: number, motif: PantryMovementReason = 'consomme') => {
    const amount = shareAmount(lot.stock.quantityG, fraction)
    const before = lot.stock.quantityG
    try {
      const pantry = await consume.mutateAsync({ id: lot.id, quantityG: amount, reason: motif })
      // La route ajoute `removed` et `remainingG` a sa reponse ; queries.ts la
      // type `PantryResponse` sans eux et ne nous appartient pas, d'ou cette
      // lecture explicite plutot qu'une deduction sur les quantites.
      const { removed } = pantry as PantryResponse & { removed?: boolean }
      if (removed) {
        // "Tout" retire le lot en UN seul appui, sans confirmation, dans une
        // grille de trois boutons de meme allure. Un faux contact en cuisine
        // suffisait a le perdre sans recours. Le toast d'annulation existait
        // deja et servait a l'ecran Semaine pour exactement ce cas.
        toast.showUndo(
          motif === 'jete'
            ? `${lot.name} : lot jeté, retiré du frigo.`
            : `${lot.name} : lot terminé, retiré du frigo.`,
          () => restore(before),
        )
        onClose()
        return
      }
      toast.showUndo(
        `${formatGrams(amount)} de ${lot.name} ${motif === 'jete' ? 'jetés' : 'consommés'}.`,
        () => {
        void update.mutateAsync({
          id: lot.id,
          ingredientId: lot.stock.ingredientId,
          quantityG: before,
          expiryDate: lot.stock.expiryDate,
          storage: lot.stock.storage,
      unit: lot.stock.unit,
      notes: lot.stock.notes,
        })
      })
    } catch {
      /* voir le commentaire ci-dessus */
    }
  }

  const save = async () => {
    setAttempted(true)
    if (quantityG === null || quantityG <= 0) return
    // Un prix a moitie saisi se corrige avant d'ecrire. Un prix absent, lui,
    // n'empeche jamais d'enregistrer le lot.
    if (priceReading.kind === 'invalid') return

    try {
      await update.mutateAsync({
        id: lot.id,
        ingredientId: lot.stock.ingredientId,
        quantityG,
        expiryDate,
        storage: lot.stock.storage,
      unit: lot.stock.unit,
      notes: notes.trim() === '' ? null : notes.trim(),
      })
    } catch {
      /* voir le commentaire ci-dessus */
      return
    }

    const recorded = priceReading.kind === 'ready'
    if (priceReading.kind === 'ready') {
      try {
        await addPrice.mutateAsync(priceReading.entry)
      } catch {
        /*
         * Le lot est a jour, le releve non. Contrairement a la feuille d'ajout,
         * reessayer est ici sans danger : reenregistrer reecrit les memes
         * valeurs au lieu de creer un second lot. On garde donc la feuille
         * ouverte avec la saisie et l'erreur, plutot que de fermer sur un
         * demi-succes.
         */
        return
      }
    }

    toast.show({
      message: recorded ? `${lot.name} mis à jour, prix relevé.` : `${lot.name} mis à jour.`,
    })
    onClose()
  }

  const confirmDelete = async () => {
    const before = lot.stock.quantityG
    try {
      await remove.mutateAsync(lot.id)
      toast.showUndo(`${lot.name} retiré du frigo.`, () => restore(before))
      onClose()
    } catch {
      /* voir le commentaire ci-dessus */
    }
  }

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={lot.name}
        dismissible={!busy}
        actions={
          <>
            {/* "Retirer" vivait ICI, en rouge plein, a un pouce d'"Enregistrer" :
                le geste le plus lourd de la feuille dans la rangee de validation.
                Il est descendu en bas du contenu (voir plus bas), et le pied
                reprend la forme de toutes les feuilles : Fermer, Enregistrer. */}
            <button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>
              Fermer
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void save()}
              disabled={busy}
            >
              {update.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </>
        }
      >
        <p className={`lot-summary lot-summary--${lot.bucket}`}>
          <span className="lot-summary__quantity">{formatLotQuantity(lot)}</span>
          <span className="lot-summary__expiry">
            {formatExpiryLabel(lot.daysLeft)}
            {lot.stock.expiryDate !== null && ` · ${formatExpiryDate(lot.stock.expiryDate)}`}
          </span>
          {lot.siblingCount > 1 && (
            <span className="lot-summary__siblings">
              {lot.siblingCount} lots de cet ingrédient, {formatGrams(lot.totalG)} au total.
            </span>
          )}
        </p>

        <div className="consume">
          <p className="consume__title">Consommer</p>
          <div className="consume__shares">
            {SHARES.map((share) => (
              <button
                key={share.fraction}
                type="button"
                className="consume__share"
                onClick={() => void takeShare(share.fraction)}
                disabled={busy}
                aria-label={share.description}
              >
                <span className="consume__fraction">{share.label}</span>
                <span className="consume__amount">
                  {formatGrams(shareAmount(lot.stock.quantityG, share.fraction))}
                </span>
              </button>
            ))}
          </div>
          <p className="consume__hint">Le lot disparaît du frigo s’il tombe à zéro.</p>
        </div>

        <QuantityField
          label="Quantité restante"
          value={quantityG}
          onChange={setQuantityG}
          pieceWeightG={lot.pieceWeightG}
          required
          error={attempted && invalidQuantity ? 'Indique une quantité supérieure à zéro.' : null}
        />

        <DateField
          label="Périmé le"
          value={expiryDate}
          onChange={setExpiryDate}
          hint="Vide = péremption non suivie."
        />

        <TextField
          label="Note"
          value={notes}
          onChange={setNotes}
          placeholder="Ex : entamé dimanche…"
          maxLength={NOTES_MAX_LENGTH}
        />

        {/* Rien a relever pour un lot orphelin : la fiche qui recevrait
            l'observation n'existe plus. */}
        {lot.ingredient !== null &&
          (priceOpen ? (
            <section className="price-paid">
              <h3 className="price-paid__title">Prix payé</h3>
              <p className="price-paid__lead">
                {lot.ingredient.priceEur === null
                  ? 'Aucun prix connu pour cet ingrédient.'
                  : `Prix de référence actuel : ${formatEuros(lot.ingredient.priceEur)}${
                      lot.ingredient.priceQuantityG === null
                        ? ''
                        : ` pour ${formatGrams(lot.ingredient.priceQuantityG)}`
                    }.`}{' '}
                Un nouveau relevé le remplace et met à jour le coût de la liste de courses.
              </p>
              <PricePaidFields
                draft={price}
                onChange={setPrice}
                fallbackQuantityG={quantityG ?? lot.stock.quantityG}
                pieceWeightG={lot.pieceWeightG}
                error={priceError}
                disabled={busy}
              />
              <p className="price-paid__lead">
                Il part avec « Enregistrer ».{' '}
                {/* Un releve ne se modifie pas : le corriger passe par sa
                    suppression, et seule la fiche de l'ingredient sait le
                    faire. */}
                <Link className="price-paid__link" to={`/ingredients/${lot.stock.ingredientId}`}>
                  Voir l’historique des prix
                </Link>
              </p>
            </section>
          ) : (
            <button
              type="button"
              className="button button--secondary button--block"
              onClick={() => setPriceOpen(true)}
            >
              Saisir le prix payé
            </button>
          ))}

        {failure && (
          <p className="text-error" role="alert">
            {failure.message}
          </p>
        )}

        {/* En bas et sans aplat (`.button--retrait`). Il ouvre la confirmation,
            qui garde son rouge plein : la, retirer est l'action principale. */}
        <button
          type="button"
          className="button button--retrait button--block"
          onClick={() => setConfirmingDelete(true)}
          disabled={busy}
        >
          <Icon name="ui-trash" size={16} className="icon--inline" /> Retirer du stock
        </button>
      </Sheet>

      <ConfirmDialog
        open={confirmingDelete}
        title="Retirer du stock"
        // Le desktop n'annoncait que le nom : entre deux lots de yaourts, on ne
        // savait pas lequel on supprimait. La quantite et la peremption levent
        // l'ambiguite.
        message={`Retirer « ${lot.name} » du frigo ? ${formatLotQuantity(lot)}, ${formatExpiryLabel(
          lot.daysLeft,
        ).toLocaleLowerCase('fr-FR')}.`}
        confirmLabel="Retirer"
        danger
        busy={remove.isPending}
        error={remove.error?.message ?? null}
        onConfirm={() => void confirmDelete()}
        onClose={() => setConfirmingDelete(false)}
      />
    </>
  )
}
