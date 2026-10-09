/**
 * Bibliotheque d'icones personnelles.
 *
 * CE FICHIER EST LA FRONTIERE DE SECURITE. C'est le seul chemin d'ecriture vers
 * `custom_icon.markup`, et donc le seul endroit qui garantisse que ce qui sera
 * un jour injecte par `dangerouslySetInnerHTML` a bien ete assaini.
 *
 * Le navigateur assainit lui aussi, pour l'apercu — mais sa sortie n'est JAMAIS
 * ce qu'on enregistre. On repart systematiquement du texte brut recu et on
 * l'assainit ici : un client modifie, ou un simple `curl`, enverrait sinon ce
 * qu'il veut.
 */

import { sanitizeSvg } from '@prandia/shared'
import { z } from 'zod'

import { logActivity } from '../activity.js'
import { HttpError, intParam, json, notFound, parseOrThrow, readJson, route } from '../http.js'

/**
 * `svg` est le texte BRUT colle par l'utilisateur, pas du balisage pre-assaini.
 * La borne haute evite qu'un fichier de plusieurs mega-octets — une carte
 * vectorielle prise pour une icone — traverse la base et la reponse.
 */
const iconWriteSchema = z.object({
  name: z.string().trim().min(1, 'Donne un nom à cette icône.').max(60),
  svg: z.string().min(1, 'Colle le code SVG de l’icône.').max(64_000, 'Ce SVG est trop lourd (64 ko maximum).'),
  keepColors: z.boolean().default(false),
})

route('GET', '/api/icons', async ({ repos }) => json({ items: await repos.icons.list() }))

route('POST', '/api/icons', async ({ repos, request, env, user }) => {
  const payload = parseOrThrow(iconWriteSchema, await readJson(request))

  const { markup, viewBox, removed } = sanitizeSvg(payload.svg)
  if (markup === '') {
    throw new HttpError(
      422,
      'empty_svg',
      "Rien de dessinable n'a survécu au filtrage. Colle le contenu d'un fichier .svg, pas une image ni un lien.",
    )
  }

  if (await repos.icons.findByName(payload.name)) {
    throw new HttpError(409, 'duplicate_name', `Une icône « ${payload.name} » existe déjà.`)
  }

  const id = await repos.icons.create(payload.name, markup, viewBox, payload.keepColors)
  await logActivity(env.DB, user, { action: 'create', entity: 'icon', entityId: id, label: payload.name })

  // `removed` remonte au client pour qu'il puisse DIRE ce qui a saute. Une
  // icone amputee en silence donnerait un dessin faux sans explication.
  return json({ id, name: payload.name, markup, viewBox, keepColors: payload.keepColors, removed }, 201)
})

route('DELETE', '/api/icons/:id', async ({ repos, params, env, user }) => {
  const id = intParam(params, 'id')
  const name = await repos.icons.nameOf(id)
  if (name === null) throw notFound('Icône introuvable.')

  // Les rayons qui s'y referaient ne sont PAS corriges : `makeRayonStyle`
  // retombe sur l'icone deduite du nom quand la reference ne resout plus. Les
  // reecrire ici obligerait a une seconde ecriture sur une table voisine pour
  // un resultat visuellement identique.
  await repos.icons.remove(id)
  await logActivity(env.DB, user, { action: 'delete', entity: 'icon', entityId: id, label: name })
  return json({ id })
})
