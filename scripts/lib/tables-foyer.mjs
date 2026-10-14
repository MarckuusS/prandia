/**
 * Les tables cloisonnees par foyer, dans l'ordre ou il faut les vider.
 *
 * `REFERENCES household (id)` est pose sans `ON DELETE` (migration 0005) :
 * rien ne part tout seul. Retirer une cuisine impose donc de vider ses enfants
 * un par un, puis la cuisine — l'ordre inverse fait echouer la contrainte, ou
 * pire, laisse des lignes qui ne designent plus rien.
 *
 * LA LISTE EST ECRITE, PAS DEDUITE, et c'est deliberé. Une table cloisonnee
 * ajoutee plus tard doit obliger quelqu'un a relire ce fichier plutot que
 * d'etre ramassee en silence par un nettoyage automatique — car ce nettoyage
 * n'aurait aucun moyen de connaitre le bon ORDRE. `worker/src/administration.
 * test.ts` compare cette liste aux migrations et echoue si l'une manque.
 */
export const TABLES_DU_FOYER = [
  // Les feuilles d'abord : elles pointent vers recipe, ingredient ou
  // pantry_stock, qui viennent plus bas.
  'recipe_cooking_log',
  'meal_plan_entry',
  // Un plat pointe vers sa fiche (ingredient) et sa recette : avant les deux.
  // Ses lignes (`preparation_line`) partent avec lui, en cascade.
  'preparation',
  'meal_plan_template',
  'weekly_cost_snapshot',
  'pantry_movement',
  'pantry_stock',
  'ingredient_price_history',
  'imported_receipt',
  'receipt_upload',
  'receipt_alias',
  // Puis les deux tables maitresses.
  'recipe',
  'ingredient',
  // Enfin les reglages, que rien ne reference.
  'tag',
  'category_definition',
  'custom_icon',
  // `app_setting` EST cloisonnee, mais son foyer 0 n'est pas une cuisine : il
  // porte le secret de signature des sessions et le compteur d'echecs (voir
  // GLOBAL_HOUSEHOLD dans worker/src/auth.ts). Aucun risque ici, la suppression
  // ne vise qu'un identifiant de cuisine reel, jamais 0 — mais toute evolution
  // de ce nettoyage doit garder cette distinction : effacer le foyer 0
  // deconnecterait tout le monde.
  'app_setting',
  'activity_log',
]
