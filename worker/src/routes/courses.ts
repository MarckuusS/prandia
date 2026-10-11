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

import { z } from 'zod'
import {
  TICKET_TOOL,
  interpretTicket,
  parisClock,
  sessionItemWriteSchema,
  sessionStartSchema,
  ticketQuestion,
  type ProduitACompleter,
  type ShoppingSession,
  type TicketArticle,
} from '@prandia/shared'

import { logActivity } from '../activity.js'
import { cleClaude, compterAppel, demanderOutil } from '../anthropic.js'
import { completerEnArrierePlan } from '../completion.js'
import { HttpError, json, notFound, parseOrThrow, readJson, route } from '../http.js'
import { imageDuCorps } from '../imageRecue.js'
import type { Repositories } from '../repos/index.js'

const KEY = 'shopping.session'

/**
 * La session telle qu'enregistree. Un chariot ouvert avant l'arrivee du vrac
 * "a peser" n'a pas ce champ : `undefined` y vaut "non", sans quoi
 * l'interrupteur de l'ecran recevrait une valeur absente.
 */
async function load(repos: Repositories): Promise<ShoppingSession | null> {
  const session = await repos.settings.getJson<ShoppingSession | null>(KEY, null)
  if (session === null) return null
  return { ...session, items: session.items.map((item) => ({ ...item, aPeser: item.aPeser === true })) }
}

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

/**
 * Un article sans poids n'est admis que s'il est "a peser en caisse" : son
 * poids viendra du ticket. Tenue ici, le schema zod ne pouvant pas a la fois
 * porter ce raffinement et se laisser `omit`.
 */
function articleValide<T extends { quantityG: number | null; aPeser: boolean }>(item: T): T {
  if (item.quantityG === null && !item.aPeser) {
    throw new HttpError(400, 'invalid_body', 'Indique la quantité mise dans le chariot.')
  }
  return item
}

/** Les articles encore sans poids : la validation des courses les attend. */
const sansPoids = (session: ShoppingSession) => session.items.filter((item) => item.quantityG === null)

route('POST', '/api/courses/items', async ({ repos, request }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')

  const item = articleValide(parseOrThrow(sessionItemWriteSchema, await readJson(request)))

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

  const patch = articleValide(parseOrThrow(sessionItemWriteSchema, await readJson(request)))
  const next: ShoppingSession = {
    ...session,
    items: session.items.map((item) => (item.id === id ? { ...item, ...patch, id } : item)),
  }

  await repos.settings.setJson(KEY, next)
  return json(await present(repos, next))
})

/** Un ticket est plus grand qu'une etiquette : pleine definition du telephone. */
const TICKET_MAX_OCTETS = 6 * 1024 * 1024

/**
 * Lire le ticket de caisse contre le chariot (shared/src/ticket.ts).
 *
 * Le vrac pese en caisse n'a ni poids ni prix avant le ticket : le modele
 * recoit la photo ET la liste numerotee du chariot, et rend pour chaque article
 * le poids et le prix de la ligne qui le paie. RIEN N'EST ECRIT : c'est une
 * proposition, que l'ecran fait relire avant `PATCH /api/courses/items`. Un
 * long ticket se lit en plusieurs photos, l'ecran fusionne.
 */
route('POST', '/api/courses/ticket', async ({ repos, request, env }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')
  if (session.items.length === 0) {
    throw new HttpError(422, 'empty_session', 'Le chariot est vide : rien à rapprocher du ticket.')
  }
  const cle = cleClaude(env)
  const image = await imageDuCorps(request, TICKET_MAX_OCTETS)
  await compterAppel(repos)

  const articles: TicketArticle[] = session.items.map((item) => ({
    id: item.id,
    name: item.name,
    brand: item.brand,
    quantityG: item.quantityG,
    priceEur: item.priceEur,
    aPeser: item.aPeser,
  }))
  const sortie = await demanderOutil(cle, [image, { type: 'text', text: ticketQuestion(articles) }], TICKET_TOOL, 3000)
  return json(interpretTicket(sortie, articles))
})

const lignesTicketSchema = z.object({
  lignes: z
    .array(
      z.object({
        id: z.string().min(1),
        quantityG: z.number().positive().max(20_000).nullable(),
        priceEur: z.string().regex(/^\d{1,3}\.\d{2}$/).nullable(),
      }),
    )
    .max(200),
})

/**
 * Appliquer ce que la personne a retenu du ticket, en UNE ecriture de la
 * session : trente PUT a la suite feraient trente aller-retours depuis un
 * magasin au reseau incertain. Un article qui recoit son poids n'est plus
 * "a peser".
 */
route('PATCH', '/api/courses/items', async ({ repos, request }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')
  const { lignes } = parseOrThrow(lignesTicketSchema, await readJson(request))
  const parId = new Map(lignes.map((ligne) => [ligne.id, ligne]))

  const next: ShoppingSession = {
    ...session,
    items: session.items.map((item) => {
      const ligne = parId.get(item.id)
      if (ligne === undefined) return item
      const quantityG = ligne.quantityG ?? item.quantityG
      return {
        ...item,
        quantityG,
        priceEur: ligne.priceEur ?? item.priceEur,
        aPeser: quantityG === null ? item.aPeser : false,
      }
    }),
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
route('POST', '/api/courses/commit', async ({ repos, env, user, waitUntil }) => {
  const session = await load(repos)
  if (session === null) throw notFound('Aucune session de courses en cours.')
  if (session.items.length === 0) {
    throw new HttpError(422, 'empty_session', 'Ce chariot est vide : il n’y a rien à enregistrer.')
  }
  // Un lot du frigo a toujours une masse : le vrac pese en caisse doit avoir
  // recu son poids (ticket, ou saisie) avant que les courses deviennent du
  // stock. Le refus nomme les articles, pour qu'on sache lesquels completer.
  const attente = sansPoids(session)
  if (attente.length > 0) {
    throw new HttpError(
      422,
      'a_peser',
      `${attente.length === 1 ? 'Un article attend son poids' : `${attente.length} articles attendent leur poids`} : ${attente
        .map((item) => item.name)
        .join(', ')}. Lis le ticket, ou saisis-le dans l’article.`,
    )
  }

  // Le jour A PARIS : `toISOString()` donnait la veille aux courses validees
  // entre minuit et deux heures, l'ete.
  const today = parisClock(new Date()).day
  let created = 0
  // Les lots crees, pour que le bilan propose de les ranger tout de suite.
  const stockedIds: number[] = []
  let stocked = 0
  let priced = 0
  const ingredientIds: number[] = []
  // Les fiches creees ici, completees (rayon, poids cuit, saison) apres la reponse.
  const aCompleter: ProduitACompleter[] = []

  for (const item of session.items) {
    // Garanti par le refus plus haut ; le test rend la masse lisible au typage.
    const quantiteG = item.quantityG
    if (quantiteG === null) continue
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
          aCompleter.push({ id: ingredientId, nom: item.name, marque: item.brand })
        }
      }
    }

    ingredientIds.push(ingredientId)

    /*
     * 2. Le lot, SANS LIEU, et avec la date SEULEMENT si on l'a lue.
     *
     * L'application ne sait pas ou l'on rangera ce paquet, et elle ne le
     * devinera pas : il attend dans l'onglet "A ranger", ou l'on lui donne sa
     * place. La date vient de l'emballage, saisie en magasin ou plus tard en
     * rangeant. Jamais devinee : personne ne publie de duree de conservation
     * par produit, et une date inventee serait crue.
     */
    const lotId = await repos.pantry.add({
      ingredientId,
      quantityG: quantiteG,
      expiryDate: item.expiryDate,
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
        quantityG: quantiteG,
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

  // 6. Les fiches nees de ce chariot recoivent rayon, poids cuit et saison,
  //    apres la reponse.
  await completerEnArrierePlan({ env, repos, waitUntil }, aCompleter)

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
