/**
 * Point d'acces unique aux donnees.
 *
 * Un repository par domaine, agrege ici. Le decoupage suit celui du desktop
 * (`app/data/repositories/`) et sert le meme but : un fichier unique de 1 500
 * lignes de SQL devient impossible a modifier a plusieurs sans conflits.
 *
 * L'instance est construite a chaque requete — un Worker n'a pas d'etat
 * partage fiable entre invocations, et D1 ne coute rien a « ouvrir ».
 *
 * ---------------------------------------------------------------------------
 * LE CLOISONNEMENT PAR FOYER
 * ---------------------------------------------------------------------------
 * Plusieurs cuisines cohabitent dans la meme base. Le foyer est donc lie ICI,
 * a la CONSTRUCTION, et jamais passe requete par requete.
 *
 * Ce choix est la principale mesure de securite du modele, et il tient a une
 * chose : un appelant ne peut pas oublier ce qu'il n'a pas a fournir. Passer
 * `householdId` en argument de chaque methode aurait multiplie par cinquante
 * les occasions de l'omettre — et SQLite n'ayant pas de Row-Level Security,
 * rien n'aurait rattrape l'oubli.
 *
 * Sa valeur vient de `SessionUser.householdId`, donc de la table `user`, donc
 * du cookie signe. Aucune route ne la choisit, aucun corps de requete ne peut
 * l'influencer.
 *
 * `scripts/smoke-isolation.mjs` verifie qu'aucun chemin de lecture ne franchit
 * la frontiere. C'est la seconde mesure, et la seule qui prouve quelque chose.
 */

import { CalendarRepo } from './calendar.js'
import { IconRepo } from './icons.js'
import { IngredientRepo } from './ingredients.js'
import { PantryRepo } from './pantry.js'
import { PreparationRepo } from './preparations.js'
import { RayonRepo } from './rayons.js'
import { RecipeRepo } from './recipes.js'
import { SettingsRepo } from './settings.js'

/**
 * Foyer inexistant, utilise quand aucune session n'est etablie.
 *
 * Choix DELIBEREMENT ferme : une requete faite sans utilisateur ne rend rien,
 * au lieu de rendre les donnees du foyer 1. Les routes publiques ne touchent
 * de toute facon pas aux repositories — si l'une venait a le faire, elle
 * echouerait a vide plutot que de fuiter.
 */
export const NO_HOUSEHOLD = 0

export class Repositories {
  readonly ingredients: IngredientRepo
  readonly recipes: RecipeRepo
  readonly calendar: CalendarRepo
  readonly pantry: PantryRepo
  readonly preparations: PreparationRepo
  readonly settings: SettingsRepo
  readonly rayons: RayonRepo
  readonly icons: IconRepo

  constructor(db: D1Database, householdId: number) {
    this.ingredients = new IngredientRepo(db, householdId)
    // Les recettes chargent leurs ingredients : la dependance est explicite
    // plutot que dupliquee, sinon deux chemins liraient la meme table
    // differemment — et l'un des deux pourrait oublier le foyer.
    this.recipes = new RecipeRepo(db, householdId, this.ingredients)
    this.calendar = new CalendarRepo(db, householdId)
    this.pantry = new PantryRepo(db, householdId)
    this.preparations = new PreparationRepo(db, householdId)
    this.settings = new SettingsRepo(db, householdId)
    this.rayons = new RayonRepo(db, householdId)
    this.icons = new IconRepo(db, householdId)
  }
}

export { CalendarRepo, IconRepo, IngredientRepo, PantryRepo, PreparationRepo, RayonRepo, RecipeRepo, SettingsRepo }
export type { EntryWrite } from './calendar.js'
export type { IngredientUsage, IngredientWrite } from './ingredients.js'
export type { CustomIconRow } from './icons.js'
export type { RayonRow } from './rayons.js'
export type { RecipeLineWrite, RecipeSummary, RecipeWrite } from './recipes.js'
