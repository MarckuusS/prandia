/**
 * Authentification multi-identifiants, donnees communes.
 *
 * Chacun son compte et son mot de passe, revocable independamment — mais une
 * seule cuisine. Aucun filtrage par proprietaire : voir la note en tete de
 * migrations/0004_users_and_activity.sql pour pourquoi c'est un choix de
 * surete et pas une facilite.
 *
 * ---------------------------------------------------------------------------
 * Deux primitives, deux usages a ne pas confondre
 * ---------------------------------------------------------------------------
 *   - Stocker un mot de passe -> PBKDF2, LENT et sale (shared/password.ts).
 *   - Signer un cookie        -> HMAC-SHA256, rapide. C'est ce fichier.
 *
 * Le cookie porte `userId.expiration.signature`. Sans le secret de session on
 * ne peut ni en forger un, ni prolonger celui qu'on a, ni changer d'identite —
 * la signature couvre les deux champs.
 *
 * Il est `HttpOnly` (invisible au JavaScript, donc hors de portee d'une XSS),
 * `Secure` et `SameSite=Strict`.
 *
 * ---------------------------------------------------------------------------
 * Le secret de session
 * ---------------------------------------------------------------------------
 * Genere aleatoirement a la premiere utilisation et range dans `app_setting`,
 * plutot que d'etre un secret Cloudflare de plus a configurer a la main.
 *
 * Ce n'est pas un affaiblissement : qui sait lire cette table sait deja lire
 * les recettes, les prix et le frigo. Le mettre ailleurs ne protegerait rien
 * de plus, et ajouterait une etape ou se tromper.
 *
 * Le supprimer deconnecte tout le monde — c'est le bouton d'urgence.
 *
 * ---------------------------------------------------------------------------
 * Une exception, et une seule : le poste de developpement
 * ---------------------------------------------------------------------------
 * En bas de ce fichier, `devUser()` ouvre l'application SANS mot de passe.
 * C'est une porte, elle est assumee, et tout ce qui la rend inatteignable en
 * production est explique la-bas. Lire cette section avant d'y toucher.
 */

import { DEFAULT_ITERATIONS, verifyPassword, type PasswordRecord } from '@prandia/shared'

const COOKIE_NAME = 'lr_session'
const SESSION_DAYS = 90
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000

const MAX_FAILURES = 10
const LOCKOUT_MS = 15 * 60 * 1000

/**
 * Foyer 0 : les reglages du SERVEUR, pas ceux d'une cuisine.
 *
 * `app_setting` a pour cle primaire (household_id, key) depuis la migration
 * 0005. Le secret de signature et le compteur d'echecs y vivent sous le foyer
 * 0, qui n'existe pas dans `household`. Un secret par cuisine n'aurait aucun
 * sens : c'est justement lui qui permet de savoir DE QUELLE cuisine releve la
 * requete.
 */
const GLOBAL_HOUSEHOLD = 0

const SESSION_SECRET_KEY = 'auth.session_secret'

const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

export interface SessionUser {
  readonly id: number
  readonly username: string
  readonly displayName: string
  /**
   * Cuisine a laquelle ce compte donne acces.
   *
   * C'est la SEULE source du cloisonnement : elle est lue ici, a
   * l'authentification, et transmise au constructeur des repositories. Aucune
   * route ne la choisit, aucun corps de requete ne peut l'influencer — sans
   * quoi il suffirait d'envoyer un autre numero pour lire la cuisine du voisin.
   */
  readonly householdId: number
}

// ---------------------------------------------------------------------------
// Secret de session
// ---------------------------------------------------------------------------

async function sessionSecret(db: D1Database): Promise<string> {
  const row = await db
    .prepare('SELECT value_json FROM app_setting WHERE household_id = ? AND key = ?')
    .bind(GLOBAL_HOUSEHOLD, SESSION_SECRET_KEY)
    .first<{ value_json: string }>()

  if (row) {
    try {
      const parsed = JSON.parse(row.value_json) as { secret?: string }
      if (typeof parsed.secret === 'string' && parsed.secret.length >= 32) return parsed.secret
    } catch {
      /* valeur corrompue : on en regenere une, ce qui deconnecte tout le monde */
    }
  }

  const secret = toHex(crypto.getRandomValues(new Uint8Array(32)).buffer)
  await db
    .prepare(
      `INSERT INTO app_setting (household_id, key, value_json, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(household_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(GLOBAL_HOUSEHOLD, SESSION_SECRET_KEY, JSON.stringify({ secret }))
    .run()
  return secret
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

const buildCookie = (value: string, maxAgeSeconds: number): string =>
  [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ')

export async function issueSession(db: D1Database, userId: number): Promise<string> {
  const payload = `${userId}.${Date.now() + SESSION_MS}`
  const signature = await sign(payload, await sessionSecret(db))
  return buildCookie(`${payload}.${signature}`, Math.floor(SESSION_MS / 1000))
}

export const clearSessionCookie = (): string => buildCookie('', 0)

/**
 * Rend l'utilisateur de la requete, ou `null`.
 *
 * Le compte est relu en base a chaque appel : desactiver quelqu'un le coupe
 * immediatement, sans attendre l'expiration de son cookie.
 */
export async function currentUser(request: Request, db: D1Database): Promise<SessionUser | null> {
  const raw = readCookie(request, COOKIE_NAME)
  if (!raw) return null

  const parts = raw.split('.')
  if (parts.length !== 3) return null
  const [userIdRaw, expiresRaw, signature] = parts as [string, string, string]

  const expiresAt = Number(expiresRaw)
  const userId = Number(userIdRaw)
  if (!Number.isInteger(userId) || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null

  const expected = await sign(`${userIdRaw}.${expiresRaw}`, await sessionSecret(db))
  if (!timingSafeEqual(signature, expected)) return null

  const row = await db
    .prepare('SELECT id, username, display_name, household_id FROM user WHERE id = ? AND is_active = 1')
    .bind(userId)
    .first<{ id: number; username: string; display_name: string; household_id: number }>()

  return row
    ? {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        householdId: row.household_id,
      }
    : null
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------

export async function authenticate(
  db: D1Database,
  username: string,
  password: string,
): Promise<SessionUser | null> {
  const row = await db
    .prepare(
      `SELECT id, username, display_name, household_id, password_hash, password_salt, iterations
       FROM user WHERE username = ? AND is_active = 1`,
    )
    .bind(username.trim().toLowerCase())
    .first<{
      id: number
      username: string
      display_name: string
      household_id: number
      password_hash: string
      password_salt: string
      iterations: number
    }>()

  // Meme sur un utilisateur inconnu, on derive quand meme un hash : sans cela,
  // la reponse serait bien plus rapide et permettrait d'enumerer les comptes
  // existants au chronometre.
  const record: PasswordRecord = row
    ? { hash: row.password_hash, salt: row.password_salt, iterations: row.iterations }
    : { hash: '00'.repeat(32), salt: '00'.repeat(16), iterations: DEFAULT_ITERATIONS }

  const ok = await verifyPassword(password, record)
  if (!row || !ok) return null

  await db
    .prepare("UPDATE user SET last_login_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
    .bind(row.id)
    .run()

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    householdId: row.household_id,
  }
}

export async function hasAnyUser(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM user WHERE is_active = 1').first<{ c: number }>()
  return (row?.c ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Limitation des tentatives
// ---------------------------------------------------------------------------

interface FailureState {
  count: number
  lockedUntil: number
}

const FAILURE_KEY = 'auth.failures'

async function readFailures(db: D1Database): Promise<FailureState> {
  const row = await db
    .prepare('SELECT value_json FROM app_setting WHERE household_id = ? AND key = ?')
    .bind(GLOBAL_HOUSEHOLD, FAILURE_KEY)
    .first<{ value_json: string }>()
  if (!row) return { count: 0, lockedUntil: 0 }
  try {
    const parsed = JSON.parse(row.value_json) as Partial<FailureState>
    return { count: Number(parsed.count ?? 0), lockedUntil: Number(parsed.lockedUntil ?? 0) }
  } catch {
    return { count: 0, lockedUntil: 0 }
  }
}

async function writeFailures(db: D1Database, state: FailureState): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_setting (household_id, key, value_json, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(household_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .bind(GLOBAL_HOUSEHOLD, FAILURE_KEY, JSON.stringify(state))
    .run()
}

/** Secondes restantes avant de pouvoir reessayer, ou 0. */
export async function lockoutRemaining(db: D1Database): Promise<number> {
  const { lockedUntil } = await readFailures(db)
  return lockedUntil > Date.now() ? Math.ceil((lockedUntil - Date.now()) / 1000) : 0
}

export async function recordFailure(db: D1Database): Promise<void> {
  const state = await readFailures(db)
  const count = state.count + 1
  await writeFailures(db, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0 })
}

export const resetFailures = (db: D1Database): Promise<void> =>
  writeFailures(db, { count: 0, lockedUntil: 0 })

// ---------------------------------------------------------------------------
// Connexion automatique : POSTE DE DEVELOPPEMENT UNIQUEMENT
// ---------------------------------------------------------------------------
/**
 * Ouvre l'application sans mot de passe sur une machine de developpement.
 *
 * POURQUOI CETTE PORTE EXISTE. Un serveur local sert a regarder des ecrans,
 * pas a garder un secret : sa base ne contient que des donnees d'essai, et
 * elle est de toute facon lisible par qui s'assoit devant le clavier. L'ecran
 * de connexion n'y protegeait donc rien, mais il pouvait tout bloquer : il
 * suffisait d'oublier un mot de passe choisi une fois, ou de laisser un
 * compteur d'echecs a dix, pour ne plus pouvoir ouvrir sa propre maquette.
 *
 * ---------------------------------------------------------------------------
 * CE QUI LA REND INATTEIGNABLE EN PRODUCTION
 * ---------------------------------------------------------------------------
 * Deux conditions, et elles ne peuvent etre reunies que par un fichier qui
 * n'existe pas la-bas :
 *
 *   1. `DEV_AUTOLOGIN` vaut '1'. Cette variable n'est declaree NULLE PART
 *      ailleurs que dans `.dev.vars`, fichier lu par `wrangler dev` seul,
 *      jamais televerse, et ignore par git depuis toujours. Un test verifie
 *      qu'elle n'apparait pas dans `wrangler.toml`, seule voie par laquelle
 *      une variable atteint le deploiement.
 *
 *   2. `ENVIRONMENT` ne vaut pas 'production'. `wrangler.toml` la fixe
 *      justement a 'production' pour tout deploiement ; seul `.dev.vars`,
 *      qui a la priorite en local, peut la contredire.
 *
 * Deux verrous plutot qu'un : le premier serait deja suffisant, le second
 * fait qu'une variable ajoutee par megarde dans le tableau de bord Cloudflare
 * n'ouvre toujours rien.
 *
 * Le compte cree ici, faute de mieux, porte une empreinte ALEATOIRE : aucun
 * mot de passe ne peut y correspondre. S'il se retrouvait un jour dans une
 * base en ligne, il n'ouvrirait rien par l'ecran de connexion.
 */
export interface DevEnv {
  readonly ENVIRONMENT?: string | undefined
  readonly DEV_AUTOLOGIN?: string | undefined
}

/** Vrai seulement si les DEUX verrous sont ouverts. Voir la note ci-dessus. */
export const devLoginBypass = (env: DevEnv): boolean =>
  env.DEV_AUTOLOGIN === '1' && env.ENVIRONMENT !== 'production'

const DEV_USERNAME = 'dev'
const DEV_DISPLAY_NAME = 'Développement'

/** Le foyer 1 ("Ma cuisine") est cree par la migration 0005 : il existe toujours. */
const DEV_HOUSEHOLD = 1

const firstActiveUser = (db: D1Database): Promise<SessionUser | null> =>
  db
    .prepare(
      `SELECT id, username, display_name AS displayName, household_id AS householdId
       FROM user WHERE is_active = 1 ORDER BY id LIMIT 1`,
    )
    .first<SessionUser>()

/**
 * L'utilisateur a qui l'on ouvre d'office, ou `null` hors developpement.
 *
 * On reprend le PREMIER compte actif plutot que d'en imposer un : la base
 * locale porte deja les donnees d'essai de quelqu'un, et entrer sous une autre
 * identite montrerait une cuisine vide. Le compte dedie n'est cree que si la
 * base n'en a aucun : c'est ce qui supprime l'etape "choisis un mot de passe"
 * du premier lancement, celle qui pouvait echouer sans terminal.
 */
export async function devUser(env: DevEnv, db: D1Database): Promise<SessionUser | null> {
  if (!devLoginBypass(env)) return null

  const existing = await firstActiveUser(db)
  if (existing) return existing

  // ON CONFLICT DO NOTHING plutot qu'un simple INSERT : le navigateur ouvre
  // plusieurs requetes de front au chargement, et deux d'entre elles peuvent
  // constater l'absence de compte avant que la premiere ne l'ait cree.
  await db
    .prepare(
      `INSERT INTO user (username, display_name, password_hash, password_salt, iterations, household_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO NOTHING`,
    )
    .bind(
      DEV_USERNAME,
      DEV_DISPLAY_NAME,
      toHex(crypto.getRandomValues(new Uint8Array(32)).buffer),
      toHex(crypto.getRandomValues(new Uint8Array(16)).buffer),
      DEFAULT_ITERATIONS,
      DEV_HOUSEHOLD,
    )
    .run()

  return firstActiveUser(db)
}
