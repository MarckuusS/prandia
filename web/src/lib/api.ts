/**
 * Client HTTP de l'API.
 *
 * Meme origine que le front : les chemins sont toujours relatifs, jamais une
 * URL absolue. En developpement, le proxy Vite renvoie /api vers le Worker.
 *
 * La session vit dans un cookie `HttpOnly` : ce code ne la voit pas, ne la
 * stocke pas et n'a rien a lui faire. Il se contente de reconnaitre un 401
 * et de laisser l'application afficher l'ecran de connexion.
 */

export interface ApiErrorBody {
  /** Le serveur peut joindre des cles supplementaires, ex. `existingId` sur un 409. */
  readonly error: { readonly code: string; readonly message: string } & Record<string, unknown>
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /**
     * Ce que le serveur a joint au-dela du message.
     *
     * Sert a rendre l'erreur actionnable : un 409 `duplicate_name` porte
     * `existingId`, ce qui permet a l'ecran d'ouvrir la fiche en double au lieu
     * de laisser l'utilisateur la chercher.
     */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /** Vrai quand l'erreur vient du reseau, pas d'une reponse du serveur. */
  get isOffline(): boolean {
    return this.status === 0
  }

  /** Session absente ou expiree : il faut se reconnecter. */
  get isUnauthenticated(): boolean {
    return this.status === 401
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      // Le cookie de session part avec la requete. 'same-origin' est deja le
      // defaut, mais l'expliciter evite qu'un changement de configuration ne
      // casse silencieusement l'authentification.
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...init?.headers },
    })
  } catch {
    // fetch ne rejette que sur une panne reseau : le telephone est hors
    // couverture, ou le serveur est injoignable.
    throw new ApiError(0, 'network', 'Pas de connexion. Vérifie ton réseau.')
  }

  if (!response.ok) {
    let code = 'unknown'
    let message = `Erreur ${response.status}.`
    let extra: Record<string, unknown> = {}
    try {
      const body = (await response.json()) as Partial<ApiErrorBody>
      if (body.error) {
        const { code: bodyCode, message: bodyMessage, ...rest } = body.error
        code = bodyCode ?? code
        message = bodyMessage ?? message
        extra = rest
      }
    } catch {
      /* le corps n'est pas du JSON : on garde le message par defaut */
    }
    throw new ApiError(response.status, code, message, extra)
  }

  // Une reponse 200 ne garantit pas du JSON. Le repli SPA de Cloudflare Pages
  // sert index.html sur tout chemin inconnu : sans ce controle, JSON.parse
  // echoue sur « Unexpected token '<' », message qui n'apprend rien.
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new ApiError(response.status, 'not_json', "L'API ne répond pas correctement.")
  }

  return (await response.json()) as T
}

export interface HealthResponse {
  readonly status: 'ok'
  readonly version: string
  readonly database: { readonly reachable: boolean; readonly ingredients: number | null }
  /** La derniere sauvegarde de la base reussie ; `null` s'il n'y en a jamais eu. */
  readonly sauvegarde?: { readonly jour: string; readonly octets: number; readonly faiteLe: string } | null
  readonly time: string
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionUser {
  readonly id: number
  readonly username: string
  readonly displayName: string
}

export const checkSession = (): Promise<{ authenticated: boolean; user: SessionUser | null }> =>
  apiFetch('/api/session')

export const login = (username: string, password: string): Promise<{ user: SessionUser }> =>
  apiFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })

export const logout = (): Promise<{ status: 'ok' }> =>
  apiFetch('/api/logout', { method: 'POST' })

export interface InvitationInfo {
  username: string
  displayName: string
  cuisine: string | null
  genre: 'creation' | 'reinitialisation'
}

/*
 * Le jeton part dans le CORPS, pas dans l'adresse.
 *
 * Il est deja dans l'URL de la page — c'est ce qu'on colle dans un message —
 * mais l'y remettre pour l'appel le ferait entrer dans les journaux d'acces et
 * les rapports d'erreur. Voir l'en-tete de worker/src/routes/invitation.ts.
 */
export const lireInvitation = (jeton: string): Promise<InvitationInfo> =>
  apiFetch('/api/invitation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jeton }),
  })

export const definirMotDePasse = (
  jeton: string,
  motDePasse: string,
): Promise<{ user: SessionUser }> =>
  apiFetch('/api/invitation/mot-de-passe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jeton, motDePasse }),
  })
