/**
 * Recettes, tags et journal de cuisson.
 */

import { cookingLogWriteSchema, recipeWriteSchema, tagWriteSchema } from '@prandia/shared'

import { logActivity } from '../activity.js'
import { balayer } from './photos.js'
import { HttpError, intParam, json, notFound, parseOrThrow, readJson, route } from '../http.js'

// ---------------------------------------------------------------------------
// Recettes
// ---------------------------------------------------------------------------

route('GET', '/api/recipes', async ({ repos, url }) => {
  const tagParam = url.searchParams.get('tag')
  const items = await repos.recipes.listSummaries({
    query: url.searchParams.get('q'),
    tagId: tagParam ? Number(tagParam) || null : null,
  })
  return json({ items, totalCount: items.length })
})

route('POST', '/api/recipes', async ({ repos, request, env, user }) => {
  const payload = parseOrThrow(recipeWriteSchema, await readJson(request))
  await assertIngredientsExist(repos, payload.lines)

  const id = await repos.recipes.create(payload)
  await logActivity(env.DB, user, { action: 'create', entity: 'recipe', entityId: id, label: payload.name })

  return json(await repos.recipes.get(id), 201)
})

route('GET', '/api/recipes/:id', async ({ repos, params }) => {
  const recipe = await repos.recipes.get(intParam(params, 'id'))
  if (!recipe) throw notFound('Recette introuvable.')
  return json(recipe)
})

route('PUT', '/api/recipes/:id', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const before = await repos.recipes.get(id)
  if (!before) throw notFound('Recette introuvable.')

  /*
   * Ecriture conditionnelle. `PUT` REMPLACE integralement lignes et tags : sans
   * garde-fou, ouvrir la recette sur le telephone le matin et l'enregistrer le
   * soir effaçait en silence tout ce qui avait ete ajoute depuis le bureau
   * entre-temps. Sur un desktop mono-poste ça ne coutait rien ; ici les donnees
   * appartiennent a un foyer partage entre plusieurs appareils, ce qui est la
   * raison d'etre du portage.
   *
   * `If-Match` porte le `updated_at` lu au chargement. Absent, la requete reste
   * inconditionnelle : c'est la semantique HTTP de l'en-tete, et les scripts de
   * fumee comme un futur client s'en passent legitimement. Le front, lui,
   * l'envoie toujours.
   *
   * Limite connue : `updated_at` a la SECONDE. Deux enregistrements concurrents
   * dans la meme seconde passent tous les deux. La fenetre est trop etroite
   * pour justifier une colonne de version supplementaire aujourd'hui.
   */
  const expected = request.headers.get('If-Match')
  if (expected !== null && expected !== '*' && expected !== before.updatedAt) {
    throw new HttpError(
      409,
      'stale_recipe',
      'Cette recette a été modifiée ailleurs depuis que tu l’as ouverte.',
      { currentUpdatedAt: before.updatedAt },
    )
  }

  const payload = parseOrThrow(recipeWriteSchema, await readJson(request))
  await assertIngredientsExist(repos, payload.lines)

  await repos.recipes.update(id, payload)
  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'recipe',
    entityId: id,
    label: payload.name,
    details: { lignes: payload.lines.length, renommee: before.name !== payload.name ? before.name : undefined },
  })

  return json(await repos.recipes.get(id))
})

route('DELETE', '/api/recipes/:id', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  const recipe = await repos.recipes.get(id)
  if (!recipe) throw notFound('Recette introuvable.')

  // Le calendrier tombe en cascade. On le dit AVANT, dans la reponse : perdre
  // silencieusement trois repas planifies serait une mauvaise surprise.
  const planned = await repos.recipes.plannedCount(id)

  await repos.recipes.delete(id)

  /*
   * LES OBJETS R2 PARTENT AVEC LA RECETTE, et il faut lire la cle AVANT le
   * `delete` : apres, la ligne n'existe plus. Le balayage n'echoue jamais
   * bruyamment, une photo restee dans le bucket ne doit pas empecher de
   * supprimer une recette.
   *
   * Ce n'est pas qu'une question de place. `recipe.id` est declare
   * INTEGER PRIMARY KEY SANS AUTOINCREMENT, donc SQLite reattribue le plus
   * grand identifiant libere : sans ce balayage, une recette nouvelle pourrait
   * heriter des objets d'un plat supprime. La cle porte une empreinte de
   * contenu, donc rien ne serait AFFICHE par accident, mais l'objet trainerait.
   */
  await balayer(env, id, null)

  await logActivity(env.DB, user, {
    action: 'delete',
    entity: 'recipe',
    entityId: id,
    label: recipe.name,
    details: planned > 0 ? { repas_planifies_supprimes: planned } : undefined,
  })

  return json({ id, plannedEntriesRemoved: planned })
})

/**
 * Refuse tot une ligne qui pointe vers un ingredient disparu.
 *
 * `recipe_ingredient` porte une cle etrangere : sans ce controle, l'echec
 * remonterait comme une erreur SQLite opaque, apres que le DELETE des lignes
 * existantes soit deja parti dans le meme batch.
 */
async function assertIngredientsExist(
  repos: { ingredients: { byIds: (ids: number[]) => Promise<Map<number, unknown>> } },
  lines: ReadonlyArray<{ ingredientId: number }>,
): Promise<void> {
  if (lines.length === 0) return
  const ids = lines.map((l) => l.ingredientId)
  const found = await repos.ingredients.byIds(ids)
  const missing = [...new Set(ids)].filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw new HttpError(
      422,
      'unknown_ingredient',
      `Ingrédient introuvable (identifiant ${missing.join(', ')}). Il a peut-être été supprimé entre-temps.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Journal de cuisson
// ---------------------------------------------------------------------------

route('GET', '/api/recipes/:id/cooking', async ({ repos, params }) =>
  json({ items: await repos.recipes.listCookingLog(intParam(params, 'id')) }),
)

route('POST', '/api/recipes/:id/cooking', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const recipe = await repos.recipes.get(id)
  if (!recipe) throw notFound('Recette introuvable.')

  const entry = parseOrThrow(cookingLogWriteSchema, await readJson(request))
  const logId = await repos.recipes.addCookingLog({
    recipeId: id,
    cookedAt: entry.cookedAt,
    rating: entry.rating,
    notes: entry.notes,
  })

  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'cooking_log',
    entityId: logId,
    label: recipe.name,
    details: { le: entry.cookedAt, note: entry.rating },
  })

  return json({ items: await repos.recipes.listCookingLog(id) }, 201)
})

route('DELETE', '/api/cooking/:id', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  if (!(await repos.recipes.deleteCookingLog(id))) throw notFound('Entrée de journal introuvable.')

  await logActivity(env.DB, user, { action: 'delete', entity: 'cooking_log', entityId: id, label: 'Cuisson' })
  return json({ id })
})

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

route('GET', '/api/tags', async ({ repos }) => json({ items: await repos.recipes.listTags() }))

route('POST', '/api/tags', async ({ repos, request }) => {
  const payload = parseOrThrow(tagWriteSchema, await readJson(request))

  // `tag.name` est UNIQUE : on traduit la violation en message lisible plutot
  // que de laisser remonter « UNIQUE constraint failed ».
  const existing = (await repos.recipes.listTags()).find(
    (t) => t.name.toLowerCase() === payload.name.toLowerCase(),
  )
  if (existing) throw new HttpError(409, 'duplicate_name', `Le tag « ${existing.name} » existe déjà.`)

  const id = await repos.recipes.createTag(payload.name, payload.colorHex)
  return json({ id, name: payload.name, colorHex: payload.colorHex, recipeCount: 0 }, 201)
})

route('PUT', '/api/tags/:id', async ({ repos, params, request }) => {
  const id = intParam(params, 'id')
  const payload = parseOrThrow(tagWriteSchema, await readJson(request))
  if (!(await repos.recipes.updateTag(id, payload.name, payload.colorHex))) throw notFound('Tag introuvable.')
  return json({ id, name: payload.name, colorHex: payload.colorHex })
})

route('DELETE', '/api/tags/:id', async ({ repos, params }) => {
  const id = intParam(params, 'id')
  if (!(await repos.recipes.deleteTag(id))) throw notFound('Tag introuvable.')
  return json({ id })
})
