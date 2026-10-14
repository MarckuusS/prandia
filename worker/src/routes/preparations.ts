/**
 * Cuisiner : `POST /api/preparations` (shared/src/preparation.ts).
 *
 * Le corps dit ce qu'on a VRAIMENT mis dans le plat ; le serveur fait le
 * reste, et c'est lui qui fait foi :
 *   - les apports pour 100 g du plat, recalcules ICI sur les fiches de la
 *     cuisine (un client ne choisit pas les valeurs d'une fiche) ;
 *   - la fiche du plat, hors de la bibliotheque : on la mange, on ne la
 *     rachete pas ;
 *   - ce qui sort du frigo, les lots qui periment le plus tot d'abord ;
 *   - le reste du plat au frigo, et la part du repas qui l'a lance.
 * La recette, elle, n'est pas touchee.
 */

import { PIECE_UNIT_CODE, apportsDuPlat, preparationWriteSchema, sortiesDuFrigo } from '@prandia/shared'

import { logActivity } from '../activity.js'
import { badRequest, json, notFound, parseOrThrow, readJson, route } from '../http.js'

/** Deux decimales : la precision d'une etiquette, sans le bruit d'une division. */
const arrondi = (v: number) => Math.round(v * 100) / 100

route('POST', '/api/preparations', async ({ repos, request, env, user }) => {
  const p = parseOrThrow(preparationWriteSchema, await readJson(request))

  const ids = p.lines.map((l) => l.ingredientId)
  const fiches = await repos.ingredients.byIds(ids)
  const lignes = p.lines.map((l) => {
    const ingredient = fiches.get(l.ingredientId)
    if (ingredient === undefined) throw badRequest('Un ingrédient du plat est introuvable.', 'unknown_ingredient')
    return { ...l, ingredient }
  })

  if (p.recipeId !== null && (await repos.recipes.get(p.recipeId)) === null) throw notFound('Recette introuvable.')
  if (p.entryId !== null) {
    const entree = await repos.calendar.getEntry(p.entryId)
    if (entree === null || entree.recipeId === null) throw notFound('Ce repas n’est plus au planning.')
  }

  const { pour100g } = apportsDuPlat(lignes, p.cookedWeightG)
  const sorties = sortiesDuFrigo(p.lines, await repos.pantry.lotsOf(ids))
  const reste = p.cookedWeightG - (p.myPartG ?? 0)

  const ficheId = await repos.ingredients.create({
    name: p.name,
    source: 'manual',
    inLibrary: false,
    kcal: arrondi(pour100g.kcal),
    proteins: arrondi(pour100g.proteins),
    carbs: arrondi(pour100g.carbs),
    sugars: arrondi(pour100g.sugars),
    fats: arrondi(pour100g.fats),
    saturatedFats: arrondi(pour100g.saturatedFats),
    fiber: arrondi(pour100g.fiber),
    salt: arrondi(pour100g.salt),
    // Une part devient la "piece" du plat : "1 part (350 g)" partout ou l'on
    // saisit une quantite, sans rien ajouter aux champs existants.
    pieceWeightG: p.parts === null ? null : arrondi(p.cookedWeightG / p.parts),
  })

  let preparationId: number
  try {
    preparationId = await repos.preparations.enregistrer({
      ingredientId: ficheId,
      recipeId: p.recipeId,
      cookedOn: p.cookedOn,
      cookedWeightG: p.cookedWeightG,
      parts: p.parts,
      lignes: lignes.map((l) => ({ ingredientId: l.ingredientId, name: l.ingredient.name, quantityG: l.quantityG, unit: l.unit })),
      // Moins d'un gramme : tout a ete mange, rien ne va au frigo.
      lot: reste >= 1 ? { quantityG: reste, expiryDate: p.expiryDate } : null,
      sorties,
      part:
        p.entryId !== null && p.myPartG !== null
          ? { entryId: p.entryId, quantityG: p.myPartG, unit: p.parts === null ? null : PIECE_UNIT_CODE }
          : null,
    })
  } catch (erreur) {
    // Le lot d'ecritures n'a rien laisse : la fiche seule ne doit pas rester.
    await repos.ingredients.delete(ficheId)
    throw erreur
  }

  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'preparation',
    entityId: preparationId,
    label: p.name,
    details: { grammes: p.cookedWeightG, parts: p.parts, sortis_du_frigo: sorties.length },
  })

  return json(
    {
      preparationId,
      ingredientId: ficheId,
      sorties: sorties.map((s) => ({ name: fiches.get(s.ingredientId)?.name ?? '', quantityG: s.quantityG })),
    },
    201,
  )
})
