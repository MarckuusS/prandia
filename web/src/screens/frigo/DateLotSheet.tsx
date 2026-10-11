/**
 * Donner sa date a un lot qui arrive des courses, et RIEN D'AUTRE.
 *
 * Ouverte depuis l'onglet "A ranger" : la fiche complete du lot (quantite,
 * consommation, note, prix) ferait chercher le champ date sous trois blocs
 * qui n'ont rien a faire la, pour un geste qui se repete a chaque article.
 * Ici, la date lue sur l'emballage, et Enregistrer. Le reste du lot est
 * renvoye tel quel.
 */

import { useState } from 'react'

import { DatePeremption } from '../../components/DatePeremption.js'
import { Sheet } from '../../components/Sheet.js'
import { useUpdateStock } from '../../lib/queries.js'
import type { Lot } from './lots.js'

export function DateLotSheet({ lot, onClose }: { readonly lot: Lot; readonly onClose: () => void }) {
  const update = useUpdateStock()
  const [expiryDate, setExpiryDate] = useState<string | null>(lot.stock.expiryDate)

  const enregistrer = () => {
    update.mutate(
      {
        id: lot.id,
        ingredientId: lot.stock.ingredientId,
        quantityG: lot.stock.quantityG,
        expiryDate,
        storage: lot.stock.storage,
        unit: lot.stock.unit,
        notes: lot.stock.notes,
      },
      { onSuccess: onClose },
    )
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={lot.name}
      dismissible={!update.isPending}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={update.isPending}
          >
            Annuler
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={enregistrer}
            disabled={update.isPending || expiryDate === lot.stock.expiryDate}
          >
            {update.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </>
      }
    >
      <DatePeremption value={expiryDate} onChange={setExpiryDate} label="Date lue sur l’emballage" />
      {update.isError && (
        <p className="text-error" role="alert">
          {update.error.message}
        </p>
      )}
    </Sheet>
  )
}
