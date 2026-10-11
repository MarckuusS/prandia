/**
 * Rendre a l'application installee la hauteur qu'iOS lui a retiree.
 *
 * LE DEFAUT. Revenu dans l'application installee alors que le clavier etait
 * ouvert ailleurs (une recherche dans Safari, constate le 2026-10-11), iOS la
 * retrecit de la hauteur du clavier et ne la lui rend pas : `innerHeight` et
 * `100dvh` restent bas, et la barre d'onglets, posee en `position: fixed;
 * bottom: 0`, flotte au milieu de l'ecran avec le contenu visible dessous.
 * Le meme retrecissement suit parfois la fermeture du clavier de
 * l'application elle-meme. Defaut connu de WebKit en mode installe, sans
 * correctif cote Apple ; tourner le telephone et revenir le reparait.
 *
 * LA PARADE. Aucune regle CSS ne l'empeche (`interactive-widget` est ignore en
 * mode installe, verrouiller la coquille en `position: fixed` la fige a la
 * petite hauteur). On le laisse arriver, on le DETECTE, et l'on force WebKit a
 * remesurer : masquer puis reafficher un element de toute la hauteur, avec un
 * calcul de mise en page force entre les deux. Rien n'est peint entre-temps.
 *
 * LA DETECTION. La plus grande hauteur vue pour une largeur donnee est la
 * vraie ; en etre plus bas de quelques pixels, sans champ de saisie ouvert,
 * c'est etre retreci. Par largeur, parce qu'un telephone tourne a une autre
 * hauteur legitime. Jamais pendant une saisie : la, le clavier occupe
 * vraiment la place, et forcer la mise en page ferait sauter le champ.
 */

/** Sous cet ecart, c'est un arrondi, pas un retrecissement. */
const TOLERANCE_PX = 4

/** iOS rend sa hauteur par etapes au retour au premier plan : on regarde plusieurs fois. */
const VERIFICATIONS_MS = [0, 250, 800] as const

const enModeInstalle = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  // Safari iOS n'implemente pas display-mode et expose ce booleen non standard.
  (navigator as Navigator & { standalone?: boolean }).standalone === true

/** Un champ qui ouvre le clavier, ou la roue d'une liste deroulante. */
function saisieEnCours(): boolean {
  const el = document.activeElement
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  )
}

export function healStandaloneViewport(): void {
  // Au doigt seulement : installee sur un ordinateur, une fenetre qu'on
  // rapetisse en hauteur passerait pour retrecie, et serait remesuree pour rien.
  if (!enModeInstalle() || !window.matchMedia('(hover: none) and (pointer: coarse)').matches) return

  const plusHaute = new Map<number, number>()
  const noter = () => {
    const largeur = Math.round(window.innerWidth)
    plusHaute.set(largeur, Math.max(plusHaute.get(largeur) ?? 0, window.innerHeight))
  }
  const retrecie = () =>
    (plusHaute.get(Math.round(window.innerWidth)) ?? window.innerHeight) - window.innerHeight > TOLERANCE_PX

  const reparer = () => {
    if (!retrecie() || saisieEnCours()) return
    // `.app` tient toute la hauteur (`min-height: var(--app-height)`) : c'est
    // la condition pour que la remesure porte sur la fenetre entiere.
    const coquille = document.querySelector<HTMLElement>('.app')
    if (coquille === null) return
    const defilement = window.scrollY
    coquille.style.display = 'none'
    void coquille.offsetHeight
    coquille.style.display = ''
    // La coquille masquee, la page n'avait plus de hauteur : le defilement
    // retombait a zero.
    window.scrollTo(0, defilement)
    noter()
  }

  let minuteurs: ReturnType<typeof setTimeout>[] = []
  const verifier = () => {
    minuteurs.forEach(clearTimeout)
    minuteurs = VERIFICATIONS_MS.map((ms) => setTimeout(reparer, ms))
  }

  noter()
  window.addEventListener('resize', () => {
    noter()
    verifier()
  })
  // Retour au premier plan : le cas constate.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') verifier()
  })
  window.addEventListener('pageshow', verifier)
  // Fermeture du clavier de l'application : le champ perd la main.
  document.addEventListener('focusout', verifier)
}
