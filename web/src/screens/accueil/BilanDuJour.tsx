/**
 * Ou en est la journee : l'anneau et les trois barres.
 *
 * C'est la piece maitresse de l'Accueil, et elle repond a UNE question — « il
 * me reste combien ? ». D'ou l'anneau plutot qu'une barre : le reste est ce qui
 * n'est pas rempli, et un cercle le montre sans qu'on ait a soustraire.
 *
 * L'anneau se lit A L'ENVERS de celui des recettes. Celui-la decompose une
 * composition en parts qui font 100 % ; celui-ci mesure une PROGRESSION vers
 * une cible, et sa portion vide est l'information principale. Deux dessins
 * proches pour deux questions differentes, c'est assume : les confondre en un
 * seul composant aurait demande un drapeau qui inverse tout.
 *
 * TROIS PRECAUTIONS heritees de GoalCard, et qui tiennent aux donnees :
 *
 *   1. Le calendrier planifie pour LA CUISINE : aucune entree ne dit qui mange.
 *      Le total est divise par le nombre de mangeurs avant d'etre compare a un
 *      objectif personnel, et l'ecran le DIT quand ils sont plusieurs — un
 *      chiffre divise en silence est un chiffre faux.
 *   2. La cible se recalcule du profil, jamais ne se stocke (`useDailyTargets`).
 *   3. Au-dela de la cible, l'arc reste plein et le depassement s'ecrit en
 *      toutes lettres : un arc qui repartirait pour un second tour se lirait
 *      comme un debut de journee.
 */

import { Link } from 'react-router'
import { perEater, progressToward, type NutritionTotal } from '@prandia/shared'

import { useDailyTargets } from '../../lib/useDailyTargets.js'
import '../../styles/accueil.css'

const RAYON = 52
const CIRCONFERENCE = 2 * Math.PI * RAYON

const arrondi = (valeur: number) => Math.round(valeur).toLocaleString('fr-FR')

/** Les trois macros, dans l'ordre du tricolore. */
const MACROS = [
  { cle: 'proteins', label: 'Protéines' },
  { cle: 'carbs', label: 'Glucides' },
  { cle: 'fats', label: 'Lipides' },
] as const

export function BilanDuJour({
  dayTotal,
  hasEntries,
}: {
  readonly dayTotal: NutritionTotal
  readonly hasEntries: boolean
}) {
  const { etat, targets, kcalTarget, eaters } = useDailyTargets()

  // Tant que le profil n'a pas repondu, on ne montre RIEN plutot qu'un anneau
  // vide qui se remplirait brusquement : l'oeil lirait le premier etat comme
  // une journee a zero.
  if (etat === 'chargement') return null

  if (etat === 'absent' || kcalTarget === null) {
    return (
      <div className="card">
        <h2 className="card__title">Ma journée</h2>
        <p className="card__lead">
          <Link to="/objectifs/reglages">Renseigne ton profil</Link> et cette journée se comparera à un
          objectif — il te restera un chiffre au lieu d’un total.
        </p>
      </div>
    )
  }

  const mien = perEater(dayTotal.kcal, eaters)
  const avance = progressToward(mien, kcalTarget)
  const part = Math.min(avance.ratio, 1)

  return (
    <div className="card bilan">
      <div className="bilan__anneau">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle className="bilan__piste" cx="60" cy="60" r={RAYON} fill="none" strokeWidth="13" />
          <circle
            className={`bilan__arc${avance.over ? ' bilan__arc--depasse' : ''}`}
            cx="60"
            cy="60"
            r={RAYON}
            fill="none"
            strokeWidth="13"
            strokeLinecap="round"
            strokeDasharray={`${part * CIRCONFERENCE} ${CIRCONFERENCE}`}
            // Depart a 12 h plutot qu'a 3 h, comme partout ailleurs.
            transform="rotate(-90 60 60)"
          />
        </svg>
        <div className="bilan__coeur">
          <span className="bilan__reste chiffre">
            {avance.over ? `+${arrondi(avance.gap)}` : arrondi(avance.gap)}
          </span>
          <span className="bilan__unite">
            {avance.over ? 'kcal au-dessus' : 'kcal restantes'}
          </span>
        </div>
      </div>

      <ul className="bilan__macros">
        {MACROS.map(({ cle, label }) => {
          const consomme = perEater(dayTotal[cle], eaters)
          const cible = targets?.[cle].grams ?? null
          const remplissage = cible === null || cible <= 0 ? 0 : Math.min(consomme / cible, 1)
          return (
            <li key={cle} className="bilan__macro">
              <span className="bilan__macro-haut">
                <span className={`bilan__macro-nom bilan__macro-nom--${cle}`}>{label}</span>
                <span className="bilan__macro-valeur">
                  {consomme.toFixed(0)}
                  {cible !== null && ` / ${cible} g`}
                </span>
              </span>
              <span className="bilan__piste-macro">
                <span
                  className={`bilan__jauge bilan__jauge--${cle}`}
                  style={{ width: `${remplissage * 100}%` }}
                />
              </span>
            </li>
          )
        })}
      </ul>

      {!hasEntries && (
        <p className="bilan__note">
          Rien de prévu aujourd’hui. Objectif : {arrondi(kcalTarget)} kcal.
        </p>
      )}

      {eaters > 1 && (
        <p className="bilan__note">
          Part pour une personne : le total du jour a été divisé par {eaters} mangeurs.{' '}
          <Link to="/objectifs/reglages">Régler</Link>
        </p>
      )}
    </div>
  )
}
