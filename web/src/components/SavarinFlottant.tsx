/**
 * Savarin en bas a gauche, quand il a quelque chose a dire.
 *
 * Sa tete animee dans un rond, un petit "!" tant qu'on ne l'a pas ecoute, et
 * sa bulle PAR-DESSUS l'interface au toucher. Une bulle posee entre deux blocs
 * de l'ecran poussait le contenu et se lisait comme une carte de plus (retour
 * de l'utilisateur) : ici, rien ne bouge tant qu'on ne l'appelle pas.
 *
 * Il n'apparait QUE s'il a quelque chose a dire : c'est a l'appelant de ne pas
 * le rendre sinon. Le "!" suit `cle` : une nouvelle idee le rallume.
 *
 * La bulle se ferme par sa croix, par Echap, par un toucher ailleurs, ou par
 * le geste qu'elle propose (`fermer` est donne a son contenu).
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { Icon } from '../icons/index.js'
import { Savarin } from './Savarin.js'
import '../styles/savarin-flottant.css'

/** Le temps du sursaut au toucher : assez pour s'ecraser, puis il cligne de l'oeil. */
const SURSAUT_MS = 350

export function SavarinFlottant({
  cle,
  label,
  children,
}: {
  /** Ce dont il parle ; quand elle change, le "!" revient. */
  readonly cle: string
  /** Ce que lit un lecteur d'ecran sur le bouton, et le nom de la bulle. */
  readonly label: string
  readonly children: (fermer: () => void) => ReactNode
}) {
  const [ouvert, setOuvert] = useState(false)
  const [ecoutee, setEcoutee] = useState<string | null>(null)
  const [sursaut, setSursaut] = useState(false)
  const bouton = useRef<HTMLButtonElement>(null)
  const bulle = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!ouvert) return
    const dehors = (e: PointerEvent) => {
      const cible = e.target as Node
      if (!bulle.current?.contains(cible) && !bouton.current?.contains(cible)) setOuvert(false)
    }
    const echap = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOuvert(false)
      bouton.current?.focus()
    }
    document.addEventListener('pointerdown', dehors)
    document.addEventListener('keydown', echap)
    return () => {
      document.removeEventListener('pointerdown', dehors)
      document.removeEventListener('keydown', echap)
    }
  }, [ouvert])

  useEffect(() => {
    if (!sursaut) return
    const minuteur = window.setTimeout(() => setSursaut(false), SURSAUT_MS)
    return () => window.clearTimeout(minuteur)
  }, [sursaut])

  const basculer = () => {
    if (ouvert) return setOuvert(false)
    setOuvert(true)
    setEcoutee(cle)
    setSursaut(true)
  }

  return (
    <>
      {ouvert && (
        <div ref={bulle} id={id} className="savarin-flottant__bulle" role="dialog" aria-label={label}>
          <button
            type="button"
            className="savarin-flottant__fermer"
            aria-label="Fermer la bulle de Savarin"
            onClick={() => setOuvert(false)}
          >
            <Icon name="ui-close" size={18} />
          </button>
          {children(() => setOuvert(false))}
        </div>
      )}
      <button
        ref={bouton}
        type="button"
        className="savarin-flottant"
        aria-label={label}
        aria-expanded={ouvert}
        aria-controls={ouvert ? id : undefined}
        onClick={basculer}
      >
        <Savarin size={40} occupe={sursaut} />
        {ecoutee !== cle && !ouvert && (
          <span className="savarin-flottant__signal" aria-hidden="true">
            !
          </span>
        )}
      </button>
    </>
  )
}
