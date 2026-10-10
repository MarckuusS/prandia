/**
 * Aller voir la fiche d'origine : une LIGNE de navigation, pas un bouton.
 *
 * Ce geste a d'abord ete un bouton plein, vert, pose a cote d'un "Retirer"
 * rouge plein : deux aplats de couleurs de signal au milieu d'une feuille
 * calme, et le vert annoncait une validation la ou il n'y a qu'un lien. Il
 * prend desormais la forme de toute navigation de l'application : une ligne
 * qu'on touche, un chevron au bout (celui de l'editeur de recette et des
 * Parametres), et l'encre normale du texte.
 *
 * Le seul aplat de couleur d'une feuille reste son action principale.
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { Icon } from '../icons/index.js'

export function LienFiche({
  to,
  libelle,
  visuel,
  note,
}: {
  readonly to: string
  readonly libelle: string
  /** Pastille de rayon ou vignette, decorative : le libelle dit tout. */
  readonly visuel?: ReactNode
  /** Ce que quitter la feuille fait perdre, quand il y a quelque chose a perdre. */
  readonly note?: string | undefined
}) {
  return (
    <>
      <Link to={to} className="lien-fiche lien-surface">
        {visuel}
        <span className="lien-fiche__libelle">{libelle}</span>
        <Icon name="ui-chevron-right" size={18} className="lien-fiche__chevron" />
      </Link>
      {note !== undefined && <p className="field__hint">{note}</p>}
    </>
  )
}
