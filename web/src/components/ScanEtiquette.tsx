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
 * EN RAFALE, AU CHARIOT (2026-10-14) : `BoutonRafale` prend jusqu'a trois
 * photos d'un article a la suite, lues d'un coup et en arriere-plan
 * (screens/courses/lecturesArticle.ts). Le viseur ne fige que le temps d'un
 * eclair, et repart pour la photo suivante.
 *
 * POURQUOI PAS `<input capture>`. L'appareil photo du systeme prend tout
 * l'ecran, demande "Utiliser la photo", et rend une image de douze
 * megapixels ou l'etiquette n'occupe qu'un coin. Ici on vise, et on envoie ce
 * qu'on a vise.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ARTICLE_PHOTOS_MAX, isEmptyScan, type ScanKind, type ScanResult } from '@prandia/shared'

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

type EtatCamera = 'demarrage' | 'pret' | 'refus' | 'erreur'

/**
 * La camera partagee (`camera.ts`) branchee sur une video, le temps que le
 * viseur est ouvert : empruntee a l'ouverture, rendue a la fermeture.
 */
function useCameraDuViseur(videoRef: RefObject<HTMLVideoElement | null>): {
  readonly camera: EtatCamera
  readonly messageCamera: string | null
} {
  const fluxRef = useRef<MediaStream | null>(null)
  const [etat, setEtat] = useState<EtatCamera>('demarrage')
  const [messageCamera, setMessageCamera] = useState<string | null>(null)

  const rendreCamera = useCallback(() => {
    const flux = fluxRef.current
    fluxRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    if (flux) camera().release(flux)
  }, [videoRef])

  useEffect(() => {
    let annule = false
    void (async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setEtat('erreur')
        setMessageCamera('Ce navigateur ne donne pas accès à la caméra.')
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
  }, [rendreCamera, videoRef])

  return { camera: etat, messageCamera }
}

/** Refus ou panne de la camera : ce qu'on en dit, a la place de la scene. */
function CameraIndisponible({ refus, message }: { readonly refus: boolean; readonly message: string | null }) {
  return (
    <div className="scanner scan-etiquette">
      <div className="scanner__stage scanner__stage--message">
        <p className="status status--error" role="alert">
          {refus ? 'Accès à la caméra refusé.' : (message ?? 'La caméra n’a pas pu démarrer.')}
        </p>
        {refus && (
          <p className="card__lead">
            Autorise l’appareil photo pour ce site dans les réglages du téléphone, puis rouvre cet écran.
          </p>
        )}
      </div>
    </div>
  )
}

/** Le cadre de lecture : seul ce rectangle part au serveur, marge comprise. */
function Cadre({ forme, cadreRef }: { readonly forme: string; readonly cadreRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={cadreRef} className={`viseur viseur--${forme}`} aria-hidden="true">
      <span className="viseur__coin viseur__coin--hg" />
      <span className="viseur__coin viseur__coin--hd" />
      <span className="viseur__coin viseur__coin--bg" />
      <span className="viseur__coin viseur__coin--bd" />
    </div>
  )
}

/**
 * `fige` : la video est arretee sur l'image envoyee, pendant la lecture puis
 * quand elle n'a rien donne (on voit pourquoi : flou, reflet, mauvais cadrage).
 */
type EtatLecture = 'attente' | 'lecture' | 'fige'

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
  const { camera: etatCamera, messageCamera } = useCameraDuViseur(videoRef)
  const [lecture, setLecture] = useState<EtatLecture>('attente')
  const [message, setMessage] = useState<string | null>(null)
  const libelles = LIBELLES[quoi]

  const declencher = async () => {
    const video = videoRef.current
    const scene = sceneRef.current
    const cadre = cadreRef.current
    if (video === null || scene === null || cadre === null || video.videoWidth === 0) return
    // FIGER D'ABORD : l'image arretee a l'ecran est celle qui part.
    video.pause()
    setLecture('lecture')
    setMessage(null)
    try {
      const image = await decouper(video, scene, cadre, COTE_MAX[quoi])
      const resultat = await scanEtiquette(quoi, image)
      if (isEmptyScan(resultat)) {
        setMessage(libelles.vide)
        setLecture('fige')
        return
      }
      navigator.vibrate?.(40)
      onLu(resultat)
      onClose()
    } catch (erreur) {
      setMessage(erreur instanceof Error ? erreur.message : 'La lecture a échoué. Reprends la photo.')
      setLecture('fige')
    }
  }

  const reprendre = () => {
    setMessage(null)
    setLecture('attente')
    void videoRef.current?.play().catch(() => undefined)
  }

  if (etatCamera === 'refus' || etatCamera === 'erreur') {
    return <CameraIndisponible refus={etatCamera === 'refus'} message={messageCamera} />
  }

  const fige = lecture !== 'attente'
  return (
    <div className={`scanner scan-etiquette scan-etiquette--${quoi}`}>
      <div className={`scanner__stage${fige ? ' scanner__stage--fige' : ''}`} ref={sceneRef}>
        <video ref={videoRef} className="scanner__video" muted playsInline />
        <Cadre forme={quoi} cadreRef={cadreRef} />
        {!fige && <p className="viseur__astuce">{libelles.consigne}</p>}
        {etatCamera === 'demarrage' && <p className="scanner__overlay">Ouverture de la caméra…</p>}
        {lecture === 'lecture' && (
          <p className="scan-etiquette__lecture" role="status">
            <Savarin size={22} occupe />
            {libelles.lecture}
          </p>
        )}
        {!fige && (
          <button
            type="button"
            className="scan-etiquette__declencheur"
            onClick={() => void declencher()}
            disabled={etatCamera !== 'pret'}
            aria-label={`Prendre la photo : ${libelles.titre.toLowerCase()}`}
          >
            <span className="scan-etiquette__declencheur-centre" />
          </button>
        )}
      </div>

      {lecture === 'fige' && (
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

// ---------------------------------------------------------------------------
// En rafale : plusieurs photos d'un article, lues en arriere-plan
// ---------------------------------------------------------------------------

/** Une photo qui vise une etiquette entiere ou un emballage : la definition d'une date. */
const COTE_RAFALE = 1024

/** Le temps de l'eclair : la photo est prise, la video repart. */
const ECLAIR_MS = 260

/**
 * Trois photos d'un MEME article a la suite (le prix, le poids, la date),
 * puis "Envoyer" : Savarin lit pendant qu'on va chercher l'article suivant
 * (screens/courses/lecturesArticle.ts). Le viseur ne fige que le temps d'un
 * eclair et repart pour la photo suivante ; la troisieme envoie d'elle-meme.
 * Une photo ratee se retire de sa vignette.
 */
function ViseurRafale({
  onEnvoyer,
  onClose,
}: {
  readonly onEnvoyer: (photos: readonly Blob[]) => void
  readonly onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const sceneRef = useRef<HTMLDivElement | null>(null)
  const cadreRef = useRef<HTMLDivElement | null>(null)
  const { camera: etatCamera, messageCamera } = useCameraDuViseur(videoRef)
  const [photos, setPhotos] = useState<ReadonlyArray<{ readonly blob: Blob; readonly url: string }>>([])
  const [eclair, setEclair] = useState(false)
  const [erreur, setErreur] = useState<string | null>(null)

  // Les vignettes sont des URL d'objets : rendues au navigateur a la fermeture.
  const urls = useRef<string[]>([])
  useEffect(() => () => urls.current.forEach((url) => URL.revokeObjectURL(url)), [])

  const envoyer = (blobs: readonly Blob[]) => {
    if (blobs.length === 0) return
    onEnvoyer(blobs)
    onClose()
  }

  const declencher = async () => {
    const video = videoRef.current
    const scene = sceneRef.current
    const cadre = cadreRef.current
    if (video === null || scene === null || cadre === null || video.videoWidth === 0 || eclair) return
    video.pause()
    setEclair(true)
    setErreur(null)
    let blob: Blob
    try {
      blob = await decouper(video, scene, cadre, COTE_RAFALE)
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Capture impossible.')
      setEclair(false)
      void video.play().catch(() => undefined)
      return
    }
    navigator.vibrate?.(20)
    const url = URL.createObjectURL(blob)
    urls.current.push(url)
    const suite = [...photos, { blob, url }]
    setPhotos(suite)
    if (suite.length >= ARTICLE_PHOTOS_MAX) {
      envoyer(suite.map((p) => p.blob))
      return
    }
    window.setTimeout(() => {
      setEclair(false)
      void videoRef.current?.play().catch(() => undefined)
    }, ECLAIR_MS)
  }

  if (etatCamera === 'refus' || etatCamera === 'erreur') {
    return <CameraIndisponible refus={etatCamera === 'refus'} message={messageCamera} />
  }

  return (
    <div className="scanner scan-etiquette scan-etiquette--article">
      <div className={`scanner__stage${eclair ? ' scanner__stage--fige' : ''}`} ref={sceneRef}>
        <video ref={videoRef} className="scanner__video" muted playsInline />
        <Cadre forme="article" cadreRef={cadreRef} />
        <p className="viseur__astuce">
          {photos.length === 0
            ? 'La face avant, le poids, la date : une photo chacun'
            : `Photo ${photos.length + 1} sur ${ARTICLE_PHOTOS_MAX}, ou envoie`}
        </p>
        {etatCamera === 'demarrage' && <p className="scanner__overlay">Ouverture de la caméra…</p>}
        <button
          type="button"
          className="scan-etiquette__declencheur"
          onClick={() => void declencher()}
          disabled={etatCamera !== 'pret' || eclair}
          aria-label={`Prendre la photo ${photos.length + 1} sur ${ARTICLE_PHOTOS_MAX}`}
        >
          <span className="scan-etiquette__declencheur-centre" />
        </button>
      </div>

      {erreur !== null && (
        <p className="field__error" role="alert">
          {erreur}
        </p>
      )}

      {photos.length > 0 && (
        <ul className="rafale__vignettes" aria-label="Photos prises">
          {photos.map((photo, i) => (
            <li key={photo.url} className="rafale__vignette">
              <img src={photo.url} alt={`Photo ${i + 1}`} />
              <button
                type="button"
                className="rafale__retirer"
                onClick={() => setPhotos(photos.filter((p) => p !== photo))}
                aria-label={`Retirer la photo ${i + 1}`}
              >
                <Icon name="ui-close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="button button--primary button--block"
        onClick={() => envoyer(photos.map((p) => p.blob))}
        disabled={photos.length === 0}
      >
        {photos.length === 0
          ? 'Envoyer à Savarin'
          : `Envoyer ${photos.length === 1 ? 'la photo' : `les ${photos.length} photos`} à Savarin`}
      </button>
    </div>
  )
}

export interface BoutonRafaleProps {
  readonly onEnvoyer: (photos: readonly Blob[]) => void
  /** Savarin reflechit : une lecture de cet article est en cours. */
  readonly occupe?: boolean | undefined
  readonly disabled?: boolean | undefined
}

/**
 * La tete de Savarin, en bas a gauche de la feuille, en face de son action
 * principale, comme le bouton IA de la fiche d'un ingredient. Elle ouvre la
 * rafale ; les boutons des champs restent, pour corriger une valeur.
 */
export function BoutonRafale({ onEnvoyer, occupe = false, disabled }: BoutonRafaleProps) {
  const [ouvert, setOuvert] = useState(false)
  return (
    <>
      <button
        type="button"
        className="rafale-savarin"
        onClick={() => setOuvert(true)}
        disabled={disabled}
        aria-label="Photographier l’article pour Savarin"
        aria-busy={occupe}
      >
        <Savarin size={30} occupe={occupe} />
      </button>
      <Sheet open={ouvert} onClose={() => setOuvert(false)} title="Photos pour Savarin">
        {ouvert && <ViseurRafale onEnvoyer={onEnvoyer} onClose={() => setOuvert(false)} />}
      </Sheet>
    </>
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
