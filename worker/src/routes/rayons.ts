/**
 * Rayons de magasin, geres par l'utilisateur.
 *
 * Le lien entre un ingredient et son rayon est le NOM et non une cle etrangere
 * (voir `repos/rayons.ts`). Toute la subtilite de ces routes tient la : un
 * renommage doit se repercuter, une suppression doit nettoyer, et un doublon
 * de nom doit etre refuse AVANT d'atteindre la base, sinon l'utilisateur
 * recevrait « UNIQUE constraint failed » en pleine figure.
 */

import { z } from 'zod'
import { rayonWriteSchema } from '@prandia/shared'

import { logActivity } from '../activity.js'
import { HttpError, intParam, json, notFound, parseOrThrow, readJson, route } from '../http.js'
import { rayonCree, refuserRayon, suggestionsDeRayons } from '../suggestionRayons.js'

route('GET', '/api/rayons', async ({ repos }) => json({ items: await repos.rayons.list() }))

// ------------------------------------------------ rayons proposes par Savarin

/** Les idees de Savarin pour cette cuisine, souvent relues de sa memoire (voir suggestionRayons.ts). */
route('GET', '/api/rayons/suggestions', async ({ repos, env }) => json(await suggestionsDeRayons(env, repos)))

const nomSuggestion = z.string().trim().min(1, 'Le nom du rayon ne peut pas être vide.').max(60)

const creerSchema = z.object({
  /** Le nom propose, pour l'oublier : la personne a pu le retoucher. */
  proposition: z.string().max(60),
  nom: nomSuggestion,
  // D1 refuse plus de 100 parametres par requete.
  produits: z.array(z.number().int().positive()).min(1).max(90),
})

route('POST', '/api/rayons/suggestions/creer', async ({ repos, request, env, user }) => {
  const { proposition, nom, produits } = parseOrThrow(creerSchema, await readJson(request))
  const existant = await repos.rayons.findByName(nom)
  if (existant) throw new HttpError(409, 'duplicate_name', `Le rayon "${existant.name}" existe déjà.`)

  const ordinal = (await repos.rayons.maxOrdinal()) + 1
  const { id, ranges } = await repos.rayons.creerAvecProduits(nom, ordinal, [...new Set(produits)])
  await rayonCree(repos, proposition)

  await logActivity(env.DB, user, { action: 'create', entity: 'rayon', entityId: id, label: `${nom} (proposé par Savarin)` })
  return json({ id, nom, ranges }, 201)
})

route('POST', '/api/rayons/suggestions/refuser', async ({ repos, request }) => {
  const { nom } = parseOrThrow(z.object({ nom: nomSuggestion }), await readJson(request))
  await refuserRayon(repos, nom)
  return json({ nom })
})

route('POST', '/api/rayons', async ({ repos, request, env, user }) => {
  const payload = parseOrThrow(rayonWriteSchema, await readJson(request))
  const name = payload.name.trim()

  const existing = await repos.rayons.findByName(name)
  if (existing) {
    throw new HttpError(409, 'duplicate_name', `Le rayon « ${existing.name} » existe déjà.`)
  }

  // Un rayon cree arrive EN DERNIER, pas en tete : l'ordre est celui du magasin
  // qu'on parcourt, et rien ne dit qu'un nouveau rayon se visite en premier.
  const ordinal = (await repos.rayons.maxOrdinal()) + 1
  const id = await repos.rayons.create(name, payload.icon, payload.colorHex, ordinal)

  await logActivity(env.DB, user, { action: 'create', entity: 'rayon', entityId: id, label: name })
  return json({ id, name, icon: payload.icon, colorHex: payload.colorHex, ordinal, ingredientCount: 0 }, 201)
})

route('PUT', '/api/rayons/:id', async ({ repos, params, request, env, user }) => {
  const id = intParam(params, 'id')
  const payload = parseOrThrow(rayonWriteSchema, await readJson(request))
  const name = payload.name.trim()

  const previousName = await repos.rayons.nameOf(id)
  if (previousName === null) throw notFound('Rayon introuvable.')

  // Le doublon ne se juge que si le nom CHANGE : renvoyer un rayon a
  // l'identique pour changer sa seule couleur ne doit pas se heurter a
  // lui-meme.
  if (name !== previousName) {
    const clash = await repos.rayons.findByName(name)
    if (clash) throw new HttpError(409, 'duplicate_name', `Le rayon « ${clash.name} » existe déjà.`)
  }

  await repos.rayons.update(id, previousName, {
    name,
    icon: payload.icon,
    colorHex: payload.colorHex,
    ordinal: payload.ordinal,
  })

  await logActivity(env.DB, user, {
    action: 'update',
    entity: 'rayon',
    entityId: id,
    label: name === previousName ? name : `${previousName} → ${name}`,
  })
  return json({ id, name, icon: payload.icon, colorHex: payload.colorHex, ordinal: payload.ordinal })
})

route('DELETE', '/api/rayons/:id', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  const name = await repos.rayons.nameOf(id)
  if (name === null) throw notFound('Rayon introuvable.')

  // Aucun ingredient n'est supprime : ils retombent sur « sans rayon ». Le
  // nombre part dans le journal, parce que c'est la seule trace qui restera de
  // ce qu'une suppression a deplace.
  const before = (await repos.rayons.list()).find((r) => r.id === id)?.ingredientCount ?? 0
  await repos.rayons.remove(id, name)

  await logActivity(env.DB, user, {
    action: 'delete',
    entity: 'rayon',
    entityId: id,
    label: before === 0 ? name : `${name} (${before} ingrédient${before > 1 ? 's' : ''} sans rayon)`,
  })
  return json({ id, movedToNoRayon: before })
})
