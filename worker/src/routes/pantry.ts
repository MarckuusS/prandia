/**
 * Frigo et cellier.
 *
 * Chaque lot est distinct : deux briques de lait ouvertes a une semaine
 * d'ecart ne se confondent pas. C'est aussi ce qui permet de consommer le lot
 * le plus proche de la peremption sans toucher aux autres.
 */

import { isStorageSpace, pantryMovementReasonSchema, pantryStockWriteSchema } from '@prandia/shared'

import { logActivity } from '../activity.js'
import { badRequest, intParam, json, notFound, parseOrThrow, readJson, route } from '../http.js'
import type { Repositories } from '../repos/index.js'

async function loadPantry(repos: Repositories) {
  const items = await repos.pantry.list()
  const ingredients = await repos.ingredients.byIds(items.map((s) => s.ingredientId))
  return { items, ingredients: Object.fromEntries(ingredients) }
}

route('GET', '/api/pantry', async ({ repos }) => json(await loadPantry(repos)))

route('POST', '/api/pantry', async ({ repos, request, env, user }) => {
  const payload = parseOrThrow(pantryStockWriteSchema, await readJson(request))

  const ingredient = await repos.ingredients.get(payload.ingredientId)
  if (!ingredient) throw notFound('Ingrédient introuvable.')

  const id = await repos.pantry.add(payload)
  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'pantry_stock',
    entityId: id,
    label: ingredient.name,
    details: { grammes: payload.quantityG, peremption: payload.expiryDate },
  })

  return json(await loadPantry(repos), 201)
})

route('PUT', '/api/pantry/:id', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const stock = await repos.pantry.get(id)
  if (!stock) throw notFound('Lot introuvable.')

  const payload = parseOrThrow(pantryStockWriteSchema, await readJson(request))
  await repos.pantry.update(id, payload)

  const ingredient = await repos.ingredients.get(stock.ingredientId)
  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'pantry_stock',
    entityId: id,
    label: ingredient?.name ?? 'Lot',
    details: { grammes: payload.quantityG, peremption: payload.expiryDate },
  })

  return json(await loadPantry(repos))
})

/**
 * Consommation partielle.
 *
 * Le lot disparait s'il tombe a zero : la table porte un CHECK
 * (quantity_g > 0), donc un lot vide n'existe pas — et un « 0 g de lait »
 * dans la liste du frigo n'apprendrait rien a personne.
 */
route('POST', '/api/pantry/:id/consume', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const stock = await repos.pantry.get(id)
  if (!stock) throw notFound('Lot introuvable.')

  const body = (await readJson(request)) as { quantityG?: unknown; reason?: unknown }
  const amount = Number(body?.quantityG)
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest('Quantité à retirer invalide.')

  /*
   * LE MOTIF EST OBLIGATOIRE, et c'est tout l'interet de cette route.
   *
   * Un pot fini et un pot perime laissaient jusqu'ici la meme trace. Le seul
   * instant ou la question a une reponse vraie est celui du geste : on la pose
   * la, une fois, plutot que de deviner ensuite. Sans defaut, parce qu'un
   * defaut a "consomme" transformerait chaque hesitation en zero gaspillage.
   */
  const motif = pantryMovementReasonSchema.safeParse(body?.reason)
  if (!motif.success) throw badRequest('Motif de sortie manquant.', 'missing_reason')

  // Le mouvement est ecrit AVANT : si la consommation echoue ensuite, un
  // mouvement de trop vaut mieux qu'un mouvement perdu.
  const sorti = Math.min(amount, stock.quantityG)
  await repos.pantry.recordMovement(stock.ingredientId, sorti, motif.data)

  const outcome = await repos.pantry.consume(id, amount)
  const ingredient = await repos.ingredients.get(stock.ingredientId)

  await logActivity(env.DB, user, {
    action: outcome.removed ? 'delete' : 'update',
    entity: 'pantry_stock',
    entityId: id,
    label: ingredient?.name ?? 'Lot',
    details: { motif: motif.data, sorti_g: sorti, reste_g: outcome.remainingG },
  })

  return json({ ...(await loadPantry(repos)), removed: outcome.removed, remainingG: outcome.remainingG })
})

route('DELETE', '/api/pantry/:id', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  const stock = await repos.pantry.get(id)
  if (!stock) throw notFound('Lot introuvable.')

  const ingredient = await repos.ingredients.get(stock.ingredientId)
  await repos.pantry.delete(id)

  await logActivity(env.DB, user, {
    action: 'delete',
    entity: 'pantry_stock',
    entityId: id,
    label: ingredient?.name ?? 'Lot',
    details: { grammes: stock.quantityG },
  })

  return json(await loadPantry(repos))
})

/**
 * Ranger un lot, et RIEN D'AUTRE.
 *
 * Distincte du PUT complet parce que le geste l'est : depuis l'onglet
 * "A ranger", on donne une place a huit articles d'affilee sans vouloir
 * toucher a leur quantite, leur date ou leur note. Passer par le PUT
 * obligerait le client a renvoyer une fiche entiere qu'il n'a pas modifiee,
 * et le moindre ecart de son cache ecraserait une saisie faite ailleurs.
 *
 * Sert aussi au retour : `null` remet le lot a ranger, ce qui est le seul
 * moyen de corriger une erreur de rangement.
 */
route('PUT', '/api/pantry/:id/storage', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const stock = await repos.pantry.get(id)
  if (!stock) throw notFound('Lot introuvable.')

  const body = (await readJson(request)) as { storage?: unknown }
  const brut = body?.storage ?? null
  if (brut !== null && !isStorageSpace(brut)) {
    throw badRequest('Lieu de rangement inconnu.', 'invalid_storage')
  }

  await repos.pantry.setStorage(id, brut)

  const ingredient = await repos.ingredients.get(stock.ingredientId)
  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'pantry_stock',
    entityId: id,
    label: ingredient?.name ?? 'Lot',
    details: { range: brut ?? 'a ranger' },
  })

  return json(await loadPantry(repos))
})

/**
 * Le bilan des sorties depuis une date.
 *
 * Une requete d'agregation, deux nombres. C'est pour cela que les mouvements
 * vivent dans une table et non dans `activity_log.details`, qui est du TEXT
 * sans schema ni index : un bilan s'y calculerait en relisant tout le journal.
 */
route('GET', '/api/pantry/movements', async ({ repos, url }) => {
  const since = url.searchParams.get('since')
  if (since === null || !/^\d{4}-\d{2}-\d{2}/.test(since)) {
    throw badRequest('Date de début invalide.', 'invalid_since')
  }
  return json(await repos.pantry.movementTotals(since))
})
