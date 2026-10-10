/**
 * Plomberie HTTP partagee par toutes les routes.
 *
 * Vit a part pour une raison pratique : chaque groupe de routes
 * (`routes/ingredients.ts`, `routes/recipes.ts`, ...) importe d'ici et
 * s'enregistre tout seul. Sans ce fichier, tout devrait transiter par
 * `index.ts`, qui redeviendrait le goulot qu'il etait.
 */

import type { Repositories } from './repos/index.js'
import type { SessionUser } from './auth.js'

export interface Env {
  readonly DB: D1Database
  readonly OFF_USER_AGENT: string
  readonly ENVIRONMENT: string
  /**
   * '1' ouvre l'application sans mot de passe. DEVELOPPEMENT LOCAL UNIQUEMENT.
   *
   * Optionnelle, et elle doit le rester : elle ne vient que de `.dev.vars`,
   * absent de tout deploiement. Voir la note de `devUser()` dans auth.ts pour
   * les deux verrous qui la rendent inatteignable en production.
   */
  readonly DEV_AUTOLOGIN?: string | undefined
  /**
   * Fichiers statiques du site, fournis par Pages en mode avance.
   *
   * Des lors qu'un `_worker.js` est present, Pages ne sert plus rien tout
   * seul : ce Worker recoit CHAQUE requete et doit deleguer explicitement
   * ce qui n'est pas de l'API. Oublier cette delegation rend le site entier
   * inaccessible, y compris index.html.
   */
  readonly ASSETS: { fetch: (request: Request) => Promise<Response> }
  /**
   * Stockage d'objets : photos de recettes, et plus tard les PDF de tickets.
   *
   * Bucket `prandia-media`, zone WEUR comme D1. Les cles suivent la
   * convention deja inscrite dans le schema : `recipes/<id>.jpg`
   * (migrations/0001_core.sql:72).
   */
  readonly MEDIA: R2Bucket
  /**
   * Notifications (Web Push). La cle PUBLIQUE et le sujet sont dans
   * `wrangler.toml` ; la cle PRIVEE est un secret pose par
   * `wrangler pages secret put`, jamais dans le depot. Absente : les
   * notifications sont annoncees indisponibles, rien ne part. Voir push.ts.
   */
  readonly VAPID_PUBLIC_KEY?: string | undefined
  readonly VAPID_SUBJECT?: string | undefined
  readonly VAPID_PRIVATE_KEY?: string | undefined
}

// ---------------------------------------------------------------------------
// Reponses
// ---------------------------------------------------------------------------

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Aucune reponse d'API n'est mise en cache : afficher un prix perime
      // comme s'il etait frais serait pire qu'afficher une erreur.
      'cache-control': 'no-store',
    },
  })

/**
 * Les messages sont en francais : ils remontent tels quels a l'ecran.
 *
 * `extra` sert a rendre une erreur ACTIONNABLE. « Ce nom existe déjà » laisse
 * l'utilisateur devant un mur ; le meme message accompagne de l'identifiant du
 * doublon permet d'offrir « Ouvrir la fiche existante ».
 */
export const fail = (
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Response => json({ error: { code, message, ...extra } }, status)

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, code = 'invalid_body') => new HttpError(400, code, message)
/**
 * La personne connectee, ou un 401.
 *
 * `RouteContext.user` est nullable parce que quelques routes sont publiques.
 * Les routes qui ont besoin d'une IDENTITE — et non seulement d'un foyer —
 * passent par ici : cela evite l'assertion non-null, qui aurait fait planter en
 * 500 le jour ou une de ces routes se retrouverait hors du garde d'authent.
 */
export function requireUser(user: SessionUser | null): SessionUser {
  if (user === null) {
    throw new HttpError(401, 'unauthenticated', 'Session expirée. Reconnecte-toi.')
  }
  return user
}

export const notFound = (message: string) => new HttpError(404, 'not_found', message)

export const badWeek = (value: string) =>
  new HttpError(400, 'invalid_week', `Semaine « ${value} » invalide. Format attendu : 2026-W18.`)

/** Identifiant de chemin : on refuse tout ce qui n'est pas un entier positif. */
export function intParam(params: Record<string, string>, key: string): number {
  const value = Number(params[key])
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, 'invalid_id', 'Identifiant invalide.')
  }
  return value
}

/**
 * Corps JSON de la requete.
 *
 * Le `catch` est indispensable : un corps tronque par une coupure reseau en
 * plein magasin ferait autrement remonter une erreur interne opaque.
 */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw badRequest('Corps de requête illisible.')
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Forme minimale d'un schema Zod — evite d'importer zod ici juste pour un type. */
interface Parser<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown }
}

/**
 * Valide un corps contre un schema Zod et transforme l'echec en 422.
 *
 * Les messages de `shared/src/models.ts` sont rediges pour l'utilisateur
 * final : on les remonte tels quels plutot que de les remplacer par un
 * « donnees invalides » generique qui n'aide personne a corriger sa saisie.
 */
export function parseOrThrow<T>(schema: Parser<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data

  const issues = (result.error as { issues?: Array<{ path: unknown[]; message: string }> }).issues ?? []
  const message = issues.length > 0
    ? issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')} : ${i.message}` : i.message)).join(' ')
    : 'Données invalides.'

  throw new HttpError(422, 'validation', message)
}

// ---------------------------------------------------------------------------
// Routeur
// ---------------------------------------------------------------------------

export interface HandlerContext {
  readonly repos: Repositories
  readonly env: Env
  readonly url: URL
  readonly params: Record<string, string>
  readonly request: Request
  /** `null` uniquement sur les routes publiques. */
  readonly user: SessionUser | null
}

export type Handler = (ctx: HandlerContext) => Promise<Response>

export interface Route {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: readonly string[]
  readonly handler: Handler
}

/**
 * Table globale, alimentee a l'import de chaque module de routes.
 *
 * Un registre mutable partage se defend mal en general, mais ici les modules
 * sont importes une seule fois au demarrage de l'isolat, avant toute requete :
 * la table est figee des que le premier `fetch` arrive.
 */
export const routes: Route[] = []

/** `/api/shopping/:week` -> expression reguliere + noms de parametres. */
export function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = []
  const pattern = new RegExp(
    '^' +
      path.replace(/:(\w+)/g, (_, key: string) => {
        keys.push(key)
        return '([^/]+)'
      }) +
      '/?$',
  )
  routes.push({ method, pattern, keys, handler })
}

/**
 * Cherche la route correspondante.
 *
 * Le chemin est teste avant la methode : on distingue ainsi « adresse
 * inconnue » (404) de « mauvais verbe sur une adresse connue » (405), ce qui
 * change tout quand on debogue un appel depuis le telephone.
 */
export function match(
  pathname: string,
  method: string,
): { route: Route; params: Record<string, string> } | 'method_not_allowed' | null {
  let pathMatched = false

  for (const r of routes) {
    const m = r.pattern.exec(pathname)
    if (!m) continue
    pathMatched = true
    if (r.method !== method) continue

    const params: Record<string, string> = {}
    r.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1] ?? '')
    })
    return { route: r, params }
  }

  return pathMatched ? 'method_not_allowed' : null
}
