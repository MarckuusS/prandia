/**
 * Conversion des lignes D1 vers les modeles du domaine.
 *
 * D1 rend des objets plats en snake_case, avec les entiers SQLite pour les
 * booleens et nos montants en TEXT. Toute la traduction vers la forme camelCase
 * de l'API vit ici — nulle part ailleurs.
 */

import { isStorageSpace } from '@prandia/shared'
import type { Ingredient, MealPlanEntry, MealSlot, PantryStock, Recipe, Source, Tag } from '@prandia/shared'

/** Ligne brute de la table `ingredient`. */
export interface IngredientRow {
  id: number
  name: string
  name_normalized: string
  source: string
  source_ref: string | null
  brand: string | null
  kcal_per_100g: number | null
  proteins_g: number | null
  carbs_g: number | null
  sugars_g: number | null
  fats_g: number | null
  saturated_fats_g: number | null
  fiber_g: number | null
  salt_g: number | null
  price_eur: string | null
  price_quantity_g: number | null
  piece_weight_g: number | null
  cooked_weight_per_100g_raw: number | null
  in_personal_library: number
  category_l1: string | null
  category_l2: string | null
  season_months: string | null
  restock_threshold_g: number | null
  nutriscore_grade: string | null
  created_at: string
  updated_at: string
}

export function toIngredient(r: IngredientRow): Ingredient {
  return {
    id: r.id,
    name: r.name,
    source: r.source as Source,
    sourceRef: r.source_ref,
    brand: r.brand,
    kcal: r.kcal_per_100g,
    proteins: r.proteins_g,
    carbs: r.carbs_g,
    sugars: r.sugars_g,
    fats: r.fats_g,
    saturatedFats: r.saturated_fats_g,
    fiber: r.fiber_g,
    salt: r.salt_g,
    priceEur: r.price_eur,
    priceQuantityG: r.price_quantity_g,
    pieceWeightG: r.piece_weight_g,
    cookedWeightPer100gRaw: r.cooked_weight_per_100g_raw,
    // SQLite n'a pas de booleen : 0/1.
    inLibrary: r.in_personal_library === 1,
    categoryL1: r.category_l1,
    categoryL2: r.category_l2,
    seasonMonths: r.season_months,
    restockThresholdG: r.restock_threshold_g,
    nutriscoreGrade: (r.nutriscore_grade ?? null) as Ingredient['nutriscoreGrade'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface RecipeRow {
  id: number
  name: string
  instructions: string
  default_portions: number
  image_key: string | null
  source_url: string | null
  prep_time_min: number | null
  created_at: string
  updated_at: string
}

/** Recette sans ses lignes ni ses tags — ils sont attaches par le repository. */
export function toRecipeShell(r: RecipeRow): Recipe {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    defaultPortions: r.default_portions,
    imageKey: r.image_key,
    sourceUrl: r.source_url,
    prepTimeMin: r.prep_time_min,
    lines: [],
    tags: [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface TagRow {
  id: number
  name: string
  color_hex: string
  created_at: string
}

export const toTag = (r: TagRow): Tag => ({
  id: r.id,
  name: r.name,
  colorHex: r.color_hex,
  createdAt: r.created_at,
})

export interface MealPlanEntryRow {
  id: number
  iso_week: string
  day_of_week: number
  slot: string
  recipe_id: number | null
  ingredient_id: number | null
  quantity_g: number | null
  portions: number | null
  /** Unite d'affichage choisie a la saisie. Voir la migration 0011. */
  unit: string | null
  ordinal: number
}

export const toMealPlanEntry = (r: MealPlanEntryRow): MealPlanEntry => ({
  id: r.id,
  isoWeek: r.iso_week,
  dayOfWeek: r.day_of_week,
  slot: r.slot as MealSlot,
  recipeId: r.recipe_id,
  ingredientId: r.ingredient_id,
  quantityG: r.quantity_g,
  portions: r.portions,
  unit: r.unit,
  ordinal: r.ordinal,
})

export interface PantryStockRow {
  id: number
  ingredient_id: number
  quantity_g: number
  expiry_date: string | null
  storage: string | null
  storage_since: string | null
  unit: string | null
  notes: string | null
  added_at: string
  updated_at: string
}

export const toPantryStock = (r: PantryStockRow): PantryStock => ({
  id: r.id,
  ingredientId: r.ingredient_id,
  quantityG: r.quantity_g,
  expiryDate: r.expiry_date,
  // Le CHECK de la base garantit deja la valeur ; ce filtre protege le cas ou
  // une ligne serait ecrite hors des routes, et evite un cast aveugle.
  storage: isStorageSpace(r.storage) ? r.storage : null,
  storageSince: r.storage_since,
  unit: r.unit,
  notes: r.notes,
  addedAt: r.added_at,
  updatedAt: r.updated_at,
})
