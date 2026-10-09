/**
 * Corriger — ou retirer — une ligne du chariot.
 *
 * On se trompe : on scanne deux fois le meme yaourt, on lit le prix du produit
 * d'a cote, on repose l'article en rayon. Sans ce retour en arriere, la seule
 * issue serait d'abandonner la session entiere et de tout rescanner.
 *
 * Les memes quatre champs qu'a l'ajout, exactement : un ecran de correction qui
 * ne ressemble pas a l'ecran de saisie oblige a reapprendre a chaque fois.
 * Aucun pre-remplissage ici en revanche — la ligne existe deja, aller
 * reinterroger OpenFoodFacts ne pourrait qu'ecraser ce qu'on vient corriger.
 */

import { useState } from 'react'
import type { SessionItem } from '@prandia/shared'

import { Sheet } from '../../components/Sheet.js'
import { useRemoveSessionItem, useUpdateSessionItem } from '../../lib/queries.js'
import { SessionItemFields } from './SessionItemFields.js'
import { draftFromItem, readDraft, type ItemDraft } from './sessionDraft.js'

export interface CartLineSheetProps {
  readonly item: SessionItem
  /** Vrai quand l'article correspond a une ligne de la liste de courses. */
  readonly onList: boolean
  readonly onClose: () => void
  /** Prevenu apres un retrait, pour que l'ecran puisse le dire. */
  readonly onRemoved: (name: string) => void
}

export function CartLineSheet({ item, onList, onClose, onRemoved }: CartLineSheetProps) {
  const [draft, setDraft] = useState<ItemDraft>(() => draftFromItem(item))
  const [error, setError] = useState<string | null>(null)

  const update = useUpdateSessionItem()
  const remove = useRemoveSessionItem()
  const busy = update.isPending || remove.isPending

  const save = () => {
    const reading = readDraft(draft)
    if (reading.kind === 'invalid') {
      setError(reading.message)
      return
    }
    update.mutate({ ...reading.item, id: item.id }, { onSuccess: onClose })
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Corriger l’article"
      dismissible={!busy}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="button" className="button button--primary" onClick={save} disabled={busy}>
            {update.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </>
      }
    >
      <SessionItemFields
        draft={draft}
        onChange={(next) => {
          if (error !== null) setError(null)
          setDraft(next)
        }}
        onList={onList}
        error={error ?? update.error?.message ?? remove.error?.message}
        disabled={busy}
      />

      {/* Le retrait est en bas, en rouge, hors de la rangee de validation : on
          ne doit pas pouvoir le confondre avec « Annuler » d'un pouce presse.
          Pas de confirmation en revanche — rien n'est encore ecrit ailleurs, et
          rescanner l'article coute deux secondes. */}
      <button
        type="button"
        className="button button--danger button--block session-remove"
        onClick={() => remove.mutate(item.id, { onSuccess: () => onRemoved(item.name) })}
        disabled={busy}
      >
        {remove.isPending ? 'Retrait…' : 'Retirer du chariot'}
      </button>
    </Sheet>
  )
}
