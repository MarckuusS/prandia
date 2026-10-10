/*
 * Notifications, cote service worker. Charge par le service worker de
 * l'application (`importScripts` dans vite.config.ts) : il recoit les
 * notifications meme quand Prandia est fermee.
 *
 * TOUTE NOTIFICATION RECUE S'AFFICHE. iOS l'exige (`userVisibleOnly`) : une
 * reception silencieuse finit par couper l'abonnement. Le contenu vient de
 * `PushContent` dans worker/src/push.ts.
 */

self.addEventListener('push', (event) => {
  let contenu = {}
  try {
    contenu = event.data ? event.data.json() : {}
  } catch {
    contenu = { body: event.data ? event.data.text() : '' }
  }

  event.waitUntil(
    self.registration.showNotification(contenu.title || 'Prandia', {
      body: contenu.body || '',
      // Meme `tag` : la nouvelle remplace l'ancienne au lieu de s'empiler.
      tag: contenu.tag,
      data: { url: contenu.url || '/' },
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
    }),
  )
})

// Un toucher ouvre l'ecran concerne : celui de l'application deja ouverte s'il
// y en a une, sinon une nouvelle fenetre.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const cible = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href

  event.waitUntil(
    (async () => {
      const fenetres = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const fenetre of fenetres) {
        if ('focus' in fenetre) {
          await fenetre.focus()
          if ('navigate' in fenetre) await fenetre.navigate(cible)
          return
        }
      }
      await self.clients.openWindow(cible)
    })(),
  )
})
