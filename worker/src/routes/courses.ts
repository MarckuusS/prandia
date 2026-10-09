/**
 * Session de courses — le chariot qui se remplit, article par article.
 *
 * On scanne en magasin, on valide a la caisse. Entre les deux, RIEN n'est ecrit
 * dans la bibliotheque ni dans le frigo : la session est un brouillon. On
 * renonce parfois a des courses, et un abandon ne doit laisser aucune trace.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI COTE SERVEUR, ET NON DANS LE NAVIGATEUR
 * ---------------------------------------------------------------------------
 * En magasin, iOS decharge volontiers un onglet passe en arriere-plan — on
 * repond a un message, on revient, la page a ete rechargee. Un chariot garde en
 * memoire disparaitrait au pire moment, apres vingt articles scannes. Il est
 * donc persiste a chaque ajout.
 *
 * Consequence utile : la session est partagee. L'un peut scanner pendant que
 * l'autre suit le total depuis l'autre bout du magasin.
 *
 * Une seule session a la fois : c'est une cuisine, pas une chaine de magasins.
 * Elle vit dans `app_setting`, qui accueille deja ce qui n'a pas de schema
 * propre — aucune migration a jouer.
 *
 * Les routes sont sous `/api/courses` et non `/api/shopping/session` : le motif
 * de `/api/shopping/:week` accepte n'importe quel segment et capterait
 * « session ». Dependre de l'ordre des imports pour qu'un routage soit correct
 * est une fragilite qui se paie toujours plus tard.
 *
 * ---------------------------------------------------------------------------
 * LA VALIDATION
 * ---------------------------------------------------------------------------
 * C'est le seul moment ou l'on ecrit, et l'ordre compte :
 *   1. creer les fiches des produits inconnus (ils entrent en bibliotheque) ;
 *   2. poser un lot au frigo pour chaque article ;
 *   3. enregistrer les prix au nom du magasin de la session ;
 *   4. cocher les lignes correspondantes de la liste de courses ;
 *   5. effacer la session.
 *
 * L'etape 1 doit preceder les autres : sans identifiant, ni le lot ni le prix
 * n'ont ou aller.
 */

import { sessionItemWriteSchema, sessionStartSchema, type ShoppingSession } from '@prandia/shared'

import { logActivity } from '../activity.js'
import { HttpError, json, notFound, parseOrThrow, readJson, route } from '../http.js'
import type { Repositories } from '../repos/index.js'

const KEY = 'shopping.session'

const load = (repos: Repositories): Promise<ShoppingSession | null> =>
  repos.settings.getJson<ShoppingSession | null>(KEY, null)

/**
 * Etat rendu au front : la session, et de quoi la confronter a la liste.
 *
 * `matchedIngredientIds` evite au front de recalculer la correspondance : le
 * serveur sait deja quels articles du chariot portent un ingredient connu.
 */
async function present(repos: Repositories, session: ShoppingSession | null) {
  if (session === null) return { active: false, session: null }

  const ids = session.items
    .map((item) => item.ingredientId)
    .filter((id): id is number => id !== null)

  return {
    active: true,
    session,
    matchedIngredientIds: [...new Set(ids)],
    // Total en centimes entiers, comme partout ailleurs : sommer des flottants
    // sur trente articles derive de quelques centimes.
    totalEur: totalOf(session),
    itemCount: session.items.length,
  }
}

/** Somme des prix notes. Les articles sans prix sont simplement absents du total. */
function totalOf(session: ShoppingSession): string {
  let cents = 0
  for (const item of session.items) {
    if (item.priceEur === null) continue
    cents += Math.round(Number(item.priceEur) * 100)
  }
  return (cents / 100).toFixed(2)
}

// ---------------------------------------------------------------------------

route('GET', '/api/courses', async ({ repos }) => json(await present(repos, await load(repos))))

route('POST', '/api/courses', async ({ repos, request, env, user }) => {
  const existing = await load(repos)
  if (existing !== null) {
    // Ecraser un chariot en cours serait la pire des surprises. On refuse, et
    // on nomme le magasin pour que l'interface puisse proposer de reprendre.
    throw new HttpError(
      409,
      'session_active',
      `Une session est déjà en cours chez ${existing.store}. Termine-la ou abandonne-la d'abord.`,
      { store: existing.store, itemCount: existing.items.length },
    )
  }

  const payload = parseOrThrow(sessionStartSchema, await readJson(request))
  const session: ShoppingSession = {
    store: payload.store.trim(),
    isoWeek: payload.isoWeek,
    startedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    items: [],
  }

  await repos.settings.setJson(KEY, session)
  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'shopping_session',
    label: `Courses chez ${session.store}`,
    details: { semaine: session.isoWeek },
  })

  return json(await present(repos, session), 201)
})

route('POST', '/api/courses/items', async ({ repos, request }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')

  const item = parseOrThrow(sessionItemWriteSchema, await readJson(request))

  const next: ShoppingSession = {
    ...session,
    items: [
      ...session.items,
      {
        ...item,
        // Identifiant local : deux articles identiques scannes de suite sont
        // deux lignes distinctes, et doivent pouvoir etre retirees separement.
        id: `${Date.now().toString(36)}-${session.items.length}`,
        scannedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      },
    ],
  }

  await repos.settings.setJson(KEY, next)
  return json(await present(repos, next), 201)
})

route('PUT', '/api/courses/items/:id', async ({ repos, params, request }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')

  const id = params['id'] ?? ''
  if (!session.items.some((item) => item.id === id)) throw notFound('Article introuvable.')

  const patch = parseOrThrow(sessionItemWriteSchema, await readJson(request))
  const next: ShoppingSession = {
    ...session,
    items: session.items.map((item) => (item.id === id ? { ...item, ...patch, id } : item)),
  }

  await repos.settings.setJson(KEY, next)
  return json(await present(repos, next))
})

route('DELETE', '/api/courses/items/:id', async ({ repos, params }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')

  const id = params['id'] ?? ''
  const next: ShoppingSession = { ...session, items: session.items.filter((item) => item.id !== id) }
  await repos.settings.setJson(KEY, next)
  return json(await present(repos, next))
})

/** Abandon. Rien n'a ete ecrit ailleurs : il n'y a rien a defaire. */
route('DELETE', '/api/courses', async ({ repos, env, user }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')

  await repos.settings.setJson(KEY, null)
  await logActivity(env.DB, user, {
    action: 'delete',
    entity: 'shopping_session',
    label: `Courses chez ${session.store} abandonnées`,
    details: { articles: session.items.length },
  })

  return json({ active: false, session: null })
})

/**
 * Validation : le chariot devient du stock.
 *
 * Rend le detail de ce qui a ete fait — combien de fiches creees, de lots
 * poses, de prix releves. Apres trente scans, « c'est enregistré » ne suffit
 * pas a rassurer.
 */
route('POST', '/api/courses/commit', async ({ repos, env, user }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')
  if (session.items.length === 0) {
    throw new HttpError(422, 'empty_session', 'Ce chariot est vide : il n’y a rien à enregistrer.')
  }

  const today = new Date().toISOString().slice(0, 10)
  let created = 0
  // Les lots crees, pour que le bilan propose de les ranger tout de suite.
  const stockedIds: number[] = []
  let stocked = 0
  let priced = 0
  const ingredientIds: number[] = []

  for (const item of session.items) {
    let ingredientId = item.ingredientId

    // 1. Le produit n'existe pas encore : on le cree, et il entre en
    //    bibliotheque. C'est le moment convenu — pas au scan, ou une session
    //    abandonnee aurait laisse des fiches derriere elle.
    if (ingredientId === null) {
      const known = item.ean === null ? null : await repos.ingredients.findBySourceRef('openfoodfacts', item.ean)
      if (known?.id != null) {
        ingredientId = known.id
        if (!known.inLibrary) await repos.ingredients.setInLibrary(ingredientId, true)
      } else {
        // Un nom deja pris ferait echouer la creation : on rattache alors a la
        // fiche existante plutot que de perdre l'article.
        const clash = await repos.ingredients.findByNormalizedName(item.name)
        if (clash?.id != null) {
          ingredientId = clash.id
          if (!clash.inLibrary) await repos.ingredients.setInLibrary(ingredientId, true)
        } else {
          ingredientId = await repos.ingredients.create({
            name: item.name,
            source: item.ean === null ? 'manual' : 'openfoodfacts',
            sourceRef: item.ean,
            brand: item.brand,
            pieceWeightG: item.pieceWeightG,
            inLibrary: true,
            ...(item.macros ?? {}),
          })
          created += 1
        }
      }
    }

    ingredientIds.push(ingredientId)

    /*
     * 2. Le lot, SANS LIEU ET SANS DATE, et les deux sont volontaires.
     *
     * L'application ne sait pas ou l'on rangera ce paquet, et elle ne le
     * devinera pas : il attend dans l'onglet "A ranger", ou l'on lui donne sa
     * place. Quant a la date, personne ne publie de duree de conservation par
     * produit : la deviner serait l'inventer, et elle serait crue. Le rangement
     * est le moment naturel de lire l'etiquette, une fois, et d'avoir juste.
     */
    const lotId = await repos.pantry.add({
      ingredientId,
      quantityG: item.quantityG,
      expiryDate: null,
      storage: null,
      unit: null,
      notes: `Courses du ${today} chez ${session.store}`,
    })
    stockedIds.push(lotId)
    stocked += 1

    // 3. Le prix, au nom du magasin de la session.
    if (item.priceEur !== null) {
      await repos.ingredients.addPriceObservation({
        ingredientId,
        priceEur: item.priceEur,
        quantityG: item.quantityG,
        store: session.store,
        recordedAt: today,
        notes: null,
      })
      priced += 1
    }
  }

  // 4. Cocher ce qui a ete achete. La liste doit refleter le chariot : rentrer
  //    des courses et retrouver la liste intacte donnerait tout a refaire.
  const checked = await repos.settings.getCheckedItems(session.isoWeek)
  await repos.settings.setCheckedItems(session.isoWeek, [...checked, ...ingredientIds])

  // 5. La session a rempli son office.
  await repos.settings.setJson(KEY, null)

  await logActivity(env.DB, user, {
    action: 'create',
    entity: 'shopping_session',
    label: `Courses chez ${session.store}`,
    details: { articles: session.items.length, fiches_creees: created, lots: stocked, prix: priced },
  })

  return json({
    active: false,
    session: null,
    store: session.store,
    itemCount: session.items.length,
    createdCount: created,
    stockedCount: stocked,
    // Additif : un client ancien l'ignore. Le bilan de fin de courses s'en sert
    // pour proposer de ranger tout de suite ce qui vient d'arriver.
    stockedIds,
    pricedCount: priced,
    totalEur: totalOf(session),
  })
})
