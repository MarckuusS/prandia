/**
 * Lire le ticket de caisse avant de terminer les courses.
 *
 * Le vrac pese EN CAISSE n'a ni poids ni prix quand on le pose dans le
 * chariot : seul le ticket les porte. On le photographie, le serveur le fait
 * lire contre la liste du chariot (routes/courses.ts, shared/src/ticket.ts),
 * et cette feuille montre ce qui a ete trouve AVANT de rien ecrire : chaque
 * article, son poids et son prix lus, la ligne du ticket d'ou ils viennent,
 * l'ecart avec un prix deja saisi. La personne decoche ce qui ne va pas.
 *
 * LA PHOTO PASSE PAR L'APPAREIL DU TELEPHONE, pas par le viseur de Prandia :
 * un ticket est long, imprime petit, et demande la pleine definition de
 * l'appareil. Prandia la reduit ensuite a 2 400 px, ce que le modele lit en
 * entier. `accept="image/*"` sans `capture` : la phototheque reste proposee,
 * pour un ticket photographie a la caisse.
 *
 * Un long ticket se lit en plusieurs photos ("Lire la suite") :
 * chaque lecture s'ajoute a la precedente, sans servir deux fois un article.
 */

import { useRef, useState } from 'react'
import {
  formatEuros,
  formatGrams,
  mergeTicketReadings,
  type SessionItem,
  type TicketMatch,
  type TicketReading,
} from '@prandia/shared'

import { Sheet } from '../../components/Sheet.js'
import { useToast } from '../../components/Toast.js'
import { lireTicket, useAppliquerTicket, useSetSessionStore } from '../../lib/queries.js'

/** Le plus grand cote envoye : ce que le modele lit sans reduire l'image. */
const COTE_MAX = 2400

async function reduireTicket(fichier: File): Promise<Blob> {
  // `from-image` : sans lui, une photo prise en portrait sort couchee.
  const image = await createImageBitmap(fichier, { imageOrientation: 'from-image' })
  const echelle = Math.min(1, COTE_MAX / Math.max(image.width, image.height))
  const toile = document.createElement('canvas')
  toile.width = Math.round(image.width * echelle)
  toile.height = Math.round(image.height * echelle)
  const ctx = toile.getContext('2d')
  if (ctx === null) throw new Error('Photo illisible.')
  ctx.drawImage(image, 0, 0, toile.width, toile.height)
  image.close()
  return new Promise((resoudre, rejeter) =>
    toile.toBlob((blob) => (blob ? resoudre(blob) : rejeter(new Error('Photo illisible.'))), 'image/jpeg', 0.85),
  )
}

/** Ce qu'une correspondance changerait a son article ; rien si le ticket confirme. */
interface Changement {
  readonly match: TicketMatch
  readonly item: SessionItem
  /** Poids a poser : seulement pour un article sans poids ou a peser. */
  readonly poidsG: number | null
  /** Prix a poser : seulement s'il manque ou differe du prix saisi. */
  readonly prixEur: number | null
}

function changements(lecture: TicketReading, items: readonly SessionItem[]): Changement[] {
  const parId = new Map(items.map((item) => [item.id, item]))
  return lecture.matches.flatMap((match) => {
    const item = parId.get(match.itemId)
    if (item === undefined) return []
    const poidsG = (item.aPeser || item.quantityG === null) && match.poidsG !== null ? match.poidsG : null
    const prixEur =
      match.prixEur !== null && (item.priceEur === null || Number(item.priceEur) !== match.prixEur)
        ? match.prixEur
        : null
    return [{ match, item, poidsG, prixEur }]
  })
}

export function TicketCaisse({
  items,
  magasin,
  onClose,
}: {
  readonly items: readonly SessionItem[]
  /** Le magasin des courses ; vide, le ticket le donne (son enseigne). */
  readonly magasin: string
  readonly onClose: () => void
}) {
  const entree = useRef<HTMLInputElement | null>(null)
  const appliquer = useAppliquerTicket()
  const poserMagasin = useSetSessionStore()
  const toast = useToast()
  const [lecture, setLecture] = useState<TicketReading | null>(null)
  const [enCours, setEnCours] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)
  /** Les articles que la personne a decoches : par defaut, tout s'applique. */
  const [ecartes, setEcartes] = useState<ReadonlySet<string>>(new Set())

  const photographier = () => entree.current?.click()

  const photoChoisie = async (fichier: File | undefined) => {
    if (fichier === undefined) return
    setEnCours(true)
    setErreur(null)
    try {
      const lu = await lireTicket(await reduireTicket(fichier))
      if (lu.matches.length === 0 && lu.horsChariot.length === 0) {
        setErreur('Rien de lisible sur cette photo. Reprends le ticket à plat, bien éclairé, sans reflet.')
      }
      setLecture((avant) => (avant === null ? lu : mergeTicketReadings(avant, lu)))
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'La lecture du ticket a échoué.')
    } finally {
      setEnCours(false)
      if (entree.current) entree.current.value = ''
    }
  }

  const tous = lecture === null ? [] : changements(lecture, items)
  const aChanger = tous.filter((c) => c.poidsG !== null || c.prixEur !== null)
  const confirmes = tous.length - aChanger.length
  const retenus = aChanger.filter((c) => !ecartes.has(c.item.id))
  const servis = new Set(lecture?.matches.map((m) => m.itemId) ?? [])
  const absents = items.filter((item) => !servis.has(item.id))

  /** L'enseigne lue, quand les courses n'ont pas encore de magasin. */
  const magasinLu = magasin === '' ? (lecture?.magasin ?? null) : null

  const valider = () => {
    // Le magasin d'abord : les ecritures du chariot passent une par une, et
    // les prix seront enregistres a son nom a la validation.
    if (magasinLu !== null) poserMagasin.mutate(magasinLu)
    if (retenus.length === 0) {
      onClose()
      return
    }
    appliquer.mutate(
      retenus.map((c) => ({
        id: c.item.id,
        quantityG: c.poidsG,
        priceEur: c.prixEur === null ? null : c.prixEur.toFixed(2),
      })),
      {
        onSuccess: () => {
          toast.show({
            message: `${retenus.length} article${retenus.length > 1 ? 's' : ''} complété${retenus.length > 1 ? 's' : ''} depuis le ticket.`,
          })
          onClose()
        },
      },
    )
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Lire le ticket"
      dismissible={!enCours && !appliquer.isPending}
      actions={
        lecture === null ? (
          <>
            <button type="button" className="button button--secondary" onClick={onClose} disabled={enCours}>
              Annuler
            </button>
            <button type="button" className="button button--primary" onClick={photographier} disabled={enCours}>
              {enCours ? 'Lecture…' : 'Photographier le ticket'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="button button--secondary"
              onClick={photographier}
              disabled={enCours || appliquer.isPending}
            >
              {enCours ? 'Lecture…' : 'Lire la suite'}
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={valider}
              disabled={enCours || appliquer.isPending || (retenus.length === 0 && magasinLu === null)}
            >
              {appliquer.isPending ? 'Enregistrement…' : `Appliquer${retenus.length > 0 ? ` (${retenus.length})` : ''}`}
            </button>
          </>
        )
      }
    >
      <input
        ref={entree}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => void photoChoisie(e.target.files?.[0])}
      />

      {lecture === null && (
        <p className="card__lead">
          Prends le ticket à plat, en entier si possible. Prandia y retrouve chaque article du
          chariot et lui donne le prix payé, remises comprises, ainsi que le poids du vrac pesé en
          caisse et le magasin. Tu relis avant d’appliquer. Un long ticket se lit en plusieurs photos.
        </p>
      )}

      {erreur !== null && (
        <p className="field__error" role="alert">
          {erreur}
        </p>
      )}

      {magasinLu !== null && (
        <p className="status status--ok">Magasin lu sur le ticket : {magasinLu}. Les prix seront enregistrés à ce nom.</p>
      )}
      {appliquer.isError && (
        <p className="field__error" role="alert">
          {appliquer.error.message}
        </p>
      )}

      {aChanger.length > 0 && (
        <>
          <h3 className="section-header">Lu sur le ticket</h3>
          <ul className="ticket-lignes">
            {aChanger.map((c) => {
              const retenu = !ecartes.has(c.item.id)
              return (
                <li key={c.item.id}>
                  <label className="ticket-ligne">
                    <input
                      type="checkbox"
                      checked={retenu}
                      onChange={() =>
                        setEcartes((avant) => {
                          const suite = new Set(avant)
                          if (retenu) suite.add(c.item.id)
                          else suite.delete(c.item.id)
                          return suite
                        })
                      }
                    />
                    <span className="ticket-ligne__corps">
                      <span className="ticket-ligne__nom">{c.item.name}</span>
                      <span className="ticket-ligne__valeurs">
                        {[
                          c.poidsG === null ? null : formatGrams(c.poidsG),
                          c.prixEur === null ? null : formatEuros(c.prixEur.toFixed(2)),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        {c.prixEur !== null && c.item.priceEur !== null && (
                          <span className="ticket-ligne__ecart"> (saisi : {formatEuros(c.item.priceEur)})</span>
                        )}
                      </span>
                      {c.match.libelle !== null && (
                        <span className="ticket-ligne__libelle">Ticket : {c.match.libelle}</span>
                      )}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {lecture !== null && confirmes > 0 && (
        <p className="field__hint">
          {confirmes} article{confirmes > 1 ? 's' : ''} conforme{confirmes > 1 ? 's' : ''} au ticket.
        </p>
      )}

      {lecture !== null && absents.length > 0 && (
        <p className="field__hint">
          Pas retrouvés sur cette photo : {absents.map((item) => item.name).join(', ')}. S’ils sont
          plus bas sur le ticket, lis la suite.
        </p>
      )}

      {lecture !== null && lecture.horsChariot.length > 0 && (
        <>
          <h3 className="section-header">Sur le ticket, pas dans le chariot</h3>
          <ul className="ticket-hors">
            {lecture.horsChariot.map((h, i) => (
              <li key={`${h.libelle}-${i}`}>
                {h.libelle}
                {h.prixEur === null ? '' : `, ${formatEuros(h.prixEur.toFixed(2))}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  )
}
