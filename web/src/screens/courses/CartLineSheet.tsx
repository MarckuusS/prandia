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

import { useEffect, useRef, useState } from 'react'
import { todayLocalIsoDate, type SessionItem } from '@prandia/shared'

import { BoutonRafale } from '../../components/ScanEtiquette.js'
import { Sheet } from '../../components/Sheet.js'
import { Icon } from '../../icons/index.js'
import { useRemoveSessionItem, useUpdateSessionItem } from '../../lib/queries.js'
import { LectureSavarin } from './LectureSavarin.js'
import { ecouter, lancerLecture, lectureDeLArticle, marquerVue, useLectures, type Ecouteur } from './lecturesArticle.js'
import { SessionItemFields } from './SessionItemFields.js'
import { appliquerArticle, draftFromItem, readDraft, type ChampLu, type ItemDraft } from './sessionDraft.js'

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

  /*
   * SAVARIN SUR UNE LIGNE DEJA AU CHARIOT. Rouverte apres sa lecture, elle
   * encadre ce qu'il a rempli, et son logo s'eteint dans le chariot. Rouverte
   * PENDANT, la reponse vient aussi dans ce brouillon (elle est de toute facon
   * ecrite dans l'article, feuille ouverte ou non).
   */
  const lecture = lectureDeLArticle(useLectures(), item.id)
  const [lusSavarin, setLusSavarin] = useState<readonly ChampLu[]>(() =>
    lecture?.etat === 'lue' && !lecture.vue ? lecture.champs : [],
  )
  const draftRef = useRef(draft)
  draftRef.current = draft
  const appliquerIci: Ecouteur = (lu, avant) => {
    const applique = appliquerArticle(draftRef.current, avant, lu, todayLocalIsoDate())
    setDraft(applique.draft)
    setLusSavarin(applique.champs)
  }
  const cleLecture = lecture?.cle
  const etatLecture = lecture?.etat
  useEffect(() => {
    if (cleLecture === undefined) return
    if (etatLecture === 'lue') marquerVue(cleLecture)
    if (etatLecture === 'lecture') return ecouter(cleLecture, appliquerIci)
    return undefined
    // `appliquerIci` relit le brouillon par sa ref : seule la lecture compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleLecture, etatLecture])

  const save = () => {
    const reading = readDraft(draft)
    if (reading.kind === 'invalid') {
      setError(reading.message)
      return
    }
    update.mutate({ ...reading.item, id: item.id }, { onSuccess: onClose })
  }

  /*
   * Des photos envoyees depuis une ligne : ce qui a ete corrige ici part
   * d'abord, la feuille se ferme, et la lecture remplit l'article ensuite. Un
   * brouillon incomplet garde la feuille ouverte, qui recevra la lecture.
   */
  const envoyer = (photos: readonly Blob[]) => {
    const cle = `ligne-${item.id}-${Date.now().toString(36)}`
    const reading = readDraft(draft)
    if (reading.kind === 'invalid') {
      lancerLecture({ cle, photos, avant: draft, itemId: item.id, ecouteur: appliquerIci })
      return
    }
    lancerLecture({ cle, photos, avant: draft, itemId: item.id, ecouteur: null })
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
          <BoutonRafale onEnvoyer={envoyer} occupe={lecture?.etat === 'lecture'} disabled={busy} />
          <button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button type="button" className="button button--primary" onClick={save} disabled={busy}>
            {update.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </>
      }
    >
      <LectureSavarin lecture={lecture} />
      <SessionItemFields
        lusSavarin={lusSavarin}
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
          Du texte rouge et non un aplat (`.button--retrait`) : le seul aplat de
          la feuille reste "Enregistrer". Pas de confirmation en revanche : rien
          n'est encore ecrit ailleurs, et rescanner l'article coute deux
          secondes. */}
      <button
        type="button"
        className="button button--retrait button--block session-remove"
        onClick={() => remove.mutate(item.id, { onSuccess: () => onRemoved(item.name) })}
        disabled={busy}
      >
        <Icon name="ui-trash" size={16} className="icon--inline" />{' '}
        {remove.isPending ? 'Retrait…' : 'Retirer du chariot'}
      </button>
    </Sheet>
  )
}
