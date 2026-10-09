import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Le front est servi par Cloudflare Pages, l'API par un Worker sur /api/*.
 * Meme origine en production : aucun CORS a gerer. En developpement, le proxy
 * ci-dessous reproduit cette topologie pour que le code n'ait jamais a
 * connaitre d'URL d'API absolue.
 */
// Cloudflare Pages expose le SHA du commit deploye. En local il n'existe pas :
// on retombe sur 'dev', ce qui distingue immediatement les deux situations sur
// l'ecran Diagnostic.
const COMMIT = process.env['CF_PAGES_COMMIT_SHA']?.slice(0, 7) ?? 'dev'
const BUILD_TIME = new Date().toISOString()

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(COMMIT),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Prandia',
        // Sous l'icone d'un ecran d'accueil, on ne lit qu'une douzaine de
        // caracteres avant la troncature. « Prandia » en fait sept : le nom
        // complet tient, il n'y a pas de version courte a inventer.
        short_name: 'Prandia',
        description: 'Recettes, courses, semaine, frigo et objectifs nutritionnels.',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f5f7f2',
        theme_color: '#454f2b',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          // `maskable` laisse Android recadrer dans sa propre forme sans
          // rogner le motif : l'icone prevoit une marge de securite.
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // L'app est en ligne par choix : le cache sert au demarrage instantane
        // et a la resistance aux reseaux mauvais, PAS a un mode hors-ligne.
        // Les reponses de l'API ne sont jamais mises en cache par le service
        // worker — un prix perime affiche comme frais serait pire qu'une erreur.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        // Sans ces deux options, un nouveau service worker attend la fermeture
        // de TOUS les onglets avant de prendre la main. Sur un telephone, une
        // PWA n'est jamais vraiment fermee : la version affichee restait donc
        // bloquee plusieurs jours en arriere.
        skipWaiting: true,
        clientsClaim: true,
        // Supprime les caches des versions precedentes, qui sinon
        // s'accumulent a chaque deploiement.
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@prandia/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787', // `wrangler dev` du Worker
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
})
