/**
 * Le bloc Objectif : la direction, l'intensite, le poids vise, l'allure.
 *
 * TROIS TUILES EN FACADE, SIX OBJECTIFS DERRIERE. Le mockup demande de choisir
 * entre Perdre, Maintenir et Prendre ; le modele connait six ecarts differents
 * (`ENERGY_GOALS`), et un profil deja enregistre peut porter n'importe lequel.
 * La tuile n'existe donc PAS en base : c'est une projection de `goal`,
 * recalculee a chaque rendu par `directionOf`. Deux sources de verite pour la
 * meme information finissent toujours par diverger.
 *
 * AUCUNE TUILE N'EST PRESELECTIONNEE quand `goal` est nul. En preselectionner
 * une ferait passer l'ecran de "il manque l'objectif" a une estimation
 * complete sans un seul geste, et le prochain enregistrement ecrirait en base
 * un objectif que personne n'a choisi.
 *
 * LA CONTRADICTION SE DIT, ELLE NE SE CORRIGE PAS TOUTE SEULE. Viser un poids
 * plus lourd avec la tuile "Perdre" est possible, et `estimateTargets` tranche
 * alors par l'ecart REEL : le calcul produit un surplus. Retourner la tuile en
 * silence reecrirait aussi la repartition qu'elle propose ; on l'annonce, et
 * on offre deux reparations d'un geste.
 */

import {
  ENERGY_GOALS,
  GOAL_DIRECTIONS,
  MIN_SAFE_KCAL,
  directionOf,
  goalForDirection,
  type DirectionCode,
  type GoalCode,
} from '@prandia/shared'

import { NumberField, RadioGroupField } from '../../components/Field.js'
import { Icon, type IconName } from '../../icons/index.js'
import { Allure } from './Allure.js'

/** L'image de chaque direction. Elle vit ici : `shared` ne connait pas le jeu d'icones. */
const ICONES: Record<DirectionCode, IconName> = {
  perdre: 'ui-chevron-down',
  maintenir: 'ui-scale',
  prendre: 'ui-chevron-up',
}

/** « 20 % sous ta dépense » plutot que « -0,2 ». C'est ce chiffre qui distingue
    les trois lignes de « Perdre » : sans lui, ce sont trois mots. */
const ecartEnMots = (adjust: number): string => {
  if (adjust === 0) return 'à la hauteur de ta dépense'
  const part = Math.abs(Math.round(adjust * 100))
  return adjust < 0 ? `${part} % sous ta dépense` : `${part} % au-dessus de ta dépense`
}

export function Objectif({
  goal,
  targetWeightKg,
  weightKg,
  paceKgPerWeek,
  onPatch,
}: {
  readonly goal: GoalCode | null
  readonly targetWeightKg: number | null
  readonly weightKg: number | null
  readonly paceKgPerWeek: number | null
  readonly onPatch: (changes: {
    goal?: GoalCode | null
    targetWeightKg?: number | null
    paceKgPerWeek?: number | null
  }) => void
}) {
  const direction = directionOf(goal)
  const entree = GOAL_DIRECTIONS.find((d) => d.code === direction) ?? null

  /*
   * La direction DECLAREE par la tuile, et celle que le poids vise impose
   * REELLEMENT. `estimateTargets` retient la seconde : c'est le poids vise qui
   * est explicite, pas le libelle de l'objectif.
   */
  const effective: DirectionCode | null =
    targetWeightKg !== null && weightKg !== null
      ? targetWeightKg > weightKg
        ? 'prendre'
        : targetWeightKg < weightKg
          ? 'perdre'
          : 'maintenir'
      : direction

  const contredit = direction !== null && effective !== null && effective !== direction
  const allureCommande =
    targetWeightKg !== null && paceKgPerWeek !== null && targetWeightKg !== weightKg

  return (
    <div className="card">
      <h2 className="card__title">Mon objectif</h2>

      <div className="directions" role="group" aria-label="Direction">
        {GOAL_DIRECTIONS.map((d) => (
          <button
            key={d.code}
            type="button"
            className={`direction${direction === d.code ? ' direction--on' : ''}`}
            aria-pressed={direction === d.code}
            onClick={() => onPatch({ goal: goalForDirection(d.code, goal) })}
          >
            <Icon name={ICONES[d.code]} size={22} className="direction__icone" />
            {d.label}
          </button>
        ))}
      </div>

      {entree === null ? (
        <p className="card__lead directions__invite">
          Choisis une direction pour régler l’intensité.
        </p>
      ) : entree.goals.length === 1 ? (
        /* On ne rend PAS un groupe radio d'une seule option : un controle qui
           ne peut pas etre actionne se lit comme casse, et un lecteur d'ecran
           annonce « 1 sur 1 ». */
        <p className="card__lead directions__invite">
          Un seul réglage : {ecartEnMots(ENERGY_GOALS.find((g) => g.code === entree.goals[0])?.adjust ?? 0)}.
        </p>
      ) : (
        <RadioGroupField
          legend="Intensité"
          value={goal}
          onChange={(v) => onPatch({ goal: v as GoalCode })}
          options={entree.goals.map((code) => {
            const g = ENERGY_GOALS.find((x) => x.code === code)
            const ecart = ecartEnMots(g?.adjust ?? 0)
            const part = `${Math.abs(Math.round((g?.adjust ?? 0) * 100))} %`
            return {
              value: code,
              label: g?.label ?? code,
              // Le libelle de `perte` porte deja son pourcentage : le repeter
              // donnait « Environ 15 % sous la depense estimee · 15 % sous ta
              // depense ».
              hint: g?.hint.includes(part) === true ? g.hint : `${g?.hint ?? ''} · ${ecart}`,
            }
          })}
        />
      )}

      <NumberField
        label="Poids visé"
        className="field--ligne"
        value={targetWeightKg}
        onChange={(v) => onPatch({ targetWeightKg: v })}
        min={20}
        max={400}
        suffix="kg"
        decimals={1}
        hint="Facultatif. Renseigné, il remplace le pourcentage de l’objectif par un écart calculé, et l’écran annonce une date d’arrivée."
      />

      {contredit && (
        <div className="contradiction">
          <p className="contradiction__constat">
            <Icon name="ui-alert" size={16} className="icon--inline" />{' '}
            {effective === 'prendre' ? (
              <>
                Ton poids visé est <strong>au-dessus</strong> de ton poids actuel, alors que la
                tuile dit « {entree?.label} ».{' '}
                {allureCommande
                  ? 'C’est le poids visé qui décide : la cible calculée est un surplus.'
                  : 'Le réglage ne va donc pas vers ce poids.'}
              </>
            ) : effective === 'perdre' ? (
              <>
                Ton poids visé est <strong>en dessous</strong> de ton poids actuel, alors que la
                tuile dit « {entree?.label} ».{' '}
                {allureCommande
                  ? 'C’est le poids visé qui décide : la cible calculée est un déficit.'
                  : 'Le réglage ne va donc pas vers ce poids.'}
              </>
            ) : (
              <>
                Ton poids visé est égal à ton poids actuel : il n’y a rien à parcourir, et
                l’objectif reprend la main.
              </>
            )}
          </p>
          <div className="contradiction__actions">
            {effective !== null && effective !== direction && (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => onPatch({ goal: goalForDirection(effective, goal) })}
              >
                Passer sur « {GOAL_DIRECTIONS.find((d) => d.code === effective)?.label} »
              </button>
            )}
            <button
              type="button"
              className="button button--ghost"
              onClick={() => onPatch({ targetWeightKg: null, paceKgPerWeek: null })}
            >
              Retirer le poids visé
            </button>
          </div>
        </div>
      )}

      {targetWeightKg !== null ? (
        <>
          <Allure
            value={paceKgPerWeek}
            onChange={(kg) => onPatch({ paceKgPerWeek: kg })}
            onClear={() => onPatch({ paceKgPerWeek: null })}
            perte={effective === 'perdre'}
          />
          {allureCommande && (
            <p className="field__hint">
              L’allure décide de l’écart. L’objectif ne propose plus qu’une répartition, et son
              pourcentage n’est plus appliqué. Le plancher de {MIN_SAFE_KCAL.f.toLocaleString('fr-FR')} ou{' '}
              {MIN_SAFE_KCAL.m.toLocaleString('fr-FR')} kcal, lui, reste.
            </p>
          )}
        </>
      ) : (
        <p className="field__hint">
          Sans poids visé, l’écart vient du pourcentage de l’objectif. Renseigne-en un pour choisir
          une allure et obtenir une date d’arrivée.
        </p>
      )}
    </div>
  )
}
