/**
 * Scanner une date, un prix ou une quantite : un viseur, une photo, une lecture.
 *
 * Le bouton ouvre un viseur DANS l'application (la camera partagee de
 * `camera.ts`, la meme que pour les codes-barres : pas de nouvelle demande
 * d'autorisation), on cadre l'etiquette dans le rectangle, on touche "Lire".
 * Seul le rectangle part, agrandi d'une marge : moins de pixels, donc une
 * lecture moins chere, et un modele qui ne lit pas le prix au kilo d'a cote.
 * Le serveur le fait lire (routes/scan.ts) et la valeur revient dans le champ :
 * rien n'est enregistre sans le bouton de la feuille, comme une saisie.
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
import { Sheet } from './Sheet.js'
import '../styles/components.css'
import '../styles/scan-etiquette.css'

const LIBELLES: Readonly<Record<ScanKind, { titre: string; consigne: string; vide: string }>> = {
  date: {
    titre: 'Scanner la date',
    consigne: 'Cadre la date dans le rectangle',
    vide: 'Aucune date lisible. Rapproche-toi, évite les reflets, et réessaie.',
  },
  prix: {
    titre: 'Scanner le prix',
    consigne: 'Cadre l’étiquette de prix',
    vide: 'Aucun prix lisible. Cadre l’étiquette de plus près, et réessaie.',
  },
  quantite: {
    titre: 'Scanner le poids',
    consigne: 'Cadre le poids ou le "12 x 125 g"',
    vide: 'Aucun poids lisible. Cadre la mention du poids, et réessaie.',
  },
  pesee: {
    titre: 'Étiquette de pesée',
    consigne: 'Cadre l’étiquette de la balance',
    vide: 'Rien de lisible. Cadre l’étiquette entière, poids et prix, et réessaie.',
  },
  produit: {
    titre: 'Remplir avec une photo',
    consigne: 'Cadre le devant de l’emballage',
    vide: 'Rien de lisible. Cadre le nom et le poids du produit, et réessaie.',
  },
  nutrition: {
    titre: 'Lire le tableau nutritionnel',
    consigne: 'Cadre le tableau entier',
    vide: 'Tableau illisible, ou seulement par portion. Rapproche-toi, et réessaie.',
  },
}

/**
 * Le plus grand cote envoye. Une date ou un prix se lisent a 1 024 px ; un
 * tableau nutritionnel, aux lignes serrees, demande la pleine definition
 * qu'accepte le modele.
 */
const COTE_MAX: Readonly<Record<ScanKind, number>> = {
  date: 1024,
  prix: 1024,
  quantite: 1024,
  pesee: 1024,
  produit: 1280,
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

type Etat = 'demarrage' | 'pret' | 'lecture' | 'refus' | 'erreur'

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

  const lire = async () => {
    const video = videoRef.current
    const scene = sceneRef.current
    const cadre = cadreRef.current
    if (video === null || scene === null || cadre === null || video.videoWidth === 0) return
    setEtat('lecture')
    setMessage(null)
    try {
      const image = await decouper(video, scene, cadre, COTE_MAX[quoi])
      const resultat = await scanEtiquette(quoi, image)
      if (isEmptyScan(resultat)) {
        setMessage(libelles.vide)
        setEtat('pret')
        return
      }
      navigator.vibrate?.(40)
      onLu(resultat)
      onClose()
    } catch (erreur) {
      setMessage(erreur instanceof Error ? erreur.message : 'La lecture a échoué. Réessaie.')
      setEtat('pret')
    }
  }

  return (
    <div className={`scanner scan-etiquette scan-etiquette--${quoi}`}>
      {etat === 'refus' || etat === 'erreur' ? (
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
      ) : (
        <div className="scanner__stage" ref={sceneRef}>
          <video ref={videoRef} className="scanner__video" muted playsInline />
          <div ref={cadreRef} className={`viseur viseur--${quoi}`} aria-hidden="true">
            <span className="viseur__coin viseur__coin--hg" />
            <span className="viseur__coin viseur__coin--hd" />
            <span className="viseur__coin viseur__coin--bg" />
            <span className="viseur__coin viseur__coin--bd" />
          </div>
          <p className="viseur__astuce">{libelles.consigne}</p>
          {etat === 'demarrage' && <p className="scanner__overlay">Ouverture de la caméra…</p>}
          {etat === 'lecture' && <p className="scanner__overlay">Lecture…</p>}
        </div>
      )}

      {message !== null && etat === 'pret' && (
        <p className="field__error" role="alert">
          {message}
        </p>
      )}

      <button
        type="button"
        className="button button--primary button--block"
        onClick={() => void lire()}
        disabled={etat !== 'pret'}
      >
        {etat === 'lecture' ? 'Lecture…' : 'Lire'}
      </button>
    </div>
  )
}

export interface BoutonScanProps {
  readonly quoi: ScanKind
  readonly onLu: (resultat: ScanResult) => void
  /** Texte du bouton ; sans lui, une icone seule, pour une place etroite. */
  readonly libelle?: string | undefined
  readonly className?: string | undefined
  readonly disabled?: boolean | undefined
}

/** Le bouton, et le viseur qu'il ouvre dans une feuille. */
export function BoutonScan({ quoi, onLu, libelle, className, disabled }: BoutonScanProps) {
  const [ouvert, setOuvert] = useState(false)
  return (
    <>
      <button
        type="button"
        className={className ?? 'bouton-scan'}
        onClick={() => setOuvert(true)}
        disabled={disabled}
        aria-label={libelle === undefined ? LIBELLES[quoi].titre : undefined}
      >
        {libelle === undefined ? (
          <Icon name="ui-camera" size={18} />
        ) : (
          <Icon name="ui-camera" size={18} className="icon--inline" />
        )}
        {libelle}
      </button>
      <Sheet open={ouvert} onClose={() => setOuvert(false)} title={LIBELLES[quoi].titre}>
        {ouvert && <Viseur quoi={quoi} onLu={onLu} onClose={() => setOuvert(false)} />}
      </Sheet>
    </>
  )
}
