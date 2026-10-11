/**
 * Les etapes d'une recette, EN LECTURE : la fiche et la revue d'un import.
 *
 * UN SEUL RENDU POUR LES DEUX, parce que la revue doit montrer ce que la fiche
 * montrera : deux rendus finiraient par diverger, et l'on relirait a l'import
 * un texte qui ne s'afficherait pas pareil une fois la recette creee.
 *
 * Une etape de plusieurs phrases devient une liste de GESTES, un par ligne
 * (`stepParts`) : un site publie souvent six phrases d'un bloc, et l'on ne
 * retrouve pas ou l'on en est d'un coup d'oeil, les mains occupees. Durees et
 * temperatures ressortent la ou elles sont ecrites (`cueSegments`), l'astuce
 * du site se lit a part, sous les gestes. Rien de tout cela n'est stocke :
 * `recipe.instructions` reste le texte tape ou importe.
 */

import { Fragment, useMemo } from 'react'
import { cueSegments, stepParts, type Step } from '@prandia/shared'

import '../../styles/etapes.css'

export function EtapesRecette({ etapes }: { readonly etapes: readonly Step[] }) {
  return (
    <ol className="fiche-etapes">
      {etapes.map((e, i) =>
        e.heading ? (
          <li key={i} className="fiche-etape fiche-etape--titre">
            {e.text}
          </li>
        ) : (
          <li key={i} className="fiche-etape">
            <span className="fiche-etape__numero chiffre">{e.index}</span>
            <Corps texte={e.text} />
          </li>
        ),
      )}
    </ol>
  )
}

function Corps({ texte }: { readonly texte: string }) {
  const { gestures, tip } = useMemo(() => stepParts(texte), [texte])
  const [seul] = gestures
  return (
    <div className="fiche-etape__corps">
      {gestures.length > 1 ? (
        <ul className="fiche-etape__gestes">
          {gestures.map((g, i) => (
            <li key={i} className="fiche-etape__geste">
              <Reperes texte={g} />
            </li>
          ))}
        </ul>
      ) : (
        seul !== undefined && (
          <p className="fiche-etape__texte">
            <Reperes texte={seul} />
          </p>
        )
      )}
      {tip !== null && (
        <p className="fiche-etape__astuce">
          <span className="fiche-etape__astuce-titre">Astuce</span>
          {tip}
        </p>
      )}
    </div>
  )
}

/** Le geste, ses durees et temperatures en gras, a leur place dans la phrase. */
function Reperes({ texte }: { readonly texte: string }) {
  return (
    <>
      {cueSegments(texte).map((m, i) =>
        m.cue ? (
          <strong key={i} className="fiche-etape__repere">
            {m.text}
          </strong>
        ) : (
          <Fragment key={i}>{m.text}</Fragment>
        ),
      )}
    </>
  )
}
