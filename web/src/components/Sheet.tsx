/**
 * Feuille modale — l'equivalent tactile des Window detachables du desktop.
 *
 * Le desktop ouvrait de vraies fenetres systeme, deplacables hors de
 * l'application. Sur telephone il n'y a qu'un ecran : la modale vient du bas,
 * couvre le contenu, et se referme d'un tap sur le fond ou d'un glissement du
 * pouce vers le bouton de fermeture.
 *
 * Trois pieges du telephone traites ici, et qu'aucun ecran n'aura donc a
 * traiter lui-meme :
 *
 *   1. Le corps derriere la feuille ne doit PAS defiler. `overflow: hidden` sur
 *      <body> ne suffit pas sous iOS Safari : seul `position: fixed` bloque
 *      reellement, au prix d'une restauration manuelle de la position.
 *
 *   2. La mise au point entre dans la feuille a l'ouverture et RETOURNE a
 *      l'element declencheur a la fermeture, sans quoi le lecteur d'ecran et
 *      la tabulation repartent du haut de la page.
 *
 *   3. La tabulation reste piegee dans la feuille tant qu'elle est ouverte.
 */

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons/index.js'

import '../styles/components.css'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// ---------------------------------------------------------------------------
// Blocage du defilement du corps
// ---------------------------------------------------------------------------

/**
 * Compteur partage : une ConfirmDialog ouverte PAR-DESSUS une feuille ne doit
 * pas rendre le defilement au corps en se refermant.
 */
let lockCount = 0
let savedScrollY = 0

function lockBodyScroll(): () => void {
  if (lockCount === 0) {
    savedScrollY = window.scrollY
    const { style } = document.body
    style.position = 'fixed'
    style.top = `-${savedScrollY}px`
    style.left = '0'
    style.right = '0'
    style.width = '100%'
  }
  lockCount += 1

  return () => {
    lockCount -= 1
    if (lockCount > 0) return
    const { style } = document.body
    style.position = ''
    style.top = ''
    style.left = ''
    style.right = ''
    style.width = ''
    // `position: fixed` a ramene la page en haut : on rend sa place a
    // l'utilisateur, sinon fermer une feuille le renvoie au debut de sa liste.
    window.scrollTo(0, savedScrollY)
  }
}

function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return lockBodyScroll()
  }, [active])
}

// ---------------------------------------------------------------------------
// Geste de retour
// ---------------------------------------------------------------------------

/**
 * Le retour du systeme ferme la feuille, pas la page.
 *
 * Sur telephone, le geste de retour — bouton Android, balayage depuis le bord
 * sous iOS — est le reflexe pour annuler. Sans cette gestion il quittait
 * l'ecran entier : ouvrir « Ajouter un lot », se raviser, et se retrouver
 * ejecte du frigo vers la liste de courses.
 *
 * Le principe : a l'ouverture on empile une entree d'historique bidon, que le
 * geste de retour consomme. La feuille se ferme, l'adresse est inchangee.
 * Fermer par le bouton ✕ ou par le fond doit alors DEPILER cette entree,
 * sinon elle s'accumulerait et il faudrait revenir deux fois.
 *
 * `sheetClosed` distingue les deux origines : un `popstate` cause par le geste
 * ne doit pas rappeler `history.back()`, ce qui remonterait d'un ecran de plus.
 */
/**
 * Entrees d'historique empilees dont le retrait est PROGRAMME mais pas encore
 * effectue.
 *
 * Ce compteur existe pour une raison precise : en developpement, React monte
 * les effets, les demonte, puis les remonte. Sans lui, le demontage retirait
 * l'entree que le remontage venait d'empiler — `history.back()` etant
 * asynchrone, le `popstate` arrivait APRES le nouveau `pushState` et refermait
 * la feuille a l'instant ou elle s'ouvrait. L'ecran Frigo etait inutilisable.
 *
 * Le retrait passe donc par une micro-tache, qu'un remontage immediat annule
 * en reprenant l'entree a son compte.
 */
let pendingHistoryPop = 0

/**
 * Nombre de feuilles ouvertes. SEULE la premiere touche a l'historique.
 *
 * Une feuille peut en ouvrir une autre : le scanner de code-barres vit dans la
 * feuille d'import. Quand chacune empilait son entree, fermer la feuille fille
 * retirait la sienne, le `popstate` qui en resultait etait capte par la feuille
 * MERE — encore a l'ecoute — et fermait tout. Concretement : on scannait un
 * produit et l'ecran entier disparaissait avant de l'afficher.
 *
 * Une seule participante supprime la classe de bug. Consequence assumee : le
 * geste de retour ferme alors la pile entiere, pas seulement la feuille du
 * dessus. C'est previsible, et infiniment preferable a une fermeture surprise.
 */
let openSheets = 0

function useBackToClose(active: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!active) return

    const isOutermost = openSheets === 0
    openSheets++
    if (!isOutermost) {
      return () => {
        openSheets--
      }
    }

    let closedByGesture = false
    // Une entree en attente de retrait est reprise telle quelle : c'est le cas
    // du remontage decrit ci-dessus.
    if (pendingHistoryPop > 0) pendingHistoryPop--
    else history.pushState({ sheet: true }, '')

    const onPop = () => {
      closedByGesture = true
      onCloseRef.current()
    }
    window.addEventListener('popstate', onPop)

    return () => {
      openSheets--
      window.removeEventListener('popstate', onPop)
      // Fermeture par le geste : le navigateur a deja depile, rien a faire.
      if (closedByGesture) return

      // Fermeture par ✕, par le fond ou par Echap : l'entree est encore la.
      // On la retire, sauf si un remontage la reprend d'ici la.
      pendingHistoryPop++
      queueMicrotask(() => {
        if (pendingHistoryPop === 0) return
        pendingHistoryPop--
        if (history.state?.sheet === true) history.back()
      })
    }
  }, [active])
}

// ---------------------------------------------------------------------------
// Mise au point
// ---------------------------------------------------------------------------

function useFocusCapture(active: boolean, panelRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    if (!active) return
    const previous = document.activeElement
    // On vise le panneau lui-meme, pas son premier champ : ouvrir le clavier
    // d'office masque la moitie de la feuille avant meme que l'utilisateur ait
    // lu le titre. Un ecran qui veut le clavier tout de suite pose `autoFocus`
    // sur le champ concerne.
    panelRef.current?.focus()

    return () => {
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus()
    }
  }, [active, panelRef])
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

export interface SheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly children: ReactNode
  /** Boutons du pied de feuille. Ils occupent la largeur a parts egales. */
  readonly actions?: ReactNode | undefined
  /**
   * `false` desarme le fond et Echap — pendant un enregistrement, fermer
   * ferait croire a une annulation alors que la requete est partie.
   */
  readonly dismissible?: boolean | undefined
  /**
   * `'dialog'` : panneau compact, pour une question courte.
   * `'plein'` : toute la hauteur de l'ecran, pour parcourir une collection.
   */
  readonly variant?: 'sheet' | 'dialog' | 'plein' | undefined
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  actions,
  dismissible = true,
  variant = 'sheet',
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useBodyScrollLock(open)
  useFocusCapture(open, panelRef)
  useBackToClose(open, onClose)

  useEffect(() => {
    if (!open || !dismissible) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, dismissible, onClose])

  if (!open) return null

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    // `offsetParent` ecarte ce qui est masque : un champ dans une section
    // repliee ne doit pas capturer la tabulation.
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null,
    )
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className={`sheet sheet--${variant}`}>
      <div
        className="sheet__backdrop"
        onClick={dismissible ? onClose : undefined}
        // Le fond n'est pas une commande : le lecteur d'ecran l'ignore, la
        // fermeture au clavier passe par Echap et par le bouton de fermeture.
        aria-hidden="true"
      />
      <div
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <div className="sheet__header">
          <h2 className="sheet__title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Fermer">
            <Icon name="ui-close" size={18} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {actions && <div className="sheet__actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// ConfirmDialog
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  readonly open: boolean
  readonly title: string
  readonly message: ReactNode
  readonly onConfirm: () => void
  readonly onClose: () => void
  readonly confirmLabel?: string | undefined
  readonly cancelLabel?: string | undefined
  /** Action destructrice : bouton rouge. */
  readonly danger?: boolean | undefined
  /** Requete en cours : boutons desactives, fermeture desarmee. */
  readonly busy?: boolean | undefined
  /** `mutation.error?.message` — affiche pres du bouton, pas ailleurs. */
  readonly error?: string | null | undefined
}

export function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onClose,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  danger,
  busy,
  error,
}: ConfirmDialogProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      variant="dialog"
      dismissible={!busy}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${danger ? 'button--danger' : 'button--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="sheet__message">{message}</p>
      {error && (
        <p className="text-error" role="alert">
          {error}
        </p>
      )}
    </Sheet>
  )
}
