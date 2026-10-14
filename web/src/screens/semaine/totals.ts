/**
 * Derives de la semaine : ce que designe une entree, ses apports, son cout.
 *
 * Aucun calcul n'est invente ici. Tout vient de @prandia/shared ; ce module se
 * contente de resoudre les references — l'API rend les recettes et les
 * ingredients a part, indexes par identifiant — puis d'appliquer les formules
 * a un jour ou a une semaine.
 *
 * Rien n'y connait React : l'ecran s'en sert dans des `useMemo`, et ces
 * fonctions restent testables sans harnais.
 */

import {
  COOKED_UNIT_CODE,
  MEAL_SLOTS,
  ZERO_NUTRITION,
  addNutrition,
  cookedGramsPerPortion,
  cookedWeightG,
  estUnPlat,
  PIECE_UNIT_CODE,
  formatGrams,
  mealEntryNutrition,
  mealPlanEntryCost,
  mealPlanEntryCostDetail,
  type Ingredient,
  type MealPlanEntry,
  type MealSlot,
  type NutritionTotal,
  type Recipe,
  massBreakdown,
} from '@prandia/shared'

import type { CalendarResponse } from '../../lib/queries.js'

/**
 * L'unite qui fait lire une entree RECETTE en grammes, meme code que `units.ts`.
 * La base n'y stocke que des portions : voir `PortionsOuGrammes`.
 */
export const UNITE_GRAMMES = 'g'

/**
 * Un montant, sans importer decimal.js.
 *
 * La bibliotheque est une dependance de @prandia/shared, pas du front : la
 * declarer ici pour un simple type creerait une dependance non declaree dans
 * web/package.json. Le type de retour de `mealPlanEntryCost` la nomme deja.
 */
export type Money = NonNullable<ReturnType<typeof mealPlanEntryCost>>

/**
 * Une entree telle qu'elle revient du serveur : son identifiant est acquis.
 *
 * Le schema partage autorise `id: null` parce qu'il sert aussi a la creation.
 * Cote ecran, une entree sans identifiant ne pourrait etre ni modifiee ni
 * supprimee : ce type evite d'avoir a le verifier a chaque bouton.
 */
export type SavedEntry = MealPlanEntry & { readonly id: number }

export const isSaved = (entry: MealPlanEntry): entry is SavedEntry => entry.id !== null

/** Ce que designe une entree, une fois resolu. `null` = reference orpheline. */
export type EntryTarget =
  | { readonly kind: 'recipe'; readonly recipe: Recipe }
  | { readonly kind: 'ingredient'; readonly ingredient: Ingredient }
  | null

export function targetOf(entry: MealPlanEntry, data: CalendarResponse): EntryTarget {
  if (entry.recipeId !== null) {
    const recipe = data.recipes[String(entry.recipeId)]
    return recipe ? { kind: 'recipe', recipe } : null
  }
  if (entry.ingredientId !== null) {
    const ingredient = data.ingredients[String(entry.ingredientId)]
    return ingredient ? { kind: 'ingredient', ingredient } : null
  }
  return null
}

/** Nom affiche. Une recette supprimee laisse une entree qu'il faut nommer quand meme. */
export function entryName(entry: MealPlanEntry, data: CalendarResponse): string {
  const target = targetOf(entry, data)
  if (target === null) return 'Entrée orpheline'
  return target.kind === 'recipe' ? target.recipe.name : target.ingredient.name
}

/**
 * Ce qu'il y a DANS le repas, en une ligne : « Riz complet, brocoli, poulet ».
 *
 * Une recette ne dit que son nom, et « Curry de lentilles » ne repond pas a la
 * question qu'on se pose en parcourant sa semaine — ce que je vais manger. La
 * composition la repond, et elle ne coute rien : chaque ligne de recette porte
 * son ingredient COMPLET, pas une reference a resoudre.
 *
 * Rend `null` pour un ingredient seul : son nom EST sa composition, la repeter
 * ferait une ligne pour rien. Et `null` aussi pour une recette sans lignes,
 * plutot qu'une chaine vide qui reserverait sa hauteur.
 *
 * Trois noms au plus, puis « … » : au-dela, la ligne se coupe et l'on perd
 * l'information au lieu de la donner.
 */
export function entryComposition(entry: MealPlanEntry, data: CalendarResponse): string | null {
  if (entry.recipeId === null) return null
  const recipe = data.recipes[String(entry.recipeId)]
  if (recipe === undefined || recipe.lines.length === 0) return null

  const noms = recipe.lines.map((line) => line.ingredient.name).filter((nom) => nom !== '')
  if (noms.length === 0) return null

  const tete = noms.slice(0, 3).join(', ')
  return noms.length > 3 ? `${tete}…` : tete
}

/**
 * Quantite lisible. La regle XOR se voit ici : des PORTIONS pour une recette,
 * des GRAMMES pour un ingredient, jamais les deux en base.
 *
 * Une recette servie EN GRAMMES (unite `g`, voir `PortionsOuGrammes`) se relit
 * en grammes : ses portions sont converties par le poids cuit d'une portion.
 */
export function entryAmountLabel(entry: MealPlanEntry, data?: CalendarResponse): string {
  if (entry.recipeId !== null) {
    const recipe = data?.recipes[String(entry.recipeId)]
    const parPortion = entry.unit === UNITE_GRAMMES && recipe ? cookedGramsPerPortion(recipe) : null
    if (parPortion !== null) return formatGrams(Math.round((entry.portions ?? 1) * parPortion))
    const portions = entry.portions ?? 1
    const value = portions.toLocaleString('fr-FR', { maximumFractionDigits: 2 })
    return `${value} portion${portions > 1 ? 's' : ''}`
  }
  // Un ingredient saisi EN CUIT se relit en cuit : la base ne garde que le cru.
  const ingredient = entry.ingredientId === null ? undefined : data?.ingredients[String(entry.ingredientId)]
  if (entry.unit === COOKED_UNIT_CODE && ingredient?.cookedWeightPer100gRaw) {
    return `${formatGrams(cookedWeightG(ingredient, entry.quantityG ?? 0))} cuits`
  }
  // Une part d'un plat cuisine se relit en parts : "1 part (350 g)".
  if (entry.unit === PIECE_UNIT_CODE && ingredient !== undefined && estUnPlat(ingredient) && ingredient.pieceWeightG) {
    const grammes = entry.quantityG ?? 0
    const parts = grammes / ingredient.pieceWeightG
    const valeur = parts.toLocaleString('fr-FR', { maximumFractionDigits: 2 })
    return `${valeur} part${parts > 1 ? 's' : ''} (${formatGrams(Math.round(grammes))})`
  }
  return formatGrams(entry.quantityG ?? 0)
}

// ---------------------------------------------------------------------------
// Nutrition
// ---------------------------------------------------------------------------

/** La formule vit dans @prandia/shared : le bilan du dimanche la lit aussi. */
export function entryNutrition(entry: MealPlanEntry, data: CalendarResponse): NutritionTotal {
  return mealEntryNutrition(entry, targetOf(entry, data))
}

export function sumNutrition(
  entries: readonly MealPlanEntry[],
  data: CalendarResponse,
): NutritionTotal {
  return entries.reduce(
    (total, entry) => addNutrition(total, entryNutrition(entry, data)),
    ZERO_NUTRITION,
  )
}

// ---------------------------------------------------------------------------
// Cout
// ---------------------------------------------------------------------------

export interface CostTotal {
  /** `null` quand aucune ligne n'a de prix : « — » plutot que « 0,00 € ». */
  readonly total: Money | null
  /**
   * Lignes d'ingredient sans prix, sur toutes les entrees.
   *
   * Compter les ENTREES au lieu des lignes rendait l'avertissement muet dans
   * le cas le plus courant : une recette dont deux ingredients sur cinq n'ont
   * pas de prix produit un cout non nul, donc l'entree passait pour complete,
   * et la carte annonçait un budget sous-estime sans le moindre signe.
   */
  readonly missingLines: number
  /** Entrees dont la recette ou l'ingredient a disparu : rien n'est chiffrable. */
  readonly orphanCount: number
}

/**
 * Cout d'un ensemble d'entrees.
 *
 * Divergence assumee avec le desktop : celui-ci ignorait purement et
 * simplement une recette introuvable, si bien qu'un total pouvait etre faux
 * sans que rien ne le signale. Ici une reference orpheline est comptee a part :
 * le total reste partiel, mais l'interface peut le dire.
 */
export function entriesCost(entries: readonly MealPlanEntry[], data: CalendarResponse): CostTotal {
  let total: Money | null = null
  let missingLines = 0
  let orphanCount = 0

  for (const entry of entries) {
    const target = targetOf(entry, data)
    if (target === null) {
      orphanCount += 1
      continue
    }
    const { cost, missingLines: missing } = mealPlanEntryCostDetail(entry, target)
    missingLines += missing
    if (cost !== null) total = total === null ? cost : total.plus(cost)
  }

  return { total, missingLines, orphanCount }
}

// ---------------------------------------------------------------------------
// Regroupements
// ---------------------------------------------------------------------------

export const entriesOfDay = (data: CalendarResponse, dayOfWeek: number): SavedEntry[] =>
  data.entries.filter(isSaved).filter((entry) => entry.dayOfWeek === dayOfWeek)

export const entriesOfSlot = (entries: readonly SavedEntry[], slot: MealSlot): SavedEntry[] =>
  entries.filter((entry) => entry.slot === slot)

/**
 * Valeur d'un `<select>` de creneau ramenee au type du domaine.
 *
 * Le repli sur « midi » ne peut se produire que si quelqu'un bricole le DOM :
 * les options sont construites a partir de MEAL_SLOTS.
 */
export const toMealSlot = (value: string): MealSlot =>
  MEAL_SLOTS.find((slot) => slot === value) ?? 'noon'


// ---------------------------------------------------------------------------
// Le tableau reglementaire
// ---------------------------------------------------------------------------

/**
 * Les huit lignes de l'etiquetage, dans l'ordre du reglement UE 1169/2011.
 *
 * Vit ici plutot que dans l'ecran Semaine depuis que la feuille d'un repas
 * affiche le meme tableau : deux listes a tenir d'accord auraient diverge au
 * premier ajout.
 */
export interface NutrientRow {
  readonly key: keyof NutritionTotal
  readonly label: string
  readonly unit: string
  readonly decimals: number
  /** Ligne « dont … », en retrait et en gris comme sur l'etiquetage. */
  readonly sub?: boolean | undefined
}

/** Ordre du reglement UE 1169/2011, celui de l'etiquetage alimentaire. */
export const NUTRIENT_ROWS: readonly NutrientRow[] = [
  { key: 'kcal', label: 'Énergie', unit: 'kcal', decimals: 0 },
  { key: 'fats', label: 'Lipides', unit: 'g', decimals: 1 },
  { key: 'saturatedFats', label: 'dont acides gras saturés', unit: 'g', decimals: 1, sub: true },
  { key: 'carbs', label: 'Glucides', unit: 'g', decimals: 1 },
  { key: 'sugars', label: 'dont sucres', unit: 'g', decimals: 1, sub: true },
  { key: 'fiber', label: 'Fibres', unit: 'g', decimals: 1 },
  { key: 'proteins', label: 'Protéines', unit: 'g', decimals: 1 },
  { key: 'salt', label: 'Sel', unit: 'g', decimals: 2 },
]

/**
 * Une valeur nutritionnelle.
 *
 * « — » quand il n'y a rien a totaliser : afficher « 0 kcal » pour une journee
 * vide laisserait croire a une donnee mesuree. Une macro inconnue, elle,
 * compte pour 0 dans l'agregat — regle du domaine, reprise du desktop.
 */
/**
 * Part d'un nutriment EN MASSE, telle que l'anneau la dessine.
 *
 * C'est la colonne "Part" du tableau, et elle lit exactement la meme base que
 * les arcs. La figure est juste au-dessus : deux bases differentes feraient
 * annoncer deux nombres pour la meme chose a quelques centimetres d'ecart.
 * Elle etait energetique jusqu'ici ; le changement de base a ete demande, et
 * il devait porter sur les deux ou sur aucun.
 *
 * CE N'EST PAS UNE PART DE L'ASSIETTE. Le denominateur est la masse des quatre
 * familles, pas le poids de l'aliment : l'eau n'y est pas. "60 % de glucides"
 * veut dire soixante pour cent des macros. Voir `massBreakdown`.
 *
 * Rend `null` pour les lignes qui n'en ont pas : l'energie EST le total, le sel
 * n'apporte aucune des quatre familles, et les sous-lignes (sucres, acides gras
 * satures) sont deja comptees dans leur famille. Leur donner une part ferait un
 * tableau dont la colonne ne totalise pas 100.
 *
 * MEME SEUIL QUE L'ANNEAU, et c'est le point : sous 0,5 % la part s'ecrit
 * "0 %" et l'anneau ne la dessine pas. Sans ce seuil commun, le tableau
 * annoncerait "0 %" a cote d'un arc bien visible, ce qui etait exactement le
 * defaut constate sur un sirop d'agave a 0,02 g de proteines.
 */
export function massShare(total: NutritionTotal, key: keyof NutritionTotal): string | null {
  const parts = { fats: 'fatsG', carbs: 'carbsG', fiber: 'fiberG', proteins: 'proteinsG' } as const
  if (!(key in parts)) return null

  const masse = massBreakdown(total)
  if (masse.macroMassG <= 0) return null

  const share = masse[parts[key as keyof typeof parts]] / masse.macroMassG
  return share < 0.005 ? '0 %' : `${Math.round(share * 100)} %`
}

export function formatNutrient(entryCount: number, value: number, row: NutrientRow): string {
  if (entryCount === 0) return '—'

  /*
   * UNE MASSE NON NULLE NE S'ECRIT PAS "0,0 g".
   *
   * Un sirop d'agave apporte 0,0114 g de lipides sur une portion de 5,7 g.
   * Arrondi a la decimale, cela donnait "0,0 g" a cote d'une part d'energie de
   * 1 %, et les deux se contredisaient a l'oeil. Pourtant les deux etaient
   * justes : les lipides pesent 9 kcal/g contre 4 pour les glucides, donc une
   * masse trop petite pour s'afficher porte quand meme une part visible.
   *
   * C'etait donc le TABLEAU qui mentait, pas le calcul. "< 0,1 g" dit ce
   * qu'il en est, et la part cesse d'etonner. Un vrai zero, lui, reste "0,0 g".
   */
  const plancher = 10 ** -row.decimals
  if (value > 0 && value < plancher) {
    const seuil = plancher.toLocaleString('fr-FR', {
      minimumFractionDigits: row.decimals,
      maximumFractionDigits: row.decimals,
    })
    return `< ${seuil} ${row.unit}`
  }

  const formatted = value.toLocaleString('fr-FR', {
    minimumFractionDigits: row.decimals,
    maximumFractionDigits: row.decimals,
  })
  return `${formatted} ${row.unit}`
}
