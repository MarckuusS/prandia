/**
 * Un seul flux camera pour toute la vie de la page.
 *
 * ---------------------------------------------------------------------------
 * LE DEFAUT QUE CE FICHIER CONTOURNE
 * ---------------------------------------------------------------------------
 * Installee sur l'ecran d'accueil d'un iPhone, l'application redemande l'acces
 * a la camera bien plus souvent que Safari ne le ferait : defaut WebKit connu
 * depuis 2018 (bugs 185448 et 215884), toujours ouvert. Le code ne peut pas
 * enregistrer une autorisation, elle appartient au systeme. Il peut seulement
 * eviter de reposer la question : chaque appel a `getUserMedia` en est une
 * occasion, et le scanner en faisait un a CHAQUE ouverture du viseur.
 *
 * Le premier scan ouvre donc le flux, les suivants le reprennent. La demande
 * au lancement de l'application, elle, reste : aucun code web ne l'evite.
 *
 * ---------------------------------------------------------------------------
 * CE QUI REMPLACE L'ARRET A LA FERMETURE
 * ---------------------------------------------------------------------------
 * L'ancienne regle disait : couper le flux a la fermeture du viseur, sinon la
 * diode reste allumee et la batterie se vide. Elle tient toujours, en deux
 * temps :
 *
 *   - viseur ferme : les pistes sont DESACTIVEES (`enabled = false`). Elles ne
 *     produisent plus d'image, et la specification autorise le navigateur a
 *     eteindre le capteur. Les reactiver ne repose aucune question ;
 *   - plus aucun viseur depuis `IDLE_STOP_MS` : arret complet. Le scan suivant
 *     redemandera peut-etre, c'est le prix d'une camera qui ne reste pas
 *     reservee toute la journee.
 *
 * Une piste terminee par le systeme (appel telephonique, autre application qui
 * prend la camera) n'est jamais reprise : on en rouvre une.
 *
 * Le module ne touche ni a `navigator` ni a `window` hors de `camera()` : la
 * logique se teste sans navigateur (`camera.test.ts`).
 */

/**
 * `ideal` et non `exact` : sur un ordinateur portable il n'y a pas de camera
 * arriere, et `exact` ferait echouer au lieu de prendre celle qui existe.
 */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1280 },
  },
  audio: false,
}

/**
 * Cinq minutes : assez pour enchainer les produits d'un rayon a l'autre, ou
 * ranger les courses produit par produit, sans laisser la camera reservee
 * quand on oublie l'application ouverte.
 */
export const IDLE_STOP_MS = 5 * 60_000

export interface CameraPool {
  /** Rend le flux partage, ouvert au besoin. A rendre par `release`. */
  acquire(): Promise<MediaStream>
  /** Rend un flux obtenu par `acquire`. Idempotent cote appelant : un appel par `acquire`. */
  release(stream: MediaStream): void
  /** Arrete tout, sans delai. */
  stopAll(): void
}

export interface CameraPoolOptions {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  readonly idleStopMs?: number
  readonly constraints?: MediaStreamConstraints
}

const stopTracks = (stream: MediaStream): void => {
  stream.getTracks().forEach((track) => track.stop())
}

const setEnabled = (stream: MediaStream, enabled: boolean): void => {
  stream.getTracks().forEach((track) => {
    track.enabled = enabled
  })
}

/** Vivant tant que chaque piste video l'est : une seule piste terminee suffit a le perdre. */
const isLive = (stream: MediaStream): boolean => {
  const tracks = stream.getVideoTracks()
  return tracks.length > 0 && tracks.every((track) => track.readyState === 'live')
}

export function createCameraPool({
  getUserMedia,
  idleStopMs = IDLE_STOP_MS,
  constraints = CAMERA_CONSTRAINTS,
}: CameraPoolOptions): CameraPool {
  let current: MediaStream | null = null
  /** Une ouverture en cours : deux viseurs qui demarrent ensemble ne posent qu'une question. */
  let pending: Promise<MediaStream> | null = null
  /** Nombre de viseurs ouverts sur le flux. */
  let users = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Incremente par `stopAll`. Un flux arrive APRES un arret general appartient
   * a une page qui s'en va : on le coupe au lieu de le garder.
   */
  let generation = 0

  const clearIdle = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  const stopAll = (): void => {
    clearIdle()
    generation += 1
    if (current) stopTracks(current)
    current = null
    users = 0
  }

  /** Plus personne sur le flux : on l'eteint, puis on l'arrete s'il reste inutilise. */
  const parkIfUnused = (): void => {
    if (users > 0 || !current) return
    setEnabled(current, false)
    clearIdle()
    idleTimer = setTimeout(stopAll, idleStopMs)
  }

  const open = async (): Promise<MediaStream> => {
    if (current && isLive(current)) return current
    if (current) {
      // Termine par le systeme : il ne repartira pas, on le libere tout a fait.
      stopTracks(current)
      current = null
    }
    const startedAt = generation
    pending ??= getUserMedia(constraints).finally(() => {
      pending = null
    })
    const stream = await pending
    if (startedAt !== generation) {
      stopTracks(stream)
      const aborted = new Error('Camera arretee pendant son ouverture.')
      aborted.name = 'AbortError'
      throw aborted
    }
    current = stream
    return stream
  }

  return {
    async acquire() {
      clearIdle()
      users += 1
      try {
        const stream = await open()
        setEnabled(stream, true)
        return stream
      } catch (error) {
        users = Math.max(0, users - 1)
        parkIfUnused()
        throw error
      }
    },

    release(stream) {
      users = Math.max(0, users - 1)
      // Un flux remplace entre-temps n'est plus partage : rien ne le reprendra.
      if (stream !== current) stopTracks(stream)
      parkIfUnused()
    },

    stopAll,
  }
}

let shared: CameraPool | null = null

/** Le flux partage de l'application. */
export function camera(): CameraPool {
  if (shared) return shared
  const pool = createCameraPool({
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  })
  // `persisted` vaut vrai quand la page part dans le cache de navigation et
  // peut revenir telle quelle : on ne coupe alors rien. Sinon, elle s'en va
  // pour de bon.
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) pool.stopAll()
  })
  shared = pool
  return pool
}
