/**
 * Le cache des requetes de toute l'application, cree une seule fois.
 *
 * Sorti de `main.tsx` pour qu'un travail qui SURVIT aux ecrans puisse y lire
 * et y ecrire : une lecture de Savarin lancee depuis la feuille d'un article
 * se termine souvent quand cette feuille, voire l'ecran du chariot, est deja
 * ferme (screens/courses/lecturesArticle.ts).
 */

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { ApiError } from './api.js'

/**
 * Un 401 sur N'IMPORTE QUELLE requete bascule immediatement l'application sur
 * l'ecran de connexion.
 *
 * Le traiter ici plutot que dans chaque ecran garantit qu'aucun appel n'est
 * oublie : une session expiree pendant qu'on consulte sa liste de courses ne
 * doit pas produire un message d'erreur incomprehensible.
 */
const onError = (error: unknown) => {
  if (error instanceof ApiError && error.isUnauthenticated) {
    queryClient.setQueryData(['session'], { authenticated: false })
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: {
    queries: {
      // L'app est en ligne par choix, mais le reseau en magasin est mauvais :
      // on reessaie deux fois avant d'afficher une erreur. Inutile en
      // revanche de s'acharner sur un 401, qui ne se resoudra pas tout seul.
      retry: (failureCount, error) =>
        error instanceof ApiError && error.isUnauthenticated ? false : failureCount < 2,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
})
