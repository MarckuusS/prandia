/**
 * Les reperes du jour : sel, sucres, acides gras satures, fibres.
 *
 * QUATRE JAUGES SEPAREES, et aucune n'en modifie une autre. C'est le point de
 * ce bloc autant que son contenu : l'idee que les fibres du jour rachetent
 * les sucres du jour est juste dans son mecanisme et fausse a cette echelle,
 * et le module `shared/src/limits.ts` explique pourquoi en detail.
 *
 * TROIS PLAFONDS ET UN PLANCHER. Les fibres se VISENT, elles ne se limitent
 * pas : la barre se remplit dans l'autre sens, et un manque n'est pas un
 * depassement. Confondre les deux ferait feliciter d'en manquer.
 *
 * CE SONT DES REPERES, PAS DES VERDICTS. Les recommandations dont ils
 * viennent portent sur des moyennes de long terme, pas sur une journee. D'ou
 * une zone intermediaire avant le franchissement, et aucune couleur d'alarme :
 * le rouge est reserve au depassement franc, et il reste un constat.
 */

import {
  FIBER_MIN_G,
  SATURATED_ANSES_PERCENT,
  SATURATED_MAX_PERCENT,
  SUGARS_WHO_FREE_PERCENT,
  dailyLimits,
  saturatedAnsesG,
  type DailyLimit,
} from '@prandia/shared'

import { NutrientLabel } from '../../components/NutrientLabel.js'

const g = (v: number) =>
  v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })

const LIGNES = [
  { cle: 'salt', label: 'Sel' },
  { cle: 'sugars', label: 'Sucres' },
  { cle: 'saturatedFats', label: 'Acides gras saturés' },
  { cle: 'fiber', label: 'Fibres' },
] as const

export function Reperes({ kcalTarget }: { readonly kcalTarget: number | null }) {
  const limites = dailyLimits(kcalTarget)

  return (
    <div className="card">
      <h2 className="card__title">Les repères du jour</h2>
      <p className="card__lead">
        Trois plafonds et un plancher, à côté de la cible en calories. Ils viennent des agences,
        pas de l’application, et portent sur des <strong>moyennes de long terme</strong> : une
        journée au-dessus n’est pas un accident de santé.
      </p>

      <ul className="reperes">
        {LIGNES.map(({ cle, label }) => {
          const limite: DailyLimit = limites[cle]
          return (
            <li key={cle} className="repere">
              <NutrientLabel nutrient={cle} label={label} />
              <span className="repere__valeur">
                {limite.sens === 'plancher' ? 'au moins ' : 'au plus '}
                <b>{g(limite.grams)} g</b>
              </span>
              <span className="repere__source">{limite.source}</span>
            </li>
          )
        })}
      </ul>

      <dl className="reperes__notes">
        <dt>Sucres</dt>
        <dd>
          Ce repère porte sur les sucres <strong>totaux</strong>, parce que c’est ce que mesurent
          les tables de composition. L’OMS, elle, vise {SUGARS_WHO_FREE_PERCENT} % de l’énergie en
          sucres <strong>libres</strong> : elle ne compte ni les sucres des fruits entiers, ni le
          lactose du lait. Le total lu ici est donc plus haut que ce que mesurerait une cible OMS,
          et l’application ne sait pas faire la différence.
        </dd>

        <dt>Acides gras saturés</dt>
        <dd>
          {SATURATED_MAX_PERCENT} % de l’énergie du jour selon l’OMS (2023),{' '}
          {SATURATED_ANSES_PERCENT} % selon l’Afssa, devenue l’ANSES (avis de 2010), soit{' '}
          {g(saturatedAnsesG(kcalTarget))} g avec ta cible. Les deux agences divergent ; le repère
          affiché retient la plus stricte.
          {kcalTarget === null && ' Faute de cible, il est calculé sur 2 000 kcal, la valeur que les agences emploient pour illustrer leurs pourcentages.'}
        </dd>

        <dt>Sucres et fibres</dt>
        <dd>
          Les deux se lisent <strong>séparément</strong>. Une fibre visqueuse ralentit bien
          l’absorption du sucre avalé <strong>avec elle, dans le même repas</strong> : c’est ce qui
          sépare une pomme d’un verre de jus. Mais elle ne rattrape pas un sucre avalé trois heures
          plus tôt, et aucune agence ne fait dépendre le plafond de sucres des fibres de la
          journée. Viser au moins {FIBER_MIN_G} à 30 g de fibres, et rester sous le plafond de
          sucres : ce sont deux objectifs, pas une balance.
        </dd>
      </dl>
    </div>
  )
}
