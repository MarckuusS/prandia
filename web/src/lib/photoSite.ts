/**
 * La photo d'un site de recettes, relayee par le serveur.
 *
 * Deux usages : la revue d'un import, et "Reprendre la photo du site" dans
 * l'editeur, quand l'import l'a manquee (vu sur un hachis HelloFresh : la
 * meme page relue plus tard rendait bien ses deux images).
 */

import { fetchImportPhoto } from './queries.js'

/** Assez grande pour la largeur d'un telephone : on s'arrete a la premiere. */
export const PHOTO_LARGEUR_MIN = 600

/**
 * Les adresses sont essayees dans l'ordre : la premiere d'au moins
 * `PHOTO_LARGEUR_MIN` pixels l'emporte, a defaut la plus grande. Le bloc
 * recette de certains sites ne donne qu'une vignette de 290 pixels. `null`
 * quand aucune n'a pu etre lue : adresse morte, site qui refuse, image
 * illisible.
 */
export async function meilleurePhotoDuSite(urls: readonly string[]): Promise<Blob | null> {
  let meilleure: { blob: Blob; largeur: number } | null = null
  for (const url of urls) {
    try {
      const blob = await fetchImportPhoto(url)
      const image = await createImageBitmap(blob)
      const largeur = image.width
      image.close()
      if (meilleure === null || largeur > meilleure.largeur) meilleure = { blob, largeur }
      if (largeur >= PHOTO_LARGEUR_MIN) break
    } catch {
      // Une adresse morte ou une image illisible : on essaie la suivante.
    }
  }
  return meilleure?.blob ?? null
}
