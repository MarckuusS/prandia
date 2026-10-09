/**
 * La cible du jour, telle que l'ecran doit la lire.
 *
 * Ce calcul vivait dans `GoalCard`. Des que l'Accueil a du afficher le meme
 * anneau, le recopier aurait cree deux versions d'une meme regle — et la regle
 * n'est pas triviale : elle traduit des chaines libres venues du serveur en
 * codes, recompose la repartition personnalisee, et fait passer `kcalTarget`
 * saisi a la main AVANT la cible calculee. Une divergence entre les deux
 * ecrans se serait vue comme deux objectifs differents pour la meme journee.
 *
 * LA CIBLE N'EST NI STOCKEE NI TRANSMISE : elle se recalcule du profil, ici
 * comme cote Worker, par la meme fonction. C'est la regle du projet, et elle
 * tient a ceci qu'un chiffre ecrit en base resterait juste jusqu'au premier
 * changement de poids.
 */

import { useMemo } from 'react'
import {
  estimateTargets,
  hydrationTarget,
  type ActivityCode,
  type GoalCode,
  type SplitCode,
  type Targets,
} from '@prandia/shared'

import { useProfile } from './queries.js'

export interface DailyTargets {
  /**
   * `chargement` tant que le profil n'a pas repondu (ou a echoue) : dans les
   * deux cas l'appelant ne doit rien afficher plutot qu'un objectif faux.
   * `absent` = profil incomplet, il n'y a pas d'objectif a montrer mais il y a
   * quelque chose a proposer. `pret` = on a un chiffre.
   */
  readonly etat: 'chargement' | 'absent' | 'pret'
  /** Cible energetique retenue : celle saisie a la main l'emporte. */
  readonly kcalTarget: number | null
  /** Detail complet, `null` si le profil ne permet pas de le calculer. */
  readonly targets: Targets | null
  /** Nombre de mangeurs du foyer, par lequel diviser un total de journee. */
  readonly eaters: number
  /** Cible d'hydratation du jour, en millilitres, et d'ou elle vient. */
  readonly hydration: { readonly ml: number; readonly estimated: boolean }
  /** Les mesures brutes, pour les ecrans qui lisent le corps et non l'assiette. */
  readonly mesures: {
    readonly weightKg: number | null
    readonly targetWeightKg: number | null
    readonly heightCm: number | null
    readonly waistCm: number | null
  }
}

export function useDailyTargets(): DailyTargets {
  const query = useProfile()

  return useMemo<DailyTargets>(() => {
    if (query.isPending || query.isError || query.data === undefined) {
      return {
        etat: 'chargement',
        kcalTarget: null,
        targets: null,
        eaters: 1,
        hydration: hydrationTarget(null),
        mesures: { weightKg: null, targetWeightKg: null, heightCm: null, waistCm: null },
      }
    }

    const { profile, eaters } = query.data
    const targets = estimateTargets({
      sex: profile.sex,
      birthYear: profile.birthYear,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      // Le serveur rend des chaines libres : un code retire des listes ne doit
      // pas faire tomber l'ecran. `estimateTargets` rend `null` s'il ne le
      // reconnait pas, ce qui est exactement le comportement voulu ici.
      activity: profile.activity as ActivityCode | null,
      goal: profile.goal as GoalCode | null,
      // La repartition et le poids vise comptent AUSSI : sans eux, on
      // comparerait la journee aux macros par defaut de l'objectif, pas a
      // celles que la personne a reglees.
      split: profile.split as SplitCode | null,
      customSplit:
        profile.splitProteins === null
          ? null
          : {
              proteins: profile.splitProteins,
              carbs: profile.splitCarbs ?? 0,
              fats: profile.splitFats ?? 0,
            },
      targetWeightKg: profile.targetWeightKg,
      paceKgPerWeek: profile.paceKgPerWeek,
    })

    const kcalTarget = profile.kcalTarget ?? targets?.kcal ?? null
    return {
      etat: kcalTarget === null ? 'absent' : 'pret',
      kcalTarget,
      targets,
      eaters,
      hydration: hydrationTarget(profile.weightKg),
      mesures: {
        weightKg: profile.weightKg,
        targetWeightKg: profile.targetWeightKg,
        heightCm: profile.heightCm,
        waistCm: profile.waistCm ?? null,
      },
    }
  }, [query.isPending, query.isError, query.data])
}
