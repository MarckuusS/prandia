/**
 * Reduire une photo dans le navigateur, avant de l'envoyer.
 *
 * POURQUOI ICI ET PAS SUR LE SERVEUR. Deux raisons, et la seconde est la vraie.
 * D'abord l'economie : une photo d'iPhone fait de trois a douze megaoctets, et
 * la carte du repertoire l'affiche a cinquante-quatre points. Ensuite, et
 * surtout, LE DECODEUR DU SYSTEME EST LE SEUL QUI LISE LE HEIC : `workerd` n'a
 * aucun decodeur d'image, et un HEIC arrive tel quel sur le serveur serait
 * indechiffrable. En passant par le navigateur, iOS transcode de lui-meme
 * pendant la selection et l'on recoit du JPEG.
 *
 * EFFET DE BORD QUI COMPTE : un canvas ne transporte AUCUNE metadonnee. Il n'y
 * a pas de conteneur a recopier, le reencodeur ecrit un flux neuf. Partent donc
 * les coordonnees GPS du domicile, le modele et le numero de serie de
 * l'appareil, l'horodatage et la vignette EXIF embarquee. Ce n'est pas une
 * garantie, puisque rien n'oblige a passer par ici, d'ou le controle cote
 * serveur qui refuse un JPEG portant encore ces segments.
 */

import { PHOTO, type PhotoSize, scaleFor } from '@prandia/shared'

/** Le fichier ne se decode pas : format inconnu du navigateur, ou fichier abime. */
export class PhotoIllisibleError extends Error {
  constructor() {
    super("Cette image n'a pas pu être lue. Essaie une autre photo.")
    this.name = 'PhotoIllisibleError'
  }
}

export interface PhotoReduite {
  readonly cover: Blob
  readonly thumb: Blob
  /** Dimensions de la grande, pour l'apercu. */
  readonly width: number
  readonly height: number
}

/**
 * Dessine une source deja decodee a la taille voulue, et l'encode en JPEG.
 *
 * TROIS PIEGES SONT TENUS ICI, tous mesures et tous sur du materiel RECENT :
 *
 * 1. LE CANVAS NE FAIT JAMAIS LES DIMENSIONS NATIVES. iOS plafonne la surface
 *    d'un canvas a 16 777 216 pixels, soit 4096 par 4096. Un iPhone 15 Pro
 *    photographie par defaut en 5712 par 4284, soit 24 470 208 : une fois et
 *    demie la limite. `canvas.width = image.naturalWidth` leve donc "Canvas
 *    area exceeds the maximum limit" sur les telephones neufs, pas les vieux.
 *    La reduction se fait AU MOMENT DU DESSIN.
 *
 * 2. LE FOND EST PEINT EN BLANC AVANT LE DESSIN. Le JPEG n'a pas de couche
 *    alpha : une capture d'ecran transparente virerait au noir.
 *
 * 3. LE TYPE DU BLOB EST VERIFIE. Quand un navigateur ne connait pas le type
 *    demande, `toBlob` ne rend pas d'erreur : il retombe SILENCIEUSEMENT sur
 *    `image/png`, c'est la specification. C'est ce qui arriverait avec WebP,
 *    qu'aucune version de Safari ne sait encoder, et un PNG de photo pese
 *    plusieurs megaoctets, soit l'exact contraire du but. JPEG ne declenche pas
 *    ce repli, mais le controle coute une ligne et attrapera la regression du
 *    jour ou quelqu'un voudra optimiser.
 */
async function dessiner(
  source: ImageBitmap,
  taille: PhotoSize,
): Promise<{ blob: Blob; width: number; height: number }> {
  const { width, height } = scaleFor(source.width, source.height, PHOTO[taille].maxSide)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new PhotoIllisibleError()

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resoudre) => {
    canvas.toBlob(resoudre, 'image/jpeg', PHOTO[taille].quality)
  })
  if (blob === null) throw new PhotoIllisibleError()
  if (blob.type !== 'image/jpeg') throw new PhotoIllisibleError()

  return { blob, width, height }
}

/**
 * Un fichier choisi par l'utilisateur, en deux JPEG prets a partir.
 *
 * UN SEUL DECODAGE pour les deux variantes : decoder deux fois vingt-quatre
 * megapixels doublerait l'attente et la memoire pour rien.
 *
 * `imageOrientation: 'from-image'` N'EST PAS FACULTATIF. Le capteur d'un
 * telephone ecrit toujours en paysage et delegue la rotation a une etiquette
 * EXIF, qu'un canvas ignore : sans cette option, toute photo verticale ressort
 * couchee. C'est aussi pour cela que le serveur REFUSE les segments EXIF au
 * lieu de les retirer : sur un fichier qui n'est pas passe par ici, la rotation
 * n'est pas cuite dans les pixels, et effacer l'etiquette la rendrait
 * definitive.
 */
export async function reduirePhoto(fichier: File | Blob): Promise<PhotoReduite> {
  let source: ImageBitmap
  try {
    source = await createImageBitmap(fichier, { imageOrientation: 'from-image' })
  } catch {
    // Un HEIC qu'iOS n'a pas transcode, un fichier tronque, un format que ce
    // navigateur ne connait pas : tous arrivent ici.
    throw new PhotoIllisibleError()
  }

  try {
    const grande = await dessiner(source, 'cover')
    // LA VIGNETTE PART DE LA GRANDE, deja reduite : redessiner depuis la source
    // native rejouerait le decodage de vingt-quatre megapixels pour une image
    // de trois cent vingt pixels.
    const petiteSource = await createImageBitmap(grande.blob)
    try {
      const petite = await dessiner(petiteSource, 'thumb')
      return {
        cover: grande.blob,
        thumb: petite.blob,
        width: grande.width,
        height: grande.height,
      }
    } finally {
      petiteSource.close()
    }
  } finally {
    // Une photo de vingt-quatre megapixels occupe de l'ordre de quatre-vingt-dix
    // megaoctets une fois decodee en RGBA, et WebKit recharge la page sous
    // pression memoire. On rend la place tout de suite.
    source.close()
  }
}
