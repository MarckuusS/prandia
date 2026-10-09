/**
 * Le tampon d'edition de l'ecran de reglage.
 *
 * Il vit a part pour que les cartes conservees et les blocs neufs le
 * partagent sans que l'un importe l'autre.
 */

import type { ActivityCode, GoalCode, SplitCode } from '@prandia/shared'

export interface Draft {
  sex: 'f' | 'm' | null
  birthYear: number | null
  heightCm: number | null
  weightKg: number | null
  waistCm: number | null
  activity: ActivityCode | null
  goal: GoalCode | null
  split: SplitCode | null
  splitProteins: number | null
  splitCarbs: number | null
  splitFats: number | null
  targetWeightKg: number | null
  paceKgPerWeek: number | null
  kcalTarget: number | null
  eaters: number
}

export const EMPTY: Draft = {
  sex: null, birthYear: null, heightCm: null, weightKg: null, waistCm: null,
  activity: null, goal: null,
  split: null, splitProteins: null, splitCarbs: null, splitFats: null,
  targetWeightKg: null, paceKgPerWeek: null,
  kcalTarget: null, eaters: 1,
}
