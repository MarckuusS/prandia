import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router'

import { AuthGate } from './AuthGate.js'
import { keepAppUpToDate } from './lib/appUpdate.js'
import { queryClient } from './lib/clientRequetes.js'
import { preventBrowserZoom } from './lib/gestures.js'
import { healStandaloneViewport } from './lib/viewport.js'
// Les deux polices, SERVIES PAR NOUS et non par Google : l'application doit
// s'ouvrir dans un magasin sans reseau, et une police distante y afficherait
// un texte nu le temps d'un delai d'attente. Le sous-ensemble latin en
// fichier variable coute 71 Ko a deux, contre 6 fichiers statiques autrement.
import '@fontsource-variable/bricolage-grotesque/wght.css'
import '@fontsource-variable/instrument-sans/wght.css'
import './styles/theme.css'
import './styles/app.css'
import './styles/icons.css'
import './styles/ia.css'

// Avant le premier rendu : le pincement ne doit jamais avoir l'occasion de
// zoomer, pas meme pendant le chargement.
preventBrowserZoom()

// iOS retrecit parfois l'application installee de la hauteur du clavier et ne
// la lui rend pas : la barre d'onglets flottait au milieu de l'ecran au retour
// de Safari. Voir lib/viewport.ts.
healStandaloneViewport()

// Le script de chargement genere par vite-plugin-pwa enregistre le service
// worker et s'arrete la. Sans ce complement, une PWA installee peut continuer
// d'afficher une version publiee des jours plus tot. Voir lib/appUpdate.ts.
keepAppUpToDate()

const root = document.getElementById('root')
if (!root) throw new Error('#root introuvable')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
