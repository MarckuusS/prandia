/**
 * Modeles du domaine — la forme metier fait foi ici.
 *
 * Portage de app/domain/models.py (Pydantic v2) vers Zod. Les messages de
 * validation sont repris MOT POUR MOT : ils sont destines a l'utilisateur et
 * remontent tels quels dans l'interface.
 *
 * Deux conventions de serialisation, tenues sur toute la surface d'API :
 *   - les identifiants sont en camelCase (le SQL reste en snake_case) ;
 *   - les montants sont des CHAINES decimales ("12.0000"), jamais des nombres.
 *     Un float ne represente pas exactement 0,1 € et l'erreur s'accumule sur
 *     une liste de courses. Les calculs passent par decimal.js (voir pricing.ts).
 *
 * Absence = `null`, jamais `""` ni `undefined`. Le desktop melangeait les deux
 * selon le chemin de code (annexe #19 de la spec).
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Chaine decimale positive, ex. "3.9900". Le separateur est le POINT. */
const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Montant invalide : attendu une chaîne décimale comme "3.99".')

const positiveDecimalString = decimalString.refine(
  (v) => Number(v) > 0,
  'Le prix doit être strictement positif.',
)

/** Horodatage systeme, ISO-8601 UTC suffixe Z. */
const utcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)

/** Date-jour sans heure, 'YYYY-MM-DD'. Utilisee pour les peremptions. */
const dayDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.')

/** Macro pour 100 g : `null` signifie « inconnu », ce qui differe de 0. */
const macro = z
  .number()
  .min(0, 'Les macros par 100 g ne peuvent pas être négatives.')
  .nullable()
  .default(null)

const nonEmpty = (message: string) => z.string().trim().min(1, message)

// ---------------------------------------------------------------------------
// Enumerations — la valeur EST ce qui est stocke en base
// ---------------------------------------------------------------------------

export const SOURCES = ['ciqual', 'openfoodfacts', 'manual', 'lidl'] as const
export const sourceSchema = z.enum(SOURCES)
export type Source = z.infer<typeof sourceSchema>

/**
 * Creneaux d'une journee. L'ordre de ce tableau est l'ordre CHRONOLOGIQUE
 * d'affichage : un tri SQL les rendrait par ordre alphabetique, ce que le
 * desktop corrigeait cote client.
 */
export const MEAL_SLOTS = ['morning', 'snack_morning', 'noon', 'snack_afternoon', 'evening'] as const
export const mealSlotSchema = z.enum(MEAL_SLOTS)
export type MealSlot = z.infer<typeof mealSlotSchema>

export const MEAL_SLOT_LABELS: Record<MealSlot, string> = {
  morning: 'Matin',
  snack_morning: 'Collation 10h',
  noon: 'Midi',
  snack_afternoon: 'Goûter 16h',
  evening: 'Soir',
}

/** 0 = lundi, conformement a la convention ISO retenue pour le calendrier. */
export const DAY_LABELS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'] as const

// ---------------------------------------------------------------------------
// Ingredient
// ---------------------------------------------------------------------------

export const ingredientSchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  name: nonEmpty("Le nom de l'ingrédient ne peut pas être vide."),
  source: sourceSchema.default('manual'),
  /** Code CIQUAL, code-barres EAN, ou art_id Lidl selon la source. */
  sourceRef: z.string().nullable().default(null),
  brand: z.string().nullable().default(null),

  // Macros pour 100 g.
  kcal: macro,
  proteins: macro,
  carbs: macro,
  sugars: macro,
  fats: macro,
  saturatedFats: macro,
  fiber: macro,
  salt: macro,

  // Prix : cache denormalise de la derniere observation de l'historique.
  // L'utilisateur ne le saisit pas directement, il enregistre des observations.
  priceEur: positiveDecimalString.nullable().default(null),
  priceQuantityG: z.number().positive('Une quantité (g) doit être strictement positive.').nullable().default(null),

  /** Masse d'une « piece » : 1 oeuf ~60 g, 1 oignon ~150 g. `null` = pas de piece naturelle. */
  pieceWeightG: z.number().positive('Une quantité (g) doit être strictement positive.').nullable().default(null),
  /** Masse cuite pour 100 g cru (riz ~300). `null` = on assume 1:1. Les macros restent en cru. */
  cookedWeightPer100gRaw: z.number().positive('Une quantité (g) doit être strictement positive.').nullable().default(null),

  /** Distingue la bibliotheque de travail de l'utilisateur du catalogue CIQUAL/OFF. */
  inLibrary: z.boolean().default(false),

  categoryL1: z.string().nullable().default(null),
  /**
   * Sous ce stock, le produit part en reappro. Sur l'INGREDIENT et non sur le
   * lot : un seuil appartient au produit, pas a un pot ouvert mardi. `null` =
   * produit non suivi, ce qui est le cas de presque toute la bibliotheque.
   */
  restockThresholdG: z.number().positive().nullable().default(null),
  /**
   * Structurellement vide pour CIQUAL et les fiches manuelles, qui n'ont pas de
   * code-barres : ce n'est pas une donnee a completer un jour, c'est une
   * promesse que la source ne tiendra pas pour ces fiches. Le comparateur le
   * DIT plutot que d'afficher une case grise, qui se lirait comme un E.
   */
  nutriscoreGrade: z.enum(['a', 'b', 'c', 'd', 'e']).nullable().default(null),
  categoryL2: z.string().nullable().default(null),

  /** CSV de mois 1..12 ("6,7,8,9" = juin a septembre). `null` = pas de donnee. */
  seasonMonths: z
    .string()
    .regex(/^(1[0-2]|[1-9])(,(1[0-2]|[1-9]))*$/, 'Mois de saison attendus sous forme "6,7,8,9".')
    .nullable()
    .default(null),

  createdAt: utcTimestamp.nullable().default(null),
  updatedAt: utcTimestamp.nullable().default(null),
})

export type Ingredient = z.infer<typeof ingredientSchema>

/** Charge utile de creation : pas d'id ni d'horodatages. */
export const ingredientCreateSchema = ingredientSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})

/**
 * Charge utile de mise a jour, semantique « cle presente ».
 *
 * Attention, comportement repris du desktop : un champ ABSENT preserve la
 * valeur existante, tandis qu'un champ present a `null` l'efface. C'est ce qui
 * permet au formulaire de n'envoyer que ce qui a change.
 */
export const ingredientPatchSchema = ingredientCreateSchema.partial()

// ---------------------------------------------------------------------------
// Profil alimentaire et sportif
// ---------------------------------------------------------------------------

/**
 * Ce qu'une personne peut enregistrer sur elle-meme.
 *
 * TOUT est nullable, et c'est le point : un profil se remplit par etapes, et un
 * ecran qui refuserait d'enregistrer tant que les six champs ne sont pas la
 * obligerait a tout saisir d'un coup pour ne rien perdre. Les cibles ne sont
 * calculees que lorsque le necessaire est reuni (voir `estimateTargets`).
 *
 * Les bornes reprennent celles de la migration 0008. Les repeter ici n'est pas
 * une duplication inutile : elles rendent un message lisible au lieu d'un
 * « CHECK constraint failed » remonte de SQLite.
 */
export const profileWriteSchema = z.object({
  sex: z.enum(['f', 'm']).nullable().default(null),
  birthYear: z.number().int().min(1900).max(2100).nullable().default(null),
  heightCm: z.number().int().min(80).max(250).nullable().default(null),
  weightKg: z.number().min(20).max(400).nullable().default(null),
  activity: z
    .enum(['sedentaire', 'leger', 'actif', 'sportif', 'athlete'])
    .nullable()
    .default(null),
  goal: z
    .enum(['seche', 'perte', 'perte_douce', 'maintien', 'prise_seche', 'prise'])
    .nullable()
    .default(null),
  /** Repartition des macros. `null` = celle que propose l'objectif. */
  split: z
    .enum([
      'equilibre',
      'proteine',
      'seche',
      'faible_glucides',
      'endurance',
      'mediterraneen',
      'perso',
    ])
    .nullable()
    .default(null),
  /**
   * Pourcentages ecrits a la main, lus seulement si `split === 'perso'`.
   *
   * Le total n'est PAS impose a 100 ici : `normalizeSplit` le ramene a 100 au
   * moment du calcul, des deux cotes du reseau. Refuser un enregistrement a 99
   * empecherait de sauvegarder une saisie en cours, alors que le resultat
   * s'affiche deja juste.
   */
  splitProteins: z.number().int().min(0).max(100).nullable().default(null),
  splitCarbs: z.number().int().min(0).max(100).nullable().default(null),
  splitFats: z.number().int().min(0).max(100).nullable().default(null),
  /** Poids vise. Avec l'allure, il remplace le pourcentage de l'objectif. */
  targetWeightKg: z.number().min(20).max(400).nullable().default(null),
  /** Allure visee, en kg par semaine. Bornee comme le curseur de l'ecran. */
  paceKgPerWeek: z.number().min(0.1).max(1).nullable().default(null),
  /** Cible saisie a la main. Renseignee, elle l'emporte sur l'estimation. */
  kcalTarget: z
    .number()
    .int()
    .min(800, 'Une cible sous 800 kcal relève d’un suivi médical.')
    .max(8000)
    .nullable()
    .default(null),
  /** Tour de taille en cm. La derniere valeur connue, pas un historique. */
  waistCm: z.number().min(30).max(250).nullable().default(null),
  /**
   * Nombre de personnes qui mangent ce qui est planifie. Propriete du FOYER et
   * non de la personne : c'est par lui qu'on divise le total d'une journee.
   */
  eaters: z.number().int().min(1).max(20).default(1),
})
export type ProfileWrite = z.infer<typeof profileWriteSchema>

// ---------------------------------------------------------------------------
// Rayon
// ---------------------------------------------------------------------------

/**
 * Un rayon de magasin, tel que l'utilisateur le gere.
 *
 * `icon` et `colorHex` sont NULLABLES, et c'est le coeur du dispositif : NULL
 * veut dire « deduis-le du nom ». Un rayon jamais ouvert dans le gestionnaire
 * garde donc l'aspect que lui donne `iconForRayon`, et personne n'a a
 * renseigner dix lignes avant que l'ecran soit joli.
 *
 * `icon` n'est pas contraint a la liste des icones existantes ici : `shared/`
 * ne connait pas `web/src/icons/`, et l'inverse serait une dependance de la
 * couche partagee vers le front. Le controle a lieu a l'affichage, ou un nom
 * inconnu retombe simplement sur l'icone deduite.
 */
export const rayonSchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  name: nonEmpty('Le nom du rayon ne peut pas être vide.'),
  icon: z.string().min(1).nullable().default(null),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Couleur attendue au format #RRGGBB.')
    .nullable()
    .default(null),
  /** Rang d'affichage. Deux rayons de meme rang sont departages par leur nom. */
  ordinal: z.number().int().min(0).default(0),
})
export type Rayon = z.infer<typeof rayonSchema>

export const rayonWriteSchema = rayonSchema.omit({ id: true })
export type RayonWrite = z.infer<typeof rayonWriteSchema>

// ---------------------------------------------------------------------------
// Recette
// ---------------------------------------------------------------------------

export const tagSchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  name: nonEmpty('Le nom du tag ne peut pas être vide.'),
  colorHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'Couleur attendue au format #RRGGBB.')
    .default('#9ca3af'),
  createdAt: utcTimestamp.nullable().default(null),
})
export type Tag = z.infer<typeof tagSchema>

export const recipeLineSchema = z.object({
  ingredient: ingredientSchema,
  quantityG: z.number().positive('La quantité doit être strictement positive.'),
  /** Unite d'affichage choisie par l'utilisateur. Cosmetique : la quantite est en grammes. */
  unit: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  ordinal: z.number().int().min(0).default(0),
})
export type RecipeLine = z.infer<typeof recipeLineSchema>

export const recipeSchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  name: nonEmpty('Le nom de la recette ne peut pas être vide.'),
  instructions: z.string().default(''),
  defaultPortions: z.number().int().min(1, 'Une recette fait au moins une portion.').default(1),
  /** Cle d'objet R2, ex. 'recipes/12.jpg'. */
  imageKey: z.string().nullable().default(null),
  /** Conserves depuis l'import par URL — le desktop les extrayait puis les perdait. */
  sourceUrl: z.string().url().nullable().default(null),
  prepTimeMin: z.number().int().positive().nullable().default(null),
  lines: z.array(recipeLineSchema).default([]),
  tags: z.array(tagSchema).default([]),
  createdAt: utcTimestamp.nullable().default(null),
  updatedAt: utcTimestamp.nullable().default(null),
})
export type Recipe = z.infer<typeof recipeSchema>

/**
 * Charge utile d'enregistrement d'une recette.
 *
 * Distincte de `recipeSchema` : le formulaire envoie des IDENTIFIANTS
 * d'ingredients et de tags, pas les objets complets. Renvoyer l'ingredient
 * entier ferait transiter 4 000 caracteres de macros a chaque sauvegarde, et
 * surtout laisserait croire qu'on peut modifier un ingredient en modifiant une
 * recette.
 */
export const recipeLineWriteSchema = z.object({
  ingredientId: z.number().int().positive(),
  quantityG: z.number().positive('La quantité doit être strictement positive.'),
  unit: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
})
export type RecipeLineWrite = z.infer<typeof recipeLineWriteSchema>

export const recipeWriteSchema = z.object({
  name: nonEmpty('Le nom de la recette ne peut pas être vide.'),
  instructions: z.string().default(''),
  defaultPortions: z.number().int().min(1, 'Une recette fait au moins une portion.').default(1),
  /*
   * PAS DE `imageKey` ICI, et c'est une decision de securite autant que de
   * fiabilite. Il y figurait, en champ libre ecrit sans condition, ce qui
   * ouvrait ceci : un PUT sur MA recette avec la cle d'une recette d'un AUTRE
   * foyer, puis un GET de l'image. La route de lecture verifie l'appartenance
   * de la recette, et elle l'a. Verifier l'appartenance de la RECETTE
   * n'implique pas verifier l'appartenance de la CLE.
   *
   * Deux autres raisons convergent. L'editeur ne resynchronise jamais son
   * tampon depuis la prop : un editeur ouvert le matin sur le bureau EFFACERAIT
   * la photo posee a midi depuis le telephone, ce qui n'est pas un cas tordu
   * mais le geste normal. Et iOS recharge la page sous pression memoire, dont
   * le televersement d'une photo est un declencheur documente : la photo se
   * perdrait exactement au moment le plus probable.
   *
   * La photo est donc une SOUS-RESSOURCE auto-persistee, POST et DELETE sur
   * /api/recipes/:id/image, et la cle n'est jamais fournie par le client.
   *
   * PAS DE `.strict()` sur ce schema : Zod retire deja les cles inconnues, ce
   * qui suffit. Le rendre strict ferait echouer en 422 tous les enregistrements
   * des clients qui tournent encore sur l'ancien bundle, et une PWA installee
   * garde le sien jusqu'a ce que le service worker prenne la main.
   */
  sourceUrl: z.string().url('Adresse web invalide.').nullable().default(null),
  prepTimeMin: z.number().int().positive('Le temps de préparation doit être positif.').nullable().default(null),
  lines: z.array(recipeLineWriteSchema).default([]),
  tagIds: z.array(z.number().int().positive()).default([]),
})
export type RecipeWrite = z.infer<typeof recipeWriteSchema>

export const tagWriteSchema = tagSchema.omit({ id: true, createdAt: true })

// ---------------------------------------------------------------------------
// Nutrition
// ---------------------------------------------------------------------------

export const nutritionTotalSchema = z.object({
  kcal: z.number().default(0),
  proteins: z.number().default(0),
  carbs: z.number().default(0),
  sugars: z.number().default(0),
  fats: z.number().default(0),
  saturatedFats: z.number().default(0),
  fiber: z.number().default(0),
  salt: z.number().default(0),
})
export type NutritionTotal = z.infer<typeof nutritionTotalSchema>

// ---------------------------------------------------------------------------
// Calendrier
// ---------------------------------------------------------------------------

const isoWeekString = z
  .string()
  .regex(/^\d{4}-W\d{2}$/, "Semaine ISO attendue sous la forme '2026-W18'.")

/**
 * Une entree du calendrier. Regle XOR : exactement une recette OU un
 * ingredient, avec le champ de quantite correspondant.
 *
 * Le desktop n'interdisait pas `quantityG` sur une entree recette ni
 * `portions` sur une entree ingredient (annexe #22) : c'est resserre ici et
 * dans le CHECK SQL.
 */
const mealPlanEntryFields = {
  id: z.number().int().positive().nullable().default(null),
  isoWeek: isoWeekString,
  dayOfWeek: z.number().int().min(0).max(6),
  slot: mealSlotSchema,
  recipeId: z.number().int().positive().nullable().default(null),
  ingredientId: z.number().int().positive().nullable().default(null),
  quantityG: z.number().positive('quantity_g et portions doivent être strictement positifs.').nullable().default(null),
  portions: z.number().positive('quantity_g et portions doivent être strictement positifs.').nullable().default(null),
  /**
   * Unite d'affichage choisie a la saisie. Cosmetique : la quantite reste en
   * grammes. Sans elle, "40 g" d'un produit vendu par pieces de 100 g rouvrait
   * en "0,4 piece". Meme role que `recipe_ingredient.unit`.
   */
  unit: z.string().nullable().default(null),
  ordinal: z.number().int().min(0).default(0),
}

/**
 * La regle XOR, extraite pour etre appliquee a PLUSIEURS schemas.
 *
 * Ne surtout pas la reintroduire via `mealPlanEntrySchema.innerType()` : cette
 * methode rend l'objet SANS son raffinement, et la regle disparait
 * silencieusement — l'erreur ressort alors du CHECK SQLite, en 500 opaque.
 */
function checkMealPlanXor(
  entry: { recipeId: number | null; ingredientId: number | null; quantityG: number | null; portions: number | null },
  ctx: z.RefinementCtx,
): void {
  const hasRecipe = entry.recipeId !== null
  const hasIngredient = entry.ingredientId !== null
  if (hasRecipe === hasIngredient) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Une entrée du calendrier référence soit une recette, soit un ingrédient — pas les deux, pas aucun.',
    })
    return
  }
  if (hasRecipe && entry.portions === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['portions'], message: 'Le nombre de portions est requis pour une recette.' })
  }
  if (hasRecipe && entry.quantityG !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantityG'], message: 'Une entrée recette ne porte pas de quantité en grammes.' })
  }
  if (hasIngredient && entry.quantityG === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quantityG'], message: 'La quantité est requise pour un ingrédient.' })
  }
  if (hasIngredient && entry.portions !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['portions'], message: 'Une entrée ingrédient ne porte pas de portions.' })
  }
}

export const mealPlanEntrySchema = z.object(mealPlanEntryFields).superRefine(checkMealPlanXor)
export type MealPlanEntry = z.infer<typeof mealPlanEntrySchema>

/**
 * Creation d'une entree : meme regle XOR, sans les champs que le serveur
 * attribue lui-meme (identifiant et rang dans le creneau).
 */
export const mealPlanEntryWriteSchema = z
  .object(mealPlanEntryFields)
  .omit({ id: true, ordinal: true })
  .superRefine(checkMealPlanXor)

export const weeklyCostSnapshotSchema = z.object({
  isoWeek: isoWeekString,
  totalEur: decimalString,
  missingCount: z.number().int().min(0).default(0),
  capturedAt: utcTimestamp.nullable().default(null),
})
export type WeeklyCostSnapshot = z.infer<typeof weeklyCostSnapshotSchema>

// ---------------------------------------------------------------------------
// Prix, cuisson, frigo
// ---------------------------------------------------------------------------

export const priceHistoryEntrySchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  ingredientId: z.number().int().positive(),
  priceEur: positiveDecimalString,
  quantityG: z.number().positive('Une quantité (g) doit être strictement positive.'),
  store: z.string().nullable().default(null),
  /** Date d'observation, saisie par l'utilisateur. */
  recordedAt: dayDate,
  notes: z.string().nullable().default(null),
  createdAt: utcTimestamp.nullable().default(null),
})
export type PriceHistoryEntry = z.infer<typeof priceHistoryEntrySchema>

export const cookingLogEntrySchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  recipeId: z.number().int().positive(),
  cookedAt: dayDate,
  rating: z.number().int().min(1, 'La note doit être comprise entre 1 et 5.').max(5, 'La note doit être comprise entre 1 et 5.').nullable().default(null),
  notes: z.string().nullable().default(null),
  createdAt: utcTimestamp.nullable().default(null),
})
export type CookingLogEntry = z.infer<typeof cookingLogEntrySchema>

export const pantryStockSchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  ingredientId: z.number().int().positive(),
  quantityG: z.number().positive('Une quantité (g) doit être strictement positive.'),
  /** `null` = peremption non suivie (sel, epices). */
  expiryDate: dayDate.nullable().default(null),
  /**
   * Ou le lot est range. `null` = PAS ENCORE RANGE, et ce n'est pas un defaut :
   * tout ce qui arrive des courses est dans cet etat, l'application ne sachant
   * pas ou on a pose le paquet. L'ecran l'expose plutot que de deviner.
   */
  storage: z.enum(['frigo', 'placard', 'congelateur']).nullable().default(null),
  /**
   * Depuis quand a CET endroit. `addedAt` ne suffit pas : un lot achete en mai
   * et descendu au congelateur en juillet afficherait mai, alors que le
   * congelateur compte le temps passe. Calcule par le serveur, jamais recu du
   * client, d'ou son absence du schema d'ecriture.
   */
  storageSince: utcTimestamp.nullable().default(null),
  /**
   * L'unite de SAISIE, a cote de la masse. Meme regle que `recipe_ingredient`
   * depuis la 0001 et `meal_plan_entry` depuis la 0011 : sans elle, un lait de
   * coco saisi en millilitres se relit en grammes. `null` = aucun choix
   * enregistre, l'ecran retombe sur son heuristique.
   */
  unit: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  addedAt: utcTimestamp.nullable().default(null),
  updatedAt: utcTimestamp.nullable().default(null),
})
export type PantryStock = z.infer<typeof pantryStockSchema>

// ---------------------------------------------------------------------------
// Charges utiles d'ecriture
// ---------------------------------------------------------------------------
//
// Declarees ici, apres les schemas dont elles derivent : `omit()` s'evalue au
// chargement du module, donc une reference plus haut dans le fichier leverait
// avant meme le premier appel.

/** Deplacement d'une entree vers un autre jour ou creneau. */
export const mealPlanMoveSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  slot: mealSlotSchema,
})

/** Changement de quantite ou de portions, sans toucher au reste. */
export const mealPlanAmountSchema = z.object({
  quantityG: z.number().positive('La quantité doit être strictement positive.').nullable().default(null),
  portions: z.number().positive('Le nombre de portions doit être strictement positif.').nullable().default(null),
  /** L'unite suit la quantite : les deux se decident au meme endroit. */
  unit: z.string().nullable().default(null),
})

/** Ajout ou modification d'un lot au frigo. */
/**
 * `storageSince` est OMIS : il est calcule par le serveur au changement de
 * lieu, comme `updated_at`. Le laisser au client permettrait de dater a
 * volonte un sejour au congelateur.
 */
export const pantryStockWriteSchema = pantryStockSchema.omit({
  id: true,
  storageSince: true,
  addedAt: true,
  updatedAt: true,
})

/** Le motif d'une sortie de stock. Pose au moment du geste, seul moment ou la
 *  question a une reponse vraie. */
export const pantryMovementReasonSchema = z.enum(['consomme', 'jete'])
export type PantryMovementReason = z.infer<typeof pantryMovementReasonSchema>
export type PantryStockWrite = z.infer<typeof pantryStockWriteSchema>

/** Journal de cuisson — `recipeId` vient du chemin, pas du corps. */
export const cookingLogWriteSchema = cookingLogEntrySchema.omit({ id: true, recipeId: true, createdAt: true })

// ---------------------------------------------------------------------------
// Session de courses
// ---------------------------------------------------------------------------
//
// On scanne les produits au fur et a mesure qu'ils entrent dans le chariot.
// Rien n'est ecrit dans la bibliotheque ni dans le frigo pendant la session :
// tout est retenu, puis valide d'un bloc a la caisse. Abandonner une session
// ne doit laisser aucune trace — on renonce parfois a des courses.
//
// Le magasin est demande UNE FOIS, au depart : le redemander a chaque article
// serait insupportable sur trente produits.

/** Un article dans le chariot. */
export const sessionItemSchema = z.object({
  /** Identifiant local, attribue par le serveur a l'ajout. */
  id: z.string().min(1),
  /** `null` pour un article saisi a la main (vrac, fruits et legumes). */
  ean: z.string().nullable().default(null),
  name: nonEmpty('Donne un nom à cet article.'),
  brand: z.string().nullable().default(null),
  quantityG: z.number().positive('La quantité doit être strictement positive.'),
  /** `null` quand on n'a pas note le prix — l'article compte quand meme. */
  priceEur: positiveDecimalString.nullable().default(null),
  /**
   * Ingredient deja connu, quand le code-barres a ete reconnu.
   *
   * `null` signifie qu'il faudra CREER la fiche a la validation. C'est aussi ce
   * qui distingue « deja dans ma bibliotheque » de « nouveau produit », et donc
   * ce qui permet de cocher la bonne ligne de la liste de courses.
   */
  ingredientId: z.number().int().positive().nullable().default(null),
  /** Macros relevees sur OpenFoodFacts, gardees pour la creation differee. */
  macros: nutritionTotalSchema.partial().nullable().default(null),
  pieceWeightG: z.number().positive().nullable().default(null),
  /**
   * Date lue sur l'emballage, FACULTATIVE : on la saisit en magasin si on a
   * le paquet sous les yeux, sinon en rangeant. Le defaut `null` relit aussi
   * les chariots enregistres avant qu'elle existe.
   */
  expiryDate: dayDate.nullable().default(null),
  scannedAt: utcTimestamp.nullable().default(null),
})
export type SessionItem = z.infer<typeof sessionItemSchema>

export const shoppingSessionSchema = z.object({
  store: nonEmpty('Indique le magasin.'),
  /** Liste de courses de reference, pour la correspondance article par article. */
  isoWeek: isoWeekString,
  startedAt: utcTimestamp.nullable().default(null),
  items: z.array(sessionItemSchema).default([]),
})
export type ShoppingSession = z.infer<typeof shoppingSessionSchema>

/** Ouverture : le magasin et la semaine suffisent. */
export const sessionStartSchema = shoppingSessionSchema.pick({ store: true, isoWeek: true })

/** Ajout d'un article — l'identifiant vient du serveur. */
export const sessionItemWriteSchema = sessionItemSchema.omit({ id: true, scannedAt: true })

// ---------------------------------------------------------------------------
// Derives calcules cote client
// ---------------------------------------------------------------------------

export const SOURCE_LABELS: Record<Source, string> = {
  ciqual: 'CIQUAL',
  openfoodfacts: 'OpenFoodFacts',
  manual: 'manuel',
  lidl: 'Lidl',
}

/** Couleurs de badge, identiques en clair et en sombre (jetons hors theme). */
export const SOURCE_COLORS: Record<Source, string> = {
  ciqual: '#15803d',
  openfoodfacts: '#1d4ed8',
  manual: '#c2410c',
  lidl: '#c2410c',
}

/** Mois de saison parses depuis le CSV. Tableau vide si non renseigne. */
export function seasonMonths(ingredient: Pick<Ingredient, 'seasonMonths'>): number[] {
  if (!ingredient.seasonMonths) return []
  return ingredient.seasonMonths.split(',').map(Number).filter((m) => m >= 1 && m <= 12)
}

/**
 * Vrai si l'ingredient est de saison au mois courant.
 * Depend du mois LOCAL de l'utilisateur : ce derive ne peut pas etre calcule
 * cote serveur, dont le fuseau est UTC.
 */
export function isInSeasonNow(ingredient: Pick<Ingredient, 'seasonMonths'>, now: Date = new Date()): boolean {
  const months = seasonMonths(ingredient)
  return months.length > 0 && months.includes(now.getMonth() + 1)
}

/** Seaux d'urgence du frigo, identiques au desktop : 5 jours puis 14 jours. */
export type UrgencyBucket = 'soon' | 'watch' | 'stock'

export function urgencyBucket(daysLeft: number | null): UrgencyBucket {
  if (daysLeft === null) return 'stock'
  if (daysLeft <= 5) return 'soon'
  if (daysLeft <= 14) return 'watch'
  return 'stock'
}
