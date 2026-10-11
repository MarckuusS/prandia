/**
 * Lire un champ avec Savarin : un viseur, un declencheur, une valeur.
 *
 * UN BOUTON PAR CHAMP (decision du 2026-10-11) : le nom, la marque, le poids,
 * le prix, la date, chacun avec le sien, dans le champ, au bord droit. En
 * magasin on ne tape pas de chiffres : on vise ce qu'on veut remplir, on
 * declenche, et le champ se remplit. Les boutons "Remplir avec une photo",
 * "Scanner le prix", "Etiquette de pesee" et "Scanner" sont partis avec : il y
 * en avait partout, et une photo ne montre presque jamais nom, marque et poids
 * a la fois. L'icone est Savarin dans les quatre coins d'un viseur
 * (`ui-ia-lire`) : c'est l'IA qui lit, pas un appareil photo.
 *
 * LE DECLENCHEUR FIGE L'IMAGE. Avant, la photo partait bien au toucher de
 * "Lire", mais la video continuait de defiler pendant la lecture : on croyait
 * devoir rester immobile, et l'on ne voyait pas ce qui avait ete envoye. Au
 * toucher, la video s'arrete sur l'image envoyee, Savarin lit par-dessus, et
 * une image illisible se REPREND sans fermer le viseur.
 *
 * La camera est celle de `camera.ts`, partagee avec les codes-barres : pas de
 * nouvelle demande d'autorisation. Seul le rectangle part, agrandi d'une
 * marge : moins de pixels, donc une lecture plus rapide et moins chere, et un
 * modele qui ne lit pas le prix au kilo d'a cote. Le serveur le fait lire
 * (routes/scan.ts) et la valeur revient dans le champ : rien n'est enregistre
 * sans le bouton de la feuille, comme une saisie.
 *
 * POURQUOI PAS `<input capture>`. L'appareil photo du systeme prend tout
 * l'ecran, demande "Utiliser la photo", et rend une image de douze
 * megapixels ou l'etiquette n'occupe qu'un coin. Ici on vise, et on envoie ce
 * qu'on a vise.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { isEmptyScan, type ScanKind, type ScanResult } from '@prandia/shared'

import { Icon } from '../icons/index.js'
import { camera } from '../lib/camera.js'
import { scanEtiquette } from '../lib/queries.js'
import { Savarin } from './Savarin.js'
import { Sheet } from './Sheet.js'
import '../styles/components.css'
import '../styles/scan-etiquette.css'

const LIBELLES: Readonly<Record<ScanKind, { titre: string; consigne: string; lecture: string; vide: string }>> = {
  nom: {
    titre: 'Lire le nom',
    consigne: 'Cadre le nom du produit',
    lecture: 'Savarin lit le nom…',
    vide: 'Aucun nom lisible. Rapproche-toi du nom, et reprends la photo.',
  },
  marque: {
    titre: 'Lire la marque',
    consigne: 'Cadre la marque',
    lecture: 'Savarin lit la marque…',
    vide: 'Aucune marque lisible. Cadre-la de plus près, et reprends la photo.',
  },
  quantite: {
    titre: 'Lire le poids',
    consigne: 'Cadre le poids, le "12 x 125 g" ou l’étiquette de la balance',
    lecture: 'Savarin lit le poids…',
    vide: 'Aucun poids lisible. Cadre la mention du poids, et reprends la photo.',
  },
  prix: {
    titre: 'Lire le prix',
    consigne: 'Cadre le prix à payer',
    lecture: 'Savarin lit le prix…',
    vide: 'Aucun prix lisible. Cadre l’étiquette de plus près, et reprends la photo.',
  },
  date: {
    titre: 'Lire la date',
    consigne: 'Cadre la date',
    lecture: 'Savarin lit la date…',
    vide: 'Aucune date lisible. Rapproche-toi, évite les reflets, et reprends la photo.',
  },
  nutrition: {
    titre: 'Lire le tableau nutritionnel',
    consigne: 'Cadre le tableau entier',
    lecture: 'Savarin lit le tableau…',
    vide: 'Tableau illisible, ou seulement par portion. Rapproche-toi, et reprends la photo.',
  },
}

/**
 * Le plus grand cote envoye. Un nom, une marque ou un prix imprimes gros se
 * lisent a 768 px, et une image plus petite part et se lit plus vite ; une date
 * ou un poids, souvent en petits caracteres, a 1 024 ; un tableau nutritionnel,
 * aux lignes serrees, a la pleine definition qu'accepte le modele.
 */
const COTE_MAX: Readonly<Record<ScanKind, number>> = {
  nom: 768,
  marque: 768,
  prix: 768,
  date: 1024,
  quantite: 1024,
  nutrition: 1568,
}

/** Marge ajoutee autour du rectangle : on cadre toujours un peu court. */
const MARGE = 0.15

/**
 * La partie de l'image sous le rectangle, en JPEG.
 *
 * La video est affichee en `object-fit: cover` : elle deborde de la scene,
 * centree, a l'echelle `max(scene / video)`. On refait ce calcul a l'envers
 * pour savoir quels pixels de la camera sont sous le rectangle.
 */
async function decouper(
  video: HTMLVideoElement,
  scene: HTMLElement,
  cadre: HTMLElement,
  coteMax: number,
): Promise<Blob> {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const s = scene.getBoundingClientRect()
  const c = cadre.getBoundingClientRect()
  const echelle = Math.max(s.width / vw, s.height / vh)
  const decalX = (vw * echelle - s.width) / 2
  const decalY = (vh * echelle - s.height) / 2
  const margeX = c.width * MARGE
  const margeY = c.height * MARGE
  const sx = Math.max(0, (c.left - s.left - margeX + decalX) / echelle)
  const sy = Math.max(0, (c.top - s.top - margeY + decalY) / echelle)
  const sw = Math.min(vw - sx, (c.width + 2 * margeX) / echelle)
  const sh = Math.min(vh - sy, (c.height + 2 * margeY) / echelle)
  const reduction = Math.min(1, coteMax / Math.max(sw, sh))
  const toile = document.createElement('canvas')
  toile.width = Math.round(sw * reduction)
  toile.height = Math.round(sh * reduction)
  const ctx = toile.getContext('2d')
  if (ctx === null) throw new Error('Capture impossible.')
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, toile.width, toile.height)
  return new Promise((resoudre, rejeter) =>
    toile.toBlob((blob) => (blob ? resoudre(blob) : rejeter(new Error('Capture impossible.'))), 'image/jpeg', 0.85),
  )
}

/**
 * `fige` : la video est arretee sur l'image envoyee, pendant la lecture puis
 * quand elle n'a rien donne (on voit pourquoi : flou, reflet, mauvais cadrage).
 */
type Etat = 'demarrage' | 'pret' | 'lecture' | 'fige' | 'refus' | 'erreur'

function Viseur({
  quoi,
  onLu,
  onClose,
}: {
  readonly quoi: ScanKind
  readonly onLu: (resultat: ScanResult) => void
  readonly onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sceneRef = useRef<HTMLDivElement | null>(null)
  const cadreRef = useRef<HTMLDivElement | null>(null)
  const fluxRef = useRef<MediaStream | null>(null)
  const [etat, setEtat] = useState<Etat>('demarrage')
  const [message, setMessage] = useState<string | null>(null)
  const libelles = LIBELLES[quoi]

  const rendreCamera = useCallback(() => {
    const flux = fluxRef.current
    fluxRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    if (flux) camera().release(flux)
  }, [])

  useEffect(() => {
    let annule = false
    void (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setEtat('erreur')
        setMessage('Ce navigateur ne donne pas accès à la caméra.')
        return
      }
      let flux: MediaStream
      try {
        flux = await camera().acquire()
      } catch (erreur) {
        if (annule) return
        const nom = (erreur as Error).name
        setEtat(nom === 'NotAllowedError' || nom === 'SecurityError' ? 'refus' : 'erreur')
        return
      }
      if (annule) {
        camera().release(flux)
        return
      }
      fluxRef.current = flux
      const video = videoRef.current
      if (video === null) return
      video.srcObject = flux
      try {
        await video.play()
      } catch {
        /* Safari rejette parfois play() sur un rendu concurrent : le flux part quand meme. */
      }
      if (!annule) setEtat('pret')
    })()
    return () => {
      annule = true
      rendreCamera()
    }
  }, [rendreCamera])

  const declencher = async () => {
    const video = videoRef.current
    const scene = sceneRef.current
    const cadre = cadreRef.current
    if (video === null || scene === null || cadre === null || video.videoWidth === 0) return
    // FIGER D'ABORD : l'image arretee a l'ecran est celle qui part.
    video.pause()
    setEtat('lecture')
    setMessage(null)
    try {
      const image = await decouper(video, scene, cadre, COTE_MAX[quoi])
      const resultat = await scanEtiquette(quoi, image)
      if (isEmptyScan(resultat)) {
        setMessage(libelles.vide)
        setEtat('fige')
        return
      }
      navigator.vibrate?.(40)
      onLu(resultat)
      onClose()
    } catch (erreur) {
      setMessage(erreur instanceof Error ? erreur.message : 'La lecture a échoué. Reprends la photo.')
      setEtat('fige')
    }
  }

  const reprendre = () => {
    setMessage(null)
    setEtat('pret')
    void videoRef.current?.play().catch(() => undefined)
  }

  if (etat === 'refus' || etat === 'erreur') {
    return (
      <div className="scanner scan-etiquette">
        <div className="scanner__stage scanner__stage--message">
          <p className="status status--error" role="alert">
            {etat === 'refus' ? 'Accès à la caméra refusé.' : (message ?? 'La caméra n’a pas pu démarrer.')}
          </p>
          {etat === 'refus' && (
            <p className="card__lead">
              Autorise l’appareil photo pour ce site dans les réglages du téléphone, puis rouvre cet écran.
            </p>
          )}
        </div>
      </div>
    )
  }

  const fige = etat === 'lecture' || etat === 'fige'
  return (
    <div className={`scanner scan-etiquette scan-etiquette--${quoi}`}>
      <div className={`scanner__stage${fige ? ' scanner__stage--fige' : ''}`} ref={sceneRef}>
        <video ref={videoRef} className="scanner__video" muted playsInline />
        <div ref={cadreRef} className={`viseur viseur--${quoi}`} aria-hidden="true">
          <span className="viseur__coin viseur__coin--hg" />
          <span className="viseur__coin viseur__coin--hd" />
          <span className="viseur__coin viseur__coin--bg" />
          <span className="viseur__coin viseur__coin--bd" />
        </div>
        {!fige && <p className="viseur__astuce">{libelles.consigne}</p>}
        {etat === 'demarrage' && <p className="scanner__overlay">Ouverture de la caméra…</p>}
        {etat === 'lecture' && (
          <p className="scan-etiquette__lecture" role="status">
            <Savarin size={22} occupe />
            {libelles.lecture}
          </p>
        )}
        {(etat === 'pret' || etat === 'demarrage') && (
          <button
            type="button"
            className="scan-etiquette__declencheur"
            onClick={() => void declencher()}
            disabled={etat !== 'pret'}
            aria-label={`Prendre la photo : ${libelles.titre.toLowerCase()}`}
          >
            <span className="scan-etiquette__declencheur-centre" />
          </button>
        )}
      </div>

      {etat === 'fige' && (
        <>
          {message !== null && (
            <p className="field__error" role="alert">
              {message}
            </p>
          )}
          <button type="button" className="button button--primary button--block" onClick={reprendre}>
            Reprendre la photo
          </button>
        </>
      )}
    </div>
  )
}

export interface BoutonLireProps {
  readonly quoi: ScanKind
  readonly onLu: (resultat: ScanResult) => void
  /** Texte du bouton ; sans lui, l'icone seule, dans un champ. */
  readonly libelle?: string | undefined
  readonly className?: string | undefined
  readonly disabled?: boolean | undefined
}

/** Savarin dans son viseur, et la feuille qu'il ouvre. */
export function BoutonLire({ quoi, onLu, libelle, className, disabled }: BoutonLireProps) {
  const [ouvert, setOuvert] = useState(false)
  return (
    <>
      <button
        type="button"
        className={className ?? 'bouton-lire'}
        onClick={() => setOuvert(true)}
        disabled={disabled}
        aria-label={libelle === undefined ? `${LIBELLES[quoi].titre} avec Savarin` : undefined}
      >
        {libelle === undefined ? (
          <Icon name="ui-ia-lire" size={22} />
        ) : (
          <Icon name="ui-ia-lire" size={18} className="icon--inline" />
        )}
        {libelle}
      </button>
      <Sheet open={ouvert} onClose={() => setOuvert(false)} title={LIBELLES[quoi].titre}>
        {ouvert && <Viseur quoi={quoi} onLu={onLu} onClose={() => setOuvert(false)} />}
      </Sheet>
    </>
  )
}
