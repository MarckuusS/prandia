/**
 * Planificateur de semaine.
 *
 * Les entrees sont rendues avec les recettes et ingredients qu'elles
 * referencent, indexes par identifiant. Le front n'a ainsi qu'un aller-retour
 * a faire pour peindre la semaine entiere, la ou le desktop rechargeait chaque
 * entree separement.
 */

import {
  isValidIsoWeek,
  mealPlanAmountSchema,
  mealPlanEntryWriteSchema,
  mealPlanMoveSchema,
  MEAL_SLOT_LABELS,
  DAY_LABELS,
} from '@prandia/shared'

import { logActivity } from '../activity.js'
import { badWeek, HttpError, intParam, json, notFound, parseOrThrow, readJson, route } from '../http.js'
import type { Repositories } from '../repos/index.js'

/** Charge la semaine et tout ce qu'elle reference, en 3 requetes. */
async function loadWeek(repos: Repositories, week: string) {
  const entries = await repos.calendar.listWeek(week)

  const [recipes, ingredients] = await Promise.all([
    repos.recipes.byIds(entries.map((e) => e.recipeId).filter((id): id is number => id !== null)),
    repos.ingredients.byIds(entries.map((e) => e.ingredientId).filter((id): id is number => id !== null)),
  ])

  return {
    isoWeek: week,
    entries,
    recipes: Object.fromEntries(recipes),
    ingredients: Object.fromEntries(ingredients),
  }
}

function requireWeek(params: Record<string, string>): string {
  const week = params['week'] ?? ''
  if (!isValidIsoWeek(week)) throw badWeek(week)
  return week
}

/** « Mardi midi » — utilise tel quel dans le journal d'activite. */
const whenLabel = (dayOfWeek: number, slot: string): string =>
  `${DAY_LABELS[dayOfWeek] ?? '?'} ${(MEAL_SLOT_LABELS[slot as keyof typeof MEAL_SLOT_LABELS] ?? slot).toLowerCase()}`

// ---------------------------------------------------------------------------

route('GET', '/api/calendar/:week', async ({ repos, params }) => json(await loadWeek(repos, requireWeek(params))))

route('POST', '/api/calendar/:week/entries', async ({ repos, params, request, env, user }) => {
  const week = requireWeek(params)
  const body = await readJson(request)
  const entry = parseOrThrow(mealPlanEntryWriteSchema, {
    ...(typeof body === 'object' && body !== null ? body : {}),
    // La semaine du chemin fait foi : un corps qui en designerait une autre
    // ecrirait des repas dans une semaine que l'utilisateur ne regarde pas.
    isoWeek: week,
  })

  // La cible doit appartenir a CETTE cuisine. Les repositories sont cloisonnes,
  // donc un identifiant etranger rend `null` — sans ce controle on inserait une
  // entree pointant dans le vide, qui s'afficherait « Ingrédient supprimé » et
  // fausserait les totaux. Rien ne fuiterait, mais rien ne le signalerait non
  // plus.
  await assertTargetExists(repos, entry.recipeId, entry.ingredientId)

  const label = await describeTarget(repos, entry.recipeId, entry.ingredientId)
  const id = await repos.calendar.addEntry({
    isoWeek: week,
    dayOfWeek: entry.dayOfWeek,
    slot: entry.slot,
    recipeId: entry.recipeId,
    ingredientId: entry.ingredientId,
    quantityG: entry.quantityG,
    portions: entry.portions,
    unit: entry.unit,
  })

  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'meal_plan_entry',
    entityId: id,
    label,
    details: { semaine: week, quand: whenLabel(entry.dayOfWeek, entry.slot) },
  })

  return json(await loadWeek(repos, week), 201)
})

route('PATCH', '/api/calendar/entries/:id', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const entry = await repos.calendar.getEntry(id)
  if (!entry) throw notFound('Entrée introuvable.')

  const amount = parseOrThrow(mealPlanAmountSchema, await readJson(request))

  // La regle XOR de la table s'applique aussi ici : une entree recette porte
  // des portions, une entree ingredient des grammes. Laisser passer les deux
  // ferait echouer le CHECK SQL avec un message incomprehensible.
  if (entry.recipeId !== null && (amount.portions === null || amount.quantityG !== null)) {
    throw new HttpError(422, 'validation', 'Une entrée recette se règle en portions.')
  }
  if (entry.ingredientId !== null && (amount.quantityG === null || amount.portions !== null)) {
    throw new HttpError(422, 'validation', 'Une entrée ingrédient se règle en grammes.')
  }

  await repos.calendar.updateAmount(id, amount.quantityG, amount.portions, amount.unit)
  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'meal_plan_entry',
    entityId: id,
    label: await describeTarget(repos, entry.recipeId, entry.ingredientId),
    details: { portions: amount.portions, grammes: amount.quantityG },
  })

  return json(await loadWeek(repos, entry.isoWeek))
})

/** Deplacement — le glisser-deposer du desktop, devenu « Déplacer vers… » au doigt. */
route('PUT', '/api/calendar/entries/:id/move', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const entry = await repos.calendar.getEntry(id)
  if (!entry) throw notFound('Entrée introuvable.')

  const target = parseOrThrow(mealPlanMoveSchema, await readJson(request))
  await repos.calendar.moveEntry(id, target.dayOfWeek, target.slot)

  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'meal_plan_entry',
    entityId: id,
    label: await describeTarget(repos, entry.recipeId, entry.ingredientId),
    details: { de: whenLabel(entry.dayOfWeek, entry.slot), vers: whenLabel(target.dayOfWeek, target.slot) },
  })

  return json(await loadWeek(repos, entry.isoWeek))
})

route('DELETE', '/api/calendar/entries/:id', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  const entry = await repos.calendar.getEntry(id)
  if (!entry) throw notFound('Entrée introuvable.')

  const label = await describeTarget(repos, entry.recipeId, entry.ingredientId)
  await repos.calendar.deleteEntry(id)

  await logActivity(env.DB, user, {
    action: 'delete',
    entity: 'meal_plan_entry',
    entityId: id,
    label,
    details: { semaine: entry.isoWeek, quand: whenLabel(entry.dayOfWeek, entry.slot) },
  })

  return json(await loadWeek(repos, entry.isoWeek))
})

route('DELETE', '/api/calendar/:week/days/:day', async ({ repos, params, env, user }) => {
  const week = requireWeek(params)
  const day = Number(params['day'])
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new HttpError(400, 'invalid_day', 'Jour invalide.')

  const removed = await repos.calendar.clearDay(week, day)
  if (removed > 0) {
    await logActivity(env.DB, user, {
      action: 'delete',
      entity: 'meal_plan_entry',
      label: `${DAY_LABELS[day]} vidé`,
      details: { semaine: week, entrees: removed },
    })
  }

  return json({ ...(await loadWeek(repos, week)), removed })
})

route('DELETE', '/api/calendar/:week', async ({ repos, params, env, user }) => {
  const week = requireWeek(params)
  const removed = await repos.calendar.clearWeek(week)
  if (removed > 0) {
    await logActivity(env.DB, user, {
      action: 'delete',
      entity: 'meal_plan_entry',
      label: `Semaine ${week} vidée`,
      details: { entrees: removed },
    })
  }
  return json({ ...(await loadWeek(repos, week)), removed })
})

/** Recopie une semaine — « repartir de la semaine dernière » plutot que tout resaisir. */
route('POST', '/api/calendar/:week/copy-from', async ({ repos, params, request, env, user }) => {
  const week = requireWeek(params)
  const body = (await readJson(request)) as { from?: unknown }
  const from = typeof body?.from === 'string' ? body.from : ''
  if (!isValidIsoWeek(from)) throw badWeek(from)
  if (from === week) throw new HttpError(422, 'validation', 'Source et destination sont la même semaine.')

  const copied = await repos.calendar.copyWeek(from, week)
  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'meal_plan_entry',
    label: `Semaine ${week} copiée depuis ${from}`,
    details: { entrees: copied },
  })

  return json({ ...(await loadWeek(repos, week)), copied }, 201)
})

// ---------------------------------------------------------------------------
// Modeles de semaine
// ---------------------------------------------------------------------------

route('GET', '/api/templates', async ({ repos }) => json({ items: await repos.calendar.listTemplates() }))

route('POST', '/api/templates', async ({ repos, request }) => {
  const body = (await readJson(request)) as { name?: unknown; isoWeek?: unknown }
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const isoWeek = typeof body?.isoWeek === 'string' ? body.isoWeek : ''
  if (!name) throw new HttpError(422, 'validation', 'Donne un nom à ce modèle.')
  if (!isValidIsoWeek(isoWeek)) throw badWeek(isoWeek)

  const id = await repos.calendar.saveTemplate(name, isoWeek)
  return json({ id, items: await repos.calendar.listTemplates() }, 201)
})

route('PUT', '/api/templates/:id/apply', async ({ repos, params, request }) => {
  const id = intParam(params, 'id')
  const body = (await readJson(request)) as { isoWeek?: unknown }
  const isoWeek = typeof body?.isoWeek === 'string' ? body.isoWeek : ''
  if (!isValidIsoWeek(isoWeek)) throw badWeek(isoWeek)

  const applied = await repos.calendar.applyTemplate(id, isoWeek)
  if (applied < 0) throw notFound('Modèle introuvable ou illisible.')

  return json({ ...(await loadWeek(repos, isoWeek)), applied })
})

route('DELETE', '/api/templates/:id', async ({ repos, params }) => {
  const id = intParam(params, 'id')
  if (!(await repos.calendar.deleteTemplate(id))) throw notFound('Modèle introuvable.')
  return json({ id })
})

/**
 * Refuse une entree qui designe une recette ou un ingredient d'ailleurs.
 *
 * Le message ne distingue pas « n'existe pas » de « n'est pas a vous » : le
 * second renseignerait sur l'existence d'une fiche chez quelqu'un d'autre.
 */
async function assertTargetExists(
  repos: Repositories,
  recipeId: number | null,
  ingredientId: number | null,
): Promise<void> {
  if (recipeId !== null && (await repos.recipes.get(recipeId)) === null) {
    throw new HttpError(422, 'unknown_recipe', 'Recette introuvable.')
  }
  if (ingredientId !== null && (await repos.ingredients.get(ingredientId)) === null) {
    throw new HttpError(422, 'unknown_ingredient', 'Ingrédient introuvable.')
  }
}

/**
 * Nom lisible de ce que designe une entree.
 *
 * Fige dans le journal au moment de l'action : apres suppression de la
 * recette, aucune jointure ne pourrait le reconstituer.
 */
async function describeTarget(
  repos: Repositories,
  recipeId: number | null,
  ingredientId: number | null,
): Promise<string> {
  if (recipeId !== null) return (await repos.recipes.get(recipeId))?.name ?? 'Recette'
  if (ingredientId !== null) return (await repos.ingredients.get(ingredientId))?.name ?? 'Ingrédient'
  return 'Repas'
}
