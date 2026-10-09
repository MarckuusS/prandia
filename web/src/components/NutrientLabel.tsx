/**
 * Libelle de nutriment avec son pictogramme.
 *
 * Les icones etaient des IMAGES, reprises du bureau : huit PNG de 250 px
 * reduits a 72 et quantifies en palette, 58 Ko a eux tous. Elles ont ete
 * remplacees par le jeu d'icones de l'application, et ce n'est pas qu'une
 * question de poids :
 *
 *   - une image ne se TEINTE pas. Le tricolore macro ne pouvait pas l'atteindre,
 *     alors qu'il colore tout le reste de l'application ;
 *   - une image ne suit pas le THEME SOMBRE : le meme dessin y restait clair ;
 *   - une image ne suit pas la TAILLE DU TEXTE : agrandie, elle se pixellise.
 *
 * Les dessins viennent des memes sources que le reste du jeu — Lucide, sauf la
 * saliere que Tabler est seul a avoir. Ils sont declares dans `MAP`
 * (scripts/import-lucide.mjs) et non colles ici : c'est la regle du projet, et
 * elle garantit qu'ils sont rendus dans le meme cadre que les autres, trait
 * compris.
 *
 * Les sous-lignes du tableau reglementaire — « dont sucres », « dont acides
 * gras saturés » — gardent leur picto propre mais en retrait : elles sont un
 * detail de la ligne au-dessus, pas un nutriment de plus.
 */

import type { NutritionTotal } from '@prandia/shared'

import { Icon, type IconName } from '../icons/index.js'

/**
 * Nutriment vers dessin.
 *
 * Les sous-lignes DERIVENT de leur famille, elles ne vivent pas leur vie : les
 * satures sont deux gouttes la ou les lipides en ont une, les sucres un bonbon
 * a cote de l'epi des glucides. C'est la meme discipline que les couleurs, ou
 * `--color-nutrient-sugars` est un miel plus profond.
 */
const ICONS: Record<keyof NutritionTotal, IconName> = {
  kcal: 'ui-zap',
  proteins: 'ui-biceps',
  carbs: 'ui-wheat',
  sugars: 'ui-candy',
  fats: 'ui-droplet',
  saturatedFats: 'ui-droplets',
  fiber: 'ui-leaf',
  salt: 'ui-salt',
}

export interface NutrientLabelProps {
  readonly nutrient: keyof NutritionTotal
  /** Sous-ligne du tableau reglementaire : retrait, italique, picto plus petit. */
  readonly sub?: boolean
  readonly label: string
}

export function NutrientLabel({ nutrient, label, sub = false }: NutrientLabelProps) {
  return (
    <span className={`nutrient-label${sub ? ' nutrient-label--sub' : ''}`}>
      {/* Teinte par la couleur du nutriment, ce qu'une image ne permettait pas.
          `nutrient-label__icon` porte la couleur ; l'icone, elle, ne connait
          que `currentColor` — c'est ce qui la laisse suivre le theme. */}
      <span className={`nutrient-label__icon nutrient-label__icon--${nutrient}`} aria-hidden="true">
        <Icon name={ICONS[nutrient]} size={sub ? 16 : 20} strokeWidth={1.7} />
      </span>
      {label}
    </span>
  )
}
