/**
 * Liste de courses.
 *
 * Derivee de la semaine planifiee : on agrege les ingredients de toutes les
 * recettes et entrees libres, on retranche ce qui est deja au frigo, et on
 * chiffre. Rien n'est stocke sauf les cases cochees — recalculer garantit que
 * la liste suit le calendrier, y compris quand l'autre telephone le modifie.
 */

import { aggregateShoppingList, isValidIsoWeek, currentIsoWeek, type ShoppingList } from '@prandia/shared'

import { logActivity } from '../activity.js'
import { badRequest, badWeek, json, route } from '../http.js'
import type { Repositories } from '../repos/index.js'

async function buildShoppingList(repos: Repositories, week: string): Promise<ShoppingList> {
  const entries = await repos.calendar.listWeek(week)

  // Chargement en masse : 4 requetes quel que soit le nombre d'entrees.
  const recipes = await repos.recipes.byIds(
    entries.map((e) => e.recipeId).filter((id): id is number => id !== null),
  )

  const ingredientIds = new Set<number>()
  for (const e of entries) if (e.ingredientId !== null) ingredientIds.add(e.ingredientId)
  for (const r of recipes.values()) {
    for (const l of r.lines) if (l.ingredient.id !== null) ingredientIds.add(l.ingredient.id)
  }

  const [ingredients, pantry] = await Promise.all([
    repos.ingredients.byIds(ingredientIds),
    repos.pantry.totalsByIngredient(),
  ])

  return aggregateShoppingList({
    isoWeek: week,
    entries,
    recipesById: recipes,
    ingredientsById: ingredients,
    pantryByIngredient: pantry,
  })
}

route('GET', '/api/shopping/:week', async ({ repos, params }) => {
  const week = params['week'] ?? ''
  if (!isValidIsoWeek(week)) throw badWeek(week)

  const [list, checked] = await Promise.all([
    buildShoppingList(repos, week),
    repos.settings.getCheckedItems(week),
  ])
  return json({ ...list, checkedIngredientIds: checked })
})

/**
 * Cases cochees. Volatiles dans le desktop : un rafraichissement en plein
 * magasin effacait tout le travail. Elles sont desormais persistees.
 */
route('PUT', '/api/shopping/:week/checked', async ({ repos, params, request, env, user }) => {
  const week = params['week'] ?? ''
  if (!isValidIsoWeek(week)) throw badWeek(week)

  const body = (await request.json().catch(() => null)) as { ingredientIds?: unknown } | null
  const ids = body?.ingredientIds
  if (!Array.isArray(ids) || !ids.every((v) => Number.isInteger(v))) {
    throw badRequest('ingredientIds doit être une liste d’entiers.')
  }

  const previous = await repos.settings.getCheckedItems(week)
  await repos.settings.setCheckedItems(week, ids as number[])

  // On ne journalise que le sens du changement, pas chaque case : cocher au
  // fil des rayons produirait vingt lignes illisibles pour une seule course.
  const added = (ids as number[]).length - previous.length
  if (added !== 0) {
    await logActivity(env.DB, user, {
      action: 'update',
      entity: 'shopping_checked',
      label: `Liste de courses ${week}`,
      details: {
        added: Math.max(added, 0),
        removed: Math.max(-added, 0),
        total: (ids as number[]).length,
      },
    })
  }

  return json({ isoWeek: week, checkedIngredientIds: ids })
})

/**
 * Archive le cout de la semaine.
 *
 * Recalculer un cout passe donnerait le prix d'AUJOURD'HUI. Cet instantane est
 * ce qui rend la comparaison entre semaines honnete.
 */
route('POST', '/api/shopping/:week/snapshot', async ({ repos, params }) => {
  const week = params['week'] ?? ''
  if (!isValidIsoWeek(week)) throw badWeek(week)

  const list = await buildShoppingList(repos, week)
  const snapshot = await repos.settings.saveWeeklyCost(week, list.totalEur, list.missingPriceCount)

  return json(snapshot, 201)
})

route('GET', '/api/shopping-history', async ({ repos, url }) =>
  json({ items: await repos.settings.listWeeklyCosts(Number(url.searchParams.get('limit') ?? 26) || 26) }),
)

/** Semaine courante — calculee cote serveur (UTC) et cote client (heure locale). */
route('GET', '/api/current-week', async () => json({ isoWeek: currentIsoWeek() }))
