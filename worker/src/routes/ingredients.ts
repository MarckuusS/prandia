/**
 * Ingredients : bibliotheque personnelle, catalogue, prix.
 *
 * Rappel du modele, qui surprend souvent : catalogue et bibliotheque sont la
 * meme table. « Ajouter » un ingredient CIQUAL ne cree rien, cela leve
 * `in_personal_library`. C'est pourquoi il y a deux verbes de suppression
 * distincts — retirer de la bibliotheque, et supprimer pour de bon.
 */

import { z } from 'zod'
import {
  COMPLETION_MAX,
  ingredientCreateSchema,
  ingredientPatchSchema,
  parseCriteria,
  parseQuantityToGrams,
  priceHistoryEntrySchema,
} from '@prandia/shared'

import { logActivity } from '../activity.js'
import { badRequest, HttpError, intParam, json, notFound, parseOrThrow, readJson, route } from '../http.js'
import { completerEnArrierePlan, completerProduits, demanderCompletion } from '../completion.js'

// ---------------------------------------------------------------------------
// Bibliotheque personnelle
// ---------------------------------------------------------------------------

route('GET', '/api/ingredients', async ({ repos, url }) => {
  const items = await repos.ingredients.listPersonal(url.searchParams.get('q'))
  return json({ items, totalCount: items.length })
})

route('POST', '/api/ingredients', async ({ repos, request, env, user, waitUntil }) => {
  const payload = parseOrThrow(ingredientCreateSchema, await readJson(request))

  // Un doublon exact de nom rend la bibliotheque inutilisable : deux "Tomate"
  // que rien ne distingue dans un menu deroulant. On refuse tot, avec le nom
  // exact du coupable plutot qu'une violation de contrainte.
  //
  // `inLibraryOnly` est essentiel : sans lui, le controle portait aussi sur les
  // milliers de lignes de catalogue jamais importees, et refusait une creation
  // en designant une fiche que l'utilisateur ne voit nulle part.
  const existing = await repos.ingredients.findByNormalizedName(payload.name, null, {
    inLibraryOnly: true,
  })
  if (existing) {
    // L'identifiant accompagne le message : l'interface peut alors proposer
    // d'ouvrir la fiche existante, au lieu de laisser l'utilisateur chercher
    // lui-meme ce qu'il vient de recreer.
    throw new HttpError(409, 'duplicate_name', `"${existing.name}" est déjà dans ta bibliothèque.`, {
      existingId: existing.id,
    })
  }

  const id = await repos.ingredients.create({ ...payload, inLibrary: true })
  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'ingredient',
    entityId: id,
    label: payload.name,
  })

  // Rayon, poids cuit, saison : Claude remplit ceux qui manquent, apres la
  // reponse (completion.ts). La creation n'attend pas, et n'echoue jamais pour
  // ca. Une fiche complete d'emblee ne coute pas de question.
  if (payload.categoryL1 == null || payload.cookedWeightPer100gRaw == null || payload.seasonMonths == null) {
    await completerEnArrierePlan({ env, repos, waitUntil }, [{ id, nom: payload.name, marque: payload.brand }])
  }

  return json(await repos.ingredients.get(id), 201)
})

/**
 * Combien de fiches de la bibliotheque attendent la completion par l'IA, et si
 * elle est possible (cle posee). Sans cle, l'ecran n'offre pas le bouton.
 */
route('GET', '/api/completion', async ({ repos, env }) => {
  return json({ restants: await repos.ingredients.countACompleter(), disponible: Boolean(env.ANTHROPIC_API_KEY) })
})

/**
 * Completer un lot de `COMPLETION_MAX` fiches de la bibliotheque : rayon, poids
 * cuit, saison, dans les champs vides seulement. Rend ce qui a ete ajoute et ce
 * qui reste : l'ecran relance tant qu'il en reste et que le lot a avance.
 */
route('POST', '/api/completion', async ({ repos, env }) => {
  const lot = (await repos.ingredients.listACompleter(COMPLETION_MAX)).filter(
    (i): i is typeof i & { id: number } => i.id !== null,
  )
  const completions = await completerProduits(
    env,
    repos,
    lot.map((i) => ({ id: i.id, nom: i.name, marque: i.brand })),
  )
  // Ce qui a vraiment ete ajoute : une proposition pour un champ deja rempli
  // ne compte pas, le depot ne l'a pas ecrite.
  let rayons = 0
  let poidsCuits = 0
  let saisons = 0
  for (const fiche of lot) {
    const c = completions.get(fiche.id)
    if (c === undefined) continue
    if (c.rayon !== null && (fiche.categoryL1 ?? '').trim() === '') rayons += 1
    if (c.poidsCuitG !== null && fiche.cookedWeightPer100gRaw === null) poidsCuits += 1
    if (c.moisSaison !== null && (fiche.seasonMonths ?? '') === '') saisons += 1
  }
  return json({
    traites: completions.size,
    rayons,
    poidsCuits,
    saisons,
    restants: await repos.ingredients.countACompleter(),
  })
})

const propositionSchema = z.object({
  nom: z.string().trim().min(1).max(200),
  marque: z.string().trim().max(200).nullable().optional(),
})

/**
 * Ce que l'IA propose pour la fiche OUVERTE, sans rien ecrire : l'ecran remplit
 * ses champs (vides, ou celui qu'on lui redemande), la personne relit et
 * enregistre. D'ou le registre `relue` : meilleure estimation, et le poids
 * d'une piece. Marche aussi pour une fiche pas encore creee, d'ou un nom et
 * non un identifiant.
 */
route('POST', '/api/completion/proposition', async ({ repos, env, request }) => {
  const { nom, marque } = parseOrThrow(propositionSchema, await readJson(request))
  const completions = await demanderCompletion(env, repos, [{ id: 1, nom, marque: marque || null }], { relue: true })
  return json(completions.get(1) ?? { rayon: null, poidsCuitG: null, moisSaison: null, poidsPieceG: null, poidsCuillereG: null })
})

route('GET', '/api/ingredients/:id', async ({ repos, params }) => {
  const ingredient = await repos.ingredients.get(intParam(params, 'id'))
  if (!ingredient) throw notFound('Ingrédient introuvable.')
  return json(ingredient)
})

route('PATCH', '/api/ingredients/:id', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const before = await repos.ingredients.get(id)
  if (!before) throw notFound('Ingrédient introuvable.')

  const patch = parseOrThrow(ingredientPatchSchema, await readJson(request))

  if (typeof patch.name === 'string') {
    // Meme perimetre qu'a la creation : renommer en heurtant une ligne de
    // catalogue invisible serait tout aussi bloquant, et tout aussi
    // incomprehensible.
    const clash = await repos.ingredients.findByNormalizedName(patch.name, id, {
      inLibraryOnly: true,
    })
    if (clash) {
      throw new HttpError(409, 'duplicate_name', `"${clash.name}" est déjà dans ta bibliothèque.`, {
        existingId: clash.id,
      })
    }
  }

  const changed = await repos.ingredients.update(id, patch)
  if (!changed) return json(before)

  // Le poids d'une cuillere a change : ce qui a ete saisi EN CUILLERES garde
  // son nombre de cuilleres, et sa masse suit (repos/ingredients.ts).
  if (patch.spoonWeightG !== undefined && patch.spoonWeightG !== before.spoonWeightG) {
    await repos.ingredients.reechelonnerCuilleres(id, before.spoonWeightG, patch.spoonWeightG)
  }

  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'ingredient',
    entityId: id,
    label: patch.name ?? before.name,
    details: { champs: Object.keys(patch) },
  })

  return json(await repos.ingredients.get(id))
})

/**
 * Suppression.
 *
 * Comportement repris du desktop : une ligne du catalogue (CIQUAL,
 * OpenFoodFacts) n'est jamais detruite, elle sort simplement de la
 * bibliotheque — la reimporter doit rester possible sans re-telecharger le
 * catalogue. Seules les fiches creees a la main disparaissent vraiment.
 */
route('DELETE', '/api/ingredients/:id', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  const ingredient = await repos.ingredients.get(id)
  if (!ingredient) throw notFound('Ingrédient introuvable.')

  if (ingredient.source !== 'manual') {
    await repos.ingredients.setInLibrary(id, false)
    await logActivity(env.DB, user, {
      action: 'update',
      entity: 'ingredient',
      entityId: id,
      label: ingredient.name,
      details: { retire_de_la_bibliotheque: true },
    })
    return json({ removed: 'library', ingredient: await repos.ingredients.get(id) })
  }

  const usage = await repos.ingredients.usage(id)
  if (usage.recipes > 0) {
    const names = await repos.ingredients.recipeNamesUsing(id)
    throw new HttpError(
      409,
      'in_use',
      `Impossible de supprimer « ${ingredient.name} » : utilisé par ${names.join(', ')}.`,
    )
  }

  await repos.ingredients.delete(id)
  await logActivity(env.DB, user, {
    action: 'delete',
    entity: 'ingredient',
    entityId: id,
    // Le libelle est fige ici : apres le DELETE, plus rien ne permettrait
    // de retrouver ce nom.
    label: ingredient.name,
  })

  return json({ removed: 'permanent', id })
})

// ---------------------------------------------------------------------------
// Catalogue — la fenetre « Importer un ingrédient »
// ---------------------------------------------------------------------------

route('GET', '/api/catalog', async ({ repos, url }) => {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200)
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0)

  const page = await repos.ingredients.searchCatalog(url.searchParams.get('q'), {
    source: url.searchParams.get('source'),
    categoryL1: url.searchParams.get('category'),
    criteria: parseCriteria(url.searchParams.get('bornes')),
    limit,
    offset,
  })

  return json({ ...page, limit, offset })
})

route('GET', '/api/categories', async ({ repos }) => json({ items: await repos.ingredients.listCategories() }))

/** Enseignes deja saisies — partagees entre les deux telephones du foyer. */
route('GET', '/api/stores', async ({ repos }) => json({ items: await repos.ingredients.listStores() }))

/** Fait entrer une fiche du catalogue dans la bibliotheque personnelle. */
route('PUT', '/api/ingredients/:id/library', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  const ingredient = await repos.ingredients.get(id)
  if (!ingredient) throw notFound('Ingrédient introuvable.')

  if (!ingredient.inLibrary) {
    await repos.ingredients.setInLibrary(id, true)
    await logActivity(env.DB, user, {
      action: 'create',
      entity: 'ingredient',
      entityId: id,
      label: ingredient.name,
      details: { importe_depuis: ingredient.source },
    })
  }

  return json(await repos.ingredients.get(id))
})

// ---------------------------------------------------------------------------
// Historique de prix
// ---------------------------------------------------------------------------

route('GET', '/api/ingredients/:id/prices', async ({ repos, params }) =>
  json({ items: await repos.ingredients.listPriceHistory(intParam(params, 'id')) }),
)

route('POST', '/api/ingredients/:id/prices', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const ingredient = await repos.ingredients.get(id)
  if (!ingredient) throw notFound('Ingrédient introuvable.')

  const body = await readJson(request)
  const entry = parseOrThrow(priceHistoryEntrySchema, {
    ...(typeof body === 'object' && body !== null ? body : {}),
    // L'identifiant du chemin fait foi : un corps qui en designerait un autre
    // ecrirait dans la fiche d'a cote.
    ingredientId: id,
  })

  await repos.ingredients.addPriceObservation({
    ingredientId: id,
    priceEur: entry.priceEur,
    quantityG: entry.quantityG,
    store: entry.store,
    recordedAt: entry.recordedAt,
    notes: entry.notes,
  })

  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'price_history',
    entityId: id,
    label: ingredient.name,
    details: { prix: entry.priceEur, pour_g: entry.quantityG, magasin: entry.store },
  })

  return json(
    {
      items: await repos.ingredients.listPriceHistory(id),
      ingredient: await repos.ingredients.get(id),
    },
    201,
  )
})

route('DELETE', '/api/prices/:id', async ({ repos, params, url, env, user }) => {
  const id = intParam(params, 'id')
  const removed = await repos.ingredients.deletePriceObservation(id)
  if (!removed) throw notFound('Relevé de prix introuvable.')

  await logActivity(env.DB, user, {
    action: 'delete',
    entity: 'price_history',
    entityId: id,
    label: 'Relevé de prix',
  })

  // La suppression a pu changer le prix courant de la fiche. On rend l'etat
  // recalcule quand l'appelant dit de quel ingredient il s'agit, plutot que de
  // le laisser deviner qu'il doit relire.
  const ingredientId = Number(url.searchParams.get('ingredient'))
  if (Number.isInteger(ingredientId) && ingredientId > 0) {
    return json({
      id,
      items: await repos.ingredients.listPriceHistory(ingredientId),
      ingredient: await repos.ingredients.get(ingredientId),
    })
  }

  return json({ id })
})

// ---------------------------------------------------------------------------
// Recherche OpenFoodFacts — proxy
// ---------------------------------------------------------------------------

/**
 * Le front n'appelle pas OpenFoodFacts directement : le navigateur y ajouterait
 * une requete preliminaire CORS a chaque frappe, et l'entete `User-Agent`
 * qu'OFF exige pour ne pas brider les clients anonymes n'est pas modifiable
 * depuis une page web.
 */
const OFF_NUTRIMENTS: Readonly<Record<string, string>> = {
  kcal: 'nutriments.energy-kcal_100g',
  proteins: 'nutriments.proteins_100g',
  carbs: 'nutriments.carbohydrates_100g',
  sugars: 'nutriments.sugars_100g',
  fats: 'nutriments.fat_100g',
  saturatedFats: 'nutriments.saturated-fat_100g',
  fiber: 'nutriments.fiber_100g',
  salt: 'nutriments.salt_100g',
}

route('GET', '/api/off/search', async ({ url, env }) => {
  const query = (url.searchParams.get('q') ?? '').trim()
  if (!query) return json({ items: [], totalCount: 0 })

  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 50)
  const page = Math.max(Number(url.searchParams.get('page') ?? 1) || 1, 1)

  // Les bornes s'ecrivent DANS la requete, en syntaxe Lucene : Search-a-licious
  // n'a pas de parametre de filtre separe. Un champ que OpenFoodFacts ne
  // connait pas est ignore plutot que rejete — mieux vaut une recherche un peu
  // moins filtree qu'une erreur 400 devant un rayon de supermarche.
  const bornes = parseCriteria(url.searchParams.get('bornes'))
    .map((c) => {
      const champ = OFF_NUTRIMENTS[c.field]
      if (!champ) return null
      return c.bound === 'min'
        ? `${champ}:[${c.value} TO *]`
        : `${champ}:[* TO ${c.value}]`
    })
    .filter((part): part is string => part !== null)

  const target = new URL('https://search.openfoodfacts.org/search')
  target.searchParams.set('q', [query, ...bornes].join(' AND '))
  target.searchParams.set('page_size', String(limit))
  target.searchParams.set('page', String(page))
  target.searchParams.set('langs', 'fr,en')

  let response: Response
  try {
    response = await fetch(target, { headers: { 'User-Agent': env.OFF_USER_AGENT, Accept: 'application/json' } })
  } catch {
    throw new HttpError(502, 'off_unreachable', 'OpenFoodFacts est injoignable. Réessaie plus tard.')
  }

  if (!response.ok) {
    throw new HttpError(502, 'off_error', `OpenFoodFacts a répondu ${response.status}.`)
  }

  const body = (await response.json()) as { hits?: unknown[]; count?: number }
  const hits = Array.isArray(body.hits) ? body.hits : []

  return json({
    items: hits.map(toOffCandidate),
    totalCount: body.count ?? hits.length,
    page,
    limit,
  })
})

/** Code-barres : le chemin du scan par la camera du telephone. */
route('GET', '/api/off/barcode/:ean', async ({ params, env, repos }) => {
  const ean = (params['ean'] ?? '').replace(/\D/g, '')
  if (ean.length < 8) throw badRequest('Code-barres invalide.', 'invalid_barcode')

  // Deja connu localement : on rend LA fiche existante, avec le prix releve
  // et le poids a la piece que l'utilisateur a saisis. Repartir d'OFF les
  // ecraserait a chaque scan.
  const known = await repos.ingredients.findBySourceRef('openfoodfacts', ean)
  if (known) return json({ ...known, alreadyKnown: true })

  let response: Response
  try {
    response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${ean}`, {
      headers: { 'User-Agent': env.OFF_USER_AGENT, Accept: 'application/json' },
    })
  } catch {
    throw new HttpError(502, 'off_unreachable', 'OpenFoodFacts est injoignable. Réessaie plus tard.')
  }

  if (response.status === 404) throw notFound(`Aucun produit ne correspond au code ${ean}.`)
  if (!response.ok) throw new HttpError(502, 'off_error', `OpenFoodFacts a répondu ${response.status}.`)

  const body = (await response.json()) as { status?: number; product?: Record<string, unknown> }
  if (body.status !== 1 || !body.product) throw notFound(`Aucun produit ne correspond au code ${ean}.`)

  return json(toOffCandidate(body.product))
})

// ---------------------------------------------------------------------------
// Prix observes — Open Prices
// ---------------------------------------------------------------------------

/**
 * Prix constate pour un code-barres, d'apres Open Prices.
 *
 * Open Prices est le projet de releves de prix d'OpenFoodFacts, alimente par
 * des contributeurs qui photographient leurs tickets. Lecture publique, sans
 * authentification.
 *
 * On ne rend PAS le dernier prix vu : sur un meme pot de 400 g, les releves
 * vont de 2,77 € a 4,39 € selon l'enseigne et la periode. Un point isole
 * serait une valeur au hasard presentee comme une reference. On rend donc la
 * MEDIANE — insensible aux extremes, contrairement a la moyenne — accompagnee
 * de l'etendue et du nombre de releves, pour que l'interface puisse dire a
 * quel point s'y fier.
 *
 * Les prix promotionnels sont ecartes : ils tirent la mediane vers le bas et
 * ne decrivent pas ce qu'on paiera un jour ordinaire.
 */
route('GET', '/api/prices/observed/:ean', async ({ params, env }) => {
  const ean = (params['ean'] ?? '').replace(/\D/g, '')
  if (ean.length < 8) throw badRequest('Code-barres invalide.', 'invalid_barcode')

  const target = new URL('https://prices.openfoodfacts.org/api/v1/prices')
  target.searchParams.set('product_code', ean)
  target.searchParams.set('currency', 'EUR')
  target.searchParams.set('price_is_discounted', 'false')
  target.searchParams.set('order_by', '-date')
  // 25 releves suffisent pour une mediane stable, et bornent le temps de
  // reponse : on est devant un rayon, pas devant un tableur.
  target.searchParams.set('size', '25')

  let response: Response
  try {
    response = await fetch(target, {
      headers: { 'User-Agent': env.OFF_USER_AGENT, Accept: 'application/json' },
    })
  } catch {
    // Une suggestion de prix est un confort : son indisponibilite ne doit pas
    // faire echouer l'ajout d'un produit. On rend « rien trouve ».
    return json({ ean, found: false, sampleCount: 0 })
  }

  if (!response.ok) return json({ ean, found: false, sampleCount: 0 })

  const body = (await response.json()) as {
    items?: Array<{ price?: unknown; date?: unknown; product?: { product_quantity?: unknown; product_quantity_unit?: unknown } }>
    total?: number
  }

  const items = Array.isArray(body.items) ? body.items : []
  const prices = items
    .map((i) => (typeof i.price === 'number' ? i.price : Number.parseFloat(String(i.price ?? ''))))
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b)

  if (prices.length === 0) return json({ ean, found: false, sampleCount: 0 })

  const middle = Math.floor(prices.length / 2)
  const median =
    prices.length % 2 === 1
      ? (prices[middle] as number)
      : ((prices[middle - 1] as number) + (prices[middle] as number)) / 2

  // La contenance vient de la copie qu'Open Prices tient du produit : elle est
  // parfois renseignee la ou la fiche OpenFoodFacts est vide.
  const first = items[0]?.product ?? {}
  const quantityG = parseQuantityToGrams(
    (first as Record<string, unknown>)['product_quantity'],
    (first as Record<string, unknown>)['product_quantity_unit'],
    (first as Record<string, unknown>)['quantity'],
  )

  const lastDate = items.find((i) => typeof i.date === 'string')?.date ?? null

  return json({
    ean,
    found: true,
    // Chaine decimale, comme tout montant dans cette application.
    priceEur: median.toFixed(4),
    minEur: (prices[0] as number).toFixed(4),
    maxEur: (prices[prices.length - 1] as number).toFixed(4),
    sampleCount: prices.length,
    totalCount: typeof body.total === 'number' ? body.total : prices.length,
    quantityG,
    lastSeen: lastDate,
  })
})

/**
 * Traduit un produit OFF vers la forme d'un ingredient.
 *
 * Les macros d'OFF sont deja pour 100 g. Les champs manquants restent `null` :
 * une valeur inconnue n'est pas zero, et ecrire 0 kcal fausserait tous les
 * totaux de la semaine sans que rien ne le signale.
 */
/**
 * Les marques, en texte. La fiche produit (`/api/v2/product`) les donne en
 * chaine ("Bonduelle, Carrefour"), la RECHERCHE (Search-a-licious) en liste
 * (["Bonduelle"]) : lues comme une chaine seulement, elles disparaissaient de
 * tous les resultats de recherche (constate le 2026-10-11).
 */
function marques(valeur: unknown): string | null {
  const texte = Array.isArray(valeur)
    ? valeur
        .filter((m): m is string => typeof m === 'string')
        .map((m) => m.trim())
        .filter((m) => m !== '')
        .join(', ')
    : typeof valeur === 'string'
      ? valeur
      : ''
  return texte.trim() === '' ? null : texte.trim()
}

function toOffCandidate(raw: unknown): Record<string, unknown> {
  const p = (raw ?? {}) as Record<string, unknown>
  const n = (p['nutriments'] ?? {}) as Record<string, unknown>
  const num = (key: string): number | null => {
    const value = n[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }

  const name =
    (typeof p['product_name_fr'] === 'string' && p['product_name_fr']) ||
    (typeof p['product_name'] === 'string' && p['product_name']) ||
    'Produit sans nom'

  return {
    id: null,
    name,
    source: 'openfoodfacts',
    sourceRef: typeof p['code'] === 'string' ? p['code'] : null,
    brand: marques(p['brands']),
    kcal: num('energy-kcal_100g'),
    proteins: num('proteins_100g'),
    carbs: num('carbohydrates_100g'),
    sugars: num('sugars_100g'),
    fats: num('fat_100g'),
    saturatedFats: num('saturated-fat_100g'),
    fiber: num('fiber_100g'),
    salt: num('salt_100g'),
    priceEur: null,
    priceQuantityG: null,
    // Contenance du paquet. Pour un produit emballe, « une piece » EST le
    // paquet : un pot de moutarde de 360 g. C'est ce qui permet d'ecrire
    // « 1 pot » dans une recette plutot que de peser.
    pieceWeightG: parseQuantityToGrams(p['product_quantity'], p['product_quantity_unit'], p['quantity']),
    cookedWeightPer100gRaw: null,
    inLibrary: false,
    categoryL1: null,
    categoryL2: null,
    seasonMonths: null,
    restockThresholdG: null,
    /*
     * OpenFoodFacts le renvoyait DEJA, c'est cette traduction qui le jetait :
     * la requete ne l'omettait pas, elle le laissait tomber ici. Deux noms
     * circulent selon l'anciennete de la fiche, `nutriscore_grade` et
     * `nutrition_grades` ; on accepte les deux, on minuscule, et on filtre sur
     * a..e parce qu'OFF ecrit aussi "not-applicable" et "unknown", qui ne sont
     * pas des notes et se liraient comme un mauvais score.
     */
    nutriscoreGrade: offGrade(p['nutriscore_grade'] ?? p['nutrition_grades']),
    createdAt: null,
    updatedAt: null,
  }
}

/** Une note a..e, ou `null`. Jamais "unknown", qui n'est pas une note. */
function offGrade(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const grade = raw.trim().toLowerCase()
  return ['a', 'b', 'c', 'd', 'e'].includes(grade) ? grade : null
}
