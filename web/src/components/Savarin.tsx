/**
 * Savarin anime : la signature de l'IA, la ou elle travaille.
 *
 * QUATRE ETATS, pilotes par une seule prop, \`occupe\` :
 *   - repos : il respire, et de temps en temps, AU HASARD, il cligne (parfois
 *     deux fois), jette un oeil d'un cote ou lisse sa moustache. Une boucle
 *     fixe se remarquait au bout de trois passages ;
 *   - touche (\`occupe\` passe a vrai) : il s'ecrase puis rebondit, yeux grands
 *     ouverts, la moustache suit avec un temps de retard ;
 *   - reflechit (tant que \`occupe\` reste vrai) : tete penchee, regard en l'air
 *     d'un cote puis de l'autre, il remonte ses lunettes, lisse un cote de sa
 *     moustache puis l'autre ; en grand, trois points de reflexion montent ;
 *   - fini (\`occupe\` repasse a faux) : un petit saut, un clin d'oeil, la
 *     moustache qui sourit ; en grand, une ampoule s'allume a la place des
 *     points. Puis le repos.
 *
 * LES PASSAGES NE SAUTENT PAS. Chaque etat demarre sa propre animation, et la
 * pose de depart de l'une n'est pas la pose d'arrivee de l'autre (la reflexion
 * commence tete penchee, le rebond finit tete droite). \`poser\` releve la pose
 * de chaque piece AVANT de changer d'etat, puis la fait glisser vers la pose
 * de depart du nouvel etat (Web Animations, quelques dixiemes de seconde). Les
 * animations CSS de chaque etat attendent ce glissement (\`animation-delay\`)
 * en tenant leur premiere image (\`backwards\`) : c'est ce qui permet de lire
 * cette premiere image au moment du changement.
 *
 * Les pieces animees sont dans le DOM de la page et non derriere un \`<use>\` :
 * les selecteurs d'etat n'atteignent pas l'arbre clone d'un \`<use>\`, et rien
 * n'y bougeait (vu en maquette).
 *
 * En mode "reduire les animations", il reste immobile : le CSS coupe tout, et
 * les glissements ne partent pas.
 */

import { useEffect, useRef } from 'react'

import { SAVARIN_MOUSTACHE_DROITE, SAVARIN_MOUSTACHE_GAUCHE, SAVARIN_VERRES } from '../icons/savarin.js'
import '../styles/savarin.css'

type Etat = 'repos' | 'touche' | 'reflechit' | 'fini'

/** Duree du glissement vers chaque etat : court au toucher, qui doit repondre tout de suite. */
const PONTS: Readonly<Record<Etat, number>> = { repos: 300, touche: 100, reflechit: 350, fini: 250 }

/** Le sursaut dure 0,55 s apres son glissement ; l'ampoule et le clin d'oeil, 1,8 s. */
const FIN_TOUCHE_MS = 650
const FIN_FINI_MS = 2200

const GESTES = ['cligne', 'cligne', 'double', 'gauche', 'droite', 'fretille'] as const

const PIECES = '.tout,.lunettes,.regard,.oeil,.pupille,.mg,.md,.bulle,.ferme-g,.ampoule,.rayons'

const calme = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

export interface SavarinProps {
  /** Cote, en pixels. 16 a 20 dans un bouton. */
  readonly size?: number
  /**
   * Vrai pendant une question a l'IA. Passer a vrai joue le sursaut puis la
   * reflexion ; revenir a faux joue la fin, puis le repos.
   */
  readonly occupe?: boolean
  /**
   * Points de reflexion et ampoule. Par defaut a partir de 40 px : plus petits,
   * ils deviendraient des taches.
   */
  readonly details?: boolean
  readonly className?: string
}

export function Savarin({ size = 20, occupe = false, details, className }: SavarinProps) {
  const racine = useRef<HTMLSpanElement | null>(null)
  const etat = useRef<Etat>('repos')
  const minuteurs = useRef<number[]>([])
  const grand = size >= 40
  const avecDetails = details ?? grand

  /** Change d'etat en faisant glisser chaque piece depuis sa pose du moment. */
  const poser = (suivant: Etat) => {
    const noeud = racine.current
    if (noeud === null || etat.current === suivant) return
    const pieces = [...noeud.querySelectorAll<SVGElement>(PIECES)]
    const avant = pieces.map((p) => {
      const s = getComputedStyle(p)
      return [s.transform, s.opacity] as const
    })
    etat.current = suivant
    noeud.dataset['idle'] = ''
    noeud.dataset['etat'] = suivant
    if (calme() || typeof pieces[0]?.animate !== 'function') return
    pieces.forEach((p, i) => {
      const s = getComputedStyle(p)
      const [t0, o0] = avant[i] ?? ['none', '1']
      if (t0 === s.transform && o0 === s.opacity) return
      p.animate(
        [
          { transform: t0, opacity: o0 },
          { transform: s.transform, opacity: s.opacity },
        ],
        { duration: PONTS[suivant], easing: 'cubic-bezier(.4,0,.2,1)' },
      )
    })
  }

  const attendre = (ms: number, suite: () => void) => {
    minuteurs.current.push(window.setTimeout(suite, ms))
  }
  const vider = () => {
    minuteurs.current.forEach((m) => window.clearTimeout(m))
    minuteurs.current = []
  }

  // Le cycle d'une question : sursaut et reflexion a l'aller, fin au retour.
  useEffect(() => {
    vider()
    if (occupe) {
      poser('touche')
      attendre(FIN_TOUCHE_MS, () => poser('reflechit'))
    } else if (etat.current === 'touche' || etat.current === 'reflechit') {
      poser('fini')
      attendre(FIN_FINI_MS, () => poser('repos'))
    }
    return vider
    // `poser` et `attendre` ne lisent que des refs : seul `occupe` compte.
  }, [occupe])

  // Les gestes du repos, au hasard, toutes les deux a cinq secondes.
  useEffect(() => {
    if (calme()) return
    let minuteur = 0
    const suivant = () => {
      minuteur = window.setTimeout(() => {
        const noeud = racine.current
        if (noeud !== null && etat.current === 'repos') {
          const geste = GESTES[Math.floor(Math.random() * GESTES.length)] ?? 'cligne'
          noeud.dataset['idle'] = ''
          // Relire une mesure relance l'animation CSS si le meme geste revient.
          void noeud.getBoundingClientRect()
          noeud.dataset['idle'] = geste
        }
        suivant()
      }, 2200 + Math.random() * 3000)
    }
    suivant()
    return () => window.clearTimeout(minuteur)
  }, [])

  const pupille = grand ? 0.8 : 0.9
  return (
    <span
      ref={racine}
      className={className === undefined ? 'savarin' : `savarin ${className}`}
      data-etat="repos"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={grand ? 1.2 : 1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        <g className="tout">
          <g className="lunettes">
            <g dangerouslySetInnerHTML={{ __html: SAVARIN_VERRES }} />
            <g className="regard">
              <g className="oeil oeil-g">
                <circle className="pupille" cx="7.3" cy="8.7" r={pupille} fill="currentColor" stroke="none" />
              </g>
              <g className="oeil oeil-d">
                <circle className="pupille" cx="16.7" cy="8.7" r={pupille} fill="currentColor" stroke="none" />
              </g>
            </g>
            <path className="ferme-g" d="M6.3 9Q7.3 8 8.3 9" strokeWidth={grand ? 1 : 1.3} />
          </g>
          <g className="mg">
            <path d={SAVARIN_MOUSTACHE_GAUCHE} fill="currentColor" stroke="none" />
          </g>
          <g className="md">
            <path d={SAVARIN_MOUSTACHE_DROITE} fill="currentColor" stroke="none" />
          </g>
          {avecDetails && (
            <>
              <circle className="bulle" cx="20.2" cy="3.6" r="0.45" fill="currentColor" stroke="none" />
              <circle className="bulle b2" cx="21.4" cy="2.2" r="0.6" fill="currentColor" stroke="none" />
              <circle className="bulle b3" cx="22.8" cy="0.6" r="0.8" fill="currentColor" stroke="none" />
              <g className="ampoule" strokeWidth="0.7">
                <path d="M20.3 1.6C19.9 0.9 20-0.2 20.6-0.8C21.2-1.4 22.2-1.4 22.8-0.8C23.4-0.2 23.5 0.9 23.1 1.6C22.9 2 22.6 2.3 22.6 2.8H20.8C20.8 2.3 20.5 2 20.3 1.6Z" />
                <path d="M20.9 3.4H22.5" />
                <path d="M21.2 4H22.2" />
              </g>
              <g className="rayons" strokeWidth="0.6">
                <path d="M21.7-2.4V-3.1" />
                <path d="M19.6-1.6 19.1-2.1" />
                <path d="M23.8-1.6 24.3-2.1" />
                <path d="M19 0.4H18.3" />
                <path d="M24.4 0.4H25.1" />
              </g>
            </>
          )}
        </g>
      </svg>
    </span>
  )
}
