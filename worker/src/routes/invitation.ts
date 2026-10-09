/**
 * Invitations : poser son mot de passe sur un compte cree par l'administration.
 *
 * Ces deux routes sont PUBLIQUES — voir `PUBLIC_ROUTES` dans index.ts. Elles le
 * doivent : leur destinataire n'a, par definition, pas encore de session.
 *
 * C'est la SEULE chose que la console d'administration ajoute au serveur
 * deploye. Tout le reste de l'administration vit sur la machine de
 * l'administrateur et n'est jamais mis en ligne (voir scripts/admin/serveur.mjs).
 * Ces routes sont donc volontairement etroites : elles ne listent rien, ne
 * creent aucun compte, et ne peuvent rien faire sans un jeton de 256 bits.
 *
 * ---------------------------------------------------------------------------
 * LE JETON EST DANS LE CORPS, JAMAIS DANS L'URL
 * ---------------------------------------------------------------------------
 * Le lien d'invitation porte forcement le jeton dans son adresse — c'est ce
 * qu'on colle dans un message. Mais l'appel d'API, lui, n'a aucune raison de
 * l'y remettre : une chaine de requete se retrouve dans les journaux d'acces,
 * les rapports d'erreur et l'historique du navigateur. D'ou deux POST a
 * chemin fixe plutot qu'un `GET /api/invitation/:jeton`.
 *
 * Le chemin fixe a un second merite : `PUBLIC_ROUTES` compare des chemins
 * exacts. Une route a segment variable aurait demande d'assouplir la garde
 * d'authentification, c'est-a-dire d'y ouvrir une correspondance approximative
 * pour le confort d'un seul appel.
 */

import { hashPassword, MIN_PASSWORD_LENGTH } from '@prandia/shared'

import { issueSession } from '../auth.js'
import { badRequest, HttpError, json, readJson, route } from '../http.js'

const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Empreinte du jeton presente.
 *
 * SHA-256 et non PBKDF2 : le jeton fait 256 bits tires au hasard, il n'y a
 * rien a deviner. Le raisonnement complet est en tete de
 * migrations/0017_invitations.sql.
 */
const empreinte = async (jeton: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', encoder.encode(jeton)))

interface LigneInvitation {
  token_hash: string
  user_id: number
  expires_at: string
  used_at: string | null
  kind: string
  username: string
  display_name: string
  cuisine: string | null
}

/** Le jeton d'un corps de requete, valide de forme. */
function jetonDe(corps: unknown): string {
  const { jeton } = (corps ?? {}) as { jeton?: unknown }
  // 64 caracteres hexadecimaux : exactement ce que produit la console. Refuser
  // ici evite d'aller interroger la base pour une valeur qui ne peut pas
  // exister.
  if (typeof jeton !== 'string' || !/^[0-9a-f]{64}$/.test(jeton)) {
    throw badRequest('Ce lien est incomplet ou mal recopié.')
  }
  return jeton
}

async function lire(db: D1Database, jeton: string): Promise<LigneInvitation> {
  const ligne = await db
    .prepare(
      `SELECT i.token_hash, i.user_id, i.expires_at, i.used_at, i.kind,
              u.username, u.display_name, h.name AS cuisine
         FROM user_invite i
         JOIN user u ON u.id = i.user_id
         LEFT JOIN household h ON h.id = u.household_id
        WHERE i.token_hash = ?`,
    )
    .bind(await empreinte(jeton))
    .first<LigneInvitation>()

  // Un seul et meme message pour « inconnu », « deja utilise » et « perime » :
  // les distinguer apprendrait a un curieux qu'un jeton a existe.
  if (!ligne || ligne.used_at !== null || ligne.expires_at <= new Date().toISOString()) {
    throw new HttpError(
      410,
      'invitation_invalide',
      "Cette invitation n'est plus valable. Demande-en une nouvelle.",
    )
  }
  return ligne
}

/** Ce que l'ecran affiche avant de demander un mot de passe. */
route('POST', '/api/invitation', async ({ env, request }) => {
  const ligne = await lire(env.DB, jetonDe(await readJson(request)))
  return json({
    username: ligne.username,
    displayName: ligne.display_name,
    cuisine: ligne.cuisine,
    // Creation ou reinitialisation : l'ecran ne dit pas la meme chose.
    genre: ligne.kind === 'reinitialisation' ? 'reinitialisation' : 'creation',
  })
})

route('POST', '/api/invitation/mot-de-passe', async ({ env, request }) => {
  const corps = (await readJson(request)) ?? {}
  const jeton = jetonDe(corps)
  const { motDePasse } = corps as { motDePasse?: unknown }

  if (typeof motDePasse !== 'string' || motDePasse.length < MIN_PASSWORD_LENGTH) {
    throw badRequest(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`)
  }

  const ligne = await lire(env.DB, jeton)

  /*
   * ON RESERVE L'INVITATION AVANT DE POSER LE MOT DE PASSE.
   *
   * `used_at IS NULL` dans le WHERE fait de cette mise a jour une prise de
   * verrou : de deux requetes simultanees portant le meme jeton, une seule
   * verra `changes = 1`. L'ordre inverse — poser puis marquer — laisserait les
   * deux aboutir, et la seconde ecraserait le mot de passe choisi par la
   * premiere.
   */
  const prise = await env.DB.prepare(
    `UPDATE user_invite SET used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE token_hash = ? AND used_at IS NULL`,
  )
    .bind(ligne.token_hash)
    .run()

  if ((prise.meta?.changes ?? 0) !== 1) {
    throw new HttpError(410, 'invitation_invalide', 'Cette invitation vient déjà d’être utilisée.')
  }

  const { hash, salt, iterations } = await hashPassword(motDePasse)

  await env.DB.prepare(
    `UPDATE user SET password_hash = ?, password_salt = ?, iterations = ?, is_active = 1
      WHERE id = ?`,
  )
    .bind(hash, salt, iterations, ligne.user_id)
    .run()

  /*
   * On ouvre la session dans la foulee.
   *
   * La personne vient de prouver qu'elle detient le jeton ET de choisir le
   * mot de passe : lui redemander de le saisir n'apporte aucune garantie, et
   * ajoute un ecran sur un telephone, juste apres une saisie de mot de passe.
   */
  return new Response(
    JSON.stringify({
      user: {
        id: ligne.user_id,
        username: ligne.username,
        displayName: ligne.display_name,
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': await issueSession(env.DB, ligne.user_id),
      },
    },
  )
})
