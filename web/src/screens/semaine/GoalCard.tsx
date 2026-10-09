/**
 * Ou en est la journee par rapport a l'objectif personnel.
 *
 * C'est la carte qui rend le profil utile : sans elle, l'ecran Profil ne serait
 * qu'un formulaire qui calcule un chiffre que rien ne compare a la realite.
 *
 * DEUX PRECAUTIONS qui tiennent a la structure des donnees :
 *
 *   1. Le calendrier planifie pour LA CUISINE. Aucune entree ne dit qui mange.
 *      Le total du jour est donc divise par le nombre de mangeurs declare avant
 *      d'etre compare a un objectif personnel — sinon la comparaison est fausse
 *      d'un facteur egal a ce nombre. La carte le dit quand ils sont plusieurs,
 *      parce qu'un chiffre divise sans le dire est un chiffre faux.
 *
 *   2. La cible se recalcule ici, du profil, par la meme fonction que l'ecran
 *      Profil. Elle n'est ni stockee ni transmise : deux copies d'un meme
 *      chiffre finissent toujours par diverger.
 */

import { Link } from 'react-router'
import { perEater, progressToward, type NutritionTotal } from '@prandia/shared'

import { NutrientLabel } from '../../components/NutrientLabel.js'
import { useDailyTargets } from '../../lib/useDailyTargets.js'
import '../../styles/profile.css'

const round = (value: number) => Math.round(value).toLocaleString('fr-FR')

export function GoalCard({
  dayTotal,
  hasEntries,
}: {
  readonly dayTotal: NutritionTotal
  readonly hasEntries: boolean
}) {
  const { etat, targets, kcalTarget, eaters } = useDailyTargets()

  // Une carte secondaire ne doit pas parasiter l'ecran principal : tant que le
  // profil n'est pas charge, ou s'il a echoue, elle ne s'affiche simplement pas.
  if (etat === 'chargement') return null

  if (kcalTarget === null) {
    return (
      <div className="card">
        <h3 className="card__title">Mon objectif</h3>
        <p className="card__lead">
          <Link to="/objectifs/reglages">Renseigne ton profil</Link> pour comparer cette journée à un
          objectif journalier.
        </p>
      </div>
    )
  }

  const mine = perEater(dayTotal.kcal, eaters)
  const progress = progressToward(mine, kcalTarget)

  return (
    <div className="card">
      <h3 className="card__title">Mon objectif</h3>

      <div className="goal-bar">
        <div className="goal-bar__track">
          <span
            className={`goal-bar__fill${progress.over ? ' goal-bar__fill--over' : ''}`}
            // Bornee a 100 % : au-dela la barre deborderait de sa piste, alors
            // que le depassement est deja dit en toutes lettres juste dessous.
            style={{ width: `${Math.min(progress.ratio, 1) * 100}%` }}
          />
        </div>
        <p className="goal-bar__label">
          {hasEntries ? (
            <>
              <strong>{round(mine)} kcal</strong> sur {round(kcalTarget)} —{' '}
              {progress.over
                ? `${round(progress.gap)} kcal au-dessus`
                : `il reste ${round(progress.gap)} kcal`}
            </>
          ) : (
            <>Rien de prévu ce jour. Objectif : {round(kcalTarget)} kcal.</>
          )}
        </p>
      </div>

      {targets !== null && hasEntries && (
        <ul className="profile-macros">
          {([
            ['proteins', 'Protéines', targets.proteins.grams],
            ['carbs', 'Glucides', targets.carbs.grams],
            ['fats', 'Lipides', targets.fats.grams],
          ] as const).map(([key, label, goalGrams]) => (
            <li key={key}>
              <NutrientLabel nutrient={key} label={label} />
              <span className="profile-macros__value">
                {perEater(dayTotal[key], eaters).toFixed(0)} / {goalGrams} g
              </span>
            </li>
          ))}
        </ul>
      )}

      {eaters > 1 && (
        <p className="note">
          Part pour une personne : le total du jour a été divisé par {eaters} mangeurs. Réglage dans{' '}
          <Link to="/objectifs">Mes objectifs</Link>.
        </p>
      )}
    </div>
  )
}
