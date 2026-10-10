/**
 * API de Prandia, Cloudflare Worker.
 *
 * Sert /api/* sur la meme origine que le front (Cloudflare Pages), ce qui
 * evite toute question de CORS.
 *
 * Ce fichier ne contient plus aucune route : il ne fait qu'assembler. Les
 * routes vivent dans `routes/`, ou chaque module s'enregistre a l'import via
 * `route()`. Les imports ci-dessous ne sont donc pas decoratifs — les retirer
 * ferait disparaitre les endpoints correspondants, sans erreur de compilation.
 *
 * ---------------------------------------------------------------------------
 * AUTHENTIFICATION
 * ---------------------------------------------------------------------------
 * Toute route /api/* exige une session valide, sauf celles de PUBLIC_ROUTES.
 *
 * Cloudflare Access remplissait ce role au depart et le faisait mieux — il
 * refusait la requete AVANT d'atteindre ce code. Mais sa page de connexion vit
 * sur une autre origine, et un `fetch()` ne peut pas lire une reponse issue
 * d'une redirection cross-origin : l'API devenait « injoignable » des que la
 * session expirait, sans qu'on puisse le distinguer d'une panne de reseau.
 * Inutilisable dans une PWA.
 *
 * Le mecanisme de remplacement est detaille en tete de auth.ts, limites
 * comprises.
 *
 * Les fichiers statiques restent publics : ils ne contiennent aucune donnee,
 * et l'ecran de connexion en fait partie.
 */

import { currentUser, devUser } from './auth.js'
import { fail, HttpError, match, type Env } from './http.js'
import { NO_HOUSEHOLD, Repositories } from './repos/index.js'

// Enregistrement des routes. L'ordre n'a pas d'importance : les chemins sont
// disjoints et la recherche compare le motif complet.
import './routes/session.js'
import './routes/invitation.js'
import './routes/system.js'
import './routes/ingredients.js'
import './routes/rayons.js'
import './routes/icons.js'
import './routes/hydration.js'
import './routes/weight.js'
import './routes/profile.js'
import './routes/recipes.js'
import './routes/importRecette.js'
import './routes/photos.js'
import './routes/calendar.js'
import './routes/pantry.js'
import './routes/shopping.js'
import './routes/courses.js'
import './routes/notifications.js'

/**
 * Routes accessibles sans session. Tout le reste est protege par defaut.
 *
 * Liste explicite et courte : proteger route par route serait l'inverse, et
 * laisserait tot ou tard passer un endpoint oublie.
 */
const PUBLIC_ROUTES = new Set([
  '/api/login',
  '/api/logout',
  '/api/session',
  // Invitations : leur destinataire n'a pas encore de session, c'est tout
  // l'objet. Chemins FIXES, le jeton voyageant dans le corps — voir l'en-tete
  // de routes/invitation.ts, qui explique aussi pourquoi on n'assouplit pas
  // cette comparaison exacte pour un segment variable.
  '/api/invitation',
  '/api/invitation/mot-de-passe',
])

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Tout ce qui n'est pas de l'API repart vers les fichiers statiques.
    // En mode avance, Pages ne sert plus rien de lui-meme : sans cette
    // delegation, le site entier renverrait du JSON.
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request)
    }

    // Garde d'authentification, AVANT toute recherche de route.
    //
    // Le cookie d'abord, toujours. `devUser` ne repond qu'en developpement
    // local et seulement A DEFAUT de session : le chemin normal reste donc
    // exactement celui de la production, y compris sur le poste du
    // developpeur des qu'il s'est connecte pour de bon. Voir auth.ts pour les
    // deux verrous qui interdisent cette porte en ligne.
    const user = (await currentUser(request, env.DB)) ?? (await devUser(env, env.DB))
    if (!PUBLIC_ROUTES.has(url.pathname) && user === null) {
      return fail(401, 'unauthenticated', 'Session expirée. Reconnecte-toi.')
    }

    const found = match(url.pathname, request.method)
    if (found === null) return fail(404, 'not_found', 'Cette adresse ne correspond à aucune API.')
    if (found === 'method_not_allowed') {
      return fail(405, 'method_not_allowed', `Méthode ${request.method} non autorisée ici.`)
    }

    try {
      return await found.route.handler({
        // Le foyer vient du cookie signe, jamais de la requete. Sans session,
        // NO_HOUSEHOLD ne correspond a aucune cuisine : la lecture rend vide
        // au lieu de tomber sur celle de quelqu'un.
        repos: new Repositories(env.DB, user?.householdId ?? NO_HOUSEHOLD),
        env,
        url,
        params: found.params,
        request,
        user,
      })
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.status, error.code, error.message, error.extra)
      }
      // Le detail part dans les logs Cloudflare, jamais dans la reponse :
      // un message d'erreur SQL renseigne un attaquant sur le schema.
      console.error('Erreur non gérée', url.pathname, error)
      return fail(500, 'internal', 'Une erreur interne est survenue.')
    }
  },
} satisfies ExportedHandler<Env>

export type { Env }
