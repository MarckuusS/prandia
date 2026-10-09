/**
 * Profil alimentaire et sportif.
 *
 * L'identifiant de la personne vient de `user.id`, donc du cookie signe, et
 * JAMAIS du corps de la requete. C'est ce qui garantit qu'on ne peut lire ni
 * ecrire le profil de quelqu'un d'autre : il n'existe aucun parametre par
 * lequel le demander.
 *
 * Le depot est construit ici plutot que dans `Repositories` parce qu'il est le
 * seul du projet cloisonne par PERSONNE. L'agregat commun ne connait que le
 * foyer ; y glisser une exception ferait croire que les autres depots sont
 * cloisonnes de la meme facon.
 */

import { profileWriteSchema } from '@prandia/shared'

import { json, parseOrThrow, readJson, requireUser, route } from '../http.js'
import { ProfileRepo } from '../repos/profile.js'

route('GET', '/api/profile', async ({ env, user }) => {
  const me = requireUser(user)
  return json(await new ProfileRepo(env.DB, me.id, me.householdId).get())
})

route('PUT', '/api/profile', async ({ env, user, request }) => {
  const me = requireUser(user)
  const payload = parseOrThrow(profileWriteSchema, await readJson(request))

  // Les cibles ne sont PAS enregistrees : elles se recalculent du profil a
  // chaque lecture, par la meme fonction des deux cotes du reseau. Les stocker
  // aurait cree une seconde verite, a reconcilier a chaque changement de poids.
  const repo = new ProfileRepo(env.DB, me.id, me.householdId)
  await repo.save(
    {
      sex: payload.sex,
      birthYear: payload.birthYear,
      heightCm: payload.heightCm,
      weightKg: payload.weightKg,
      activity: payload.activity,
      goal: payload.goal,
      split: payload.split,
      splitProteins: payload.splitProteins,
      splitCarbs: payload.splitCarbs,
      splitFats: payload.splitFats,
      targetWeightKg: payload.targetWeightKg,
      paceKgPerWeek: payload.paceKgPerWeek,
      kcalTarget: payload.kcalTarget,
      waistCm: payload.waistCm,
    },
    payload.eaters,
  )

  // Pas de journal d'activite : le profil n'est pas une donnee de la cuisine,
  // et « Marius a modifié son poids » n'a rien a faire sous les yeux de
  // l'autre membre du foyer.
  return json(await repo.get())
})
