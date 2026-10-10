/**
 * Ce que les deux cotes doivent savoir de la meme facon sur une photo de recette.
 *
 * Les cles et l'adresse de lecture vivent ici et non dans le Worker parce que le
 * NAVIGATEUR en a besoin : c'est lui qui fabrique le `src` de chaque vignette.
 * Deux implementations de la meme regle de nommage finiraient par se decaler
 * d'un point ou d'un tiret, et le decalage ne se verrait qu'a l'affichage.
 * Une seule fonction produit une cle, une seule fonction produit une URL.
 */

export interface PhotoSpec {
  /** Cote long apres reduction, en pixels. */
  readonly maxSide: number
  /** Qualite JPEG, entre 0 et 1. */
  readonly quality: number
  /** Plafond accepte par le serveur, en octets. */
  readonly maxBytes: number
}

/**
 * Les deux variantes, et pourquoi elles ont ces chiffres.
 *
 * La grande couvre un telephone de 440 points a densite 3, soit 1 320 pixels
 * reels, sans agrandissement visible. La vignette couvre les 54 points de la
 * carte du repertoire a la meme densite, avec de la marge.
 *
 * La qualite de la grande est volontairement au-dessus du reglage habituel :
 * une sauce est un aplat de couleur proche, et c'est exactement ce que la
 * compression JPEG abime en premier, par bandes visibles. Le surcout de poids
 * est de quelques dizaines de kilooctets.
 */
export const PHOTO = {
  cover: { maxSide: 1280, quality: 0.82, maxBytes: 2_000_000 },
  thumb: { maxSide: 320, quality: 0.75, maxBytes: 200_000 },
} as const satisfies Record<string, PhotoSpec>

export type PhotoSize = keyof typeof PHOTO

/**
 * La grande image d'une photo IMPORTEE avec une recette : plus petite et plus
 * compressee, a la demande, pour economiser la place.
 *
 * L'argument qui tient la qualite de 0,82 pour une photo prise au telephone
 * tombe ici : l'image d'un site est DEJA un JPEG compresse, souvent fortement,
 * et la reencoder plus haut ne rend pas ce qui a ete perdu. 1 080 pixels
 * couvrent encore la largeur d'un telephone sans agrandissement visible. La
 * vignette, elle, ne change pas.
 */
export const PHOTO_IMPORT_COVER = { maxSide: 1080, quality: 0.72, maxBytes: PHOTO.cover.maxBytes } as const satisfies PhotoSpec

/** Plafond du corps multipart : les deux parties, plus la place des frontieres. */
export const PHOTO_BODY_MAX = PHOTO.cover.maxBytes + PHOTO.thumb.maxBytes + 8_192

export const photoPrefix = (recipeId: number): string => `recipes/${recipeId}/`

/**
 * La cle de la grande image.
 *
 * `empreinte` est le debut du SHA-256 du contenu, calcule PAR LE SERVEUR. Trois
 * raisons, et la premiere est la doctrine du depot : c'est le serveur qui fait
 * foi, jamais le client. La deuxieme est l'idempotence, meilleure qu'avec un
 * horodatage : le meme contenu donne toujours la meme cle, donc renvoyer deux
 * fois la meme photo apres une coupure n'ecrit qu'un objet, alors qu'un
 * `Date.now()` en ecrirait deux. La troisieme est la devinabilite : R2 est le
 * seul magasin de ce projet sans colonne de foyer et sans possibilite d'en
 * avoir une, donc tout son cloisonnement est derive. Ce n'est PAS le mecanisme
 * de securite, qui reste la verification d'appartenance en base ; c'est le
 * filet sous une future erreur de configuration.
 */
export const coverKey = (recipeId: number, fingerprint: string): string =>
  `${photoPrefix(recipeId)}${fingerprint}.jpg`

/**
 * La cle de la vignette se DEDUIT de celle de la grande.
 *
 * Une seconde colonne en base serait une seconde verite, et deux verites pour
 * une meme photo finissent par diverger. Ici l'une ne peut pas exister sans
 * l'autre.
 */
export function vignetteKey(cover: string): string {
  if (!cover.endsWith('.jpg')) throw new Error(`Cle de photo inattendue : ${cover}`)
  return `${cover.slice(0, -'.jpg'.length)}.vignette.jpg`
}

/**
 * L'adresse de lecture d'une photo.
 *
 * LE CHEMIN NE PORTE PAS LA CLE, et ce n'est pas un detail de gout : le routeur
 * compile `:param` en `([^/]+)`, donc une cle R2 contenant une barre oblique ne
 * peut tout simplement pas transiter par un parametre de chemin.
 *
 * `v` NE SERT A RIEN AU SERVEUR, qui lit la cle en base. Il n'existe que pour
 * que l'URL change quand la photo change. C'est lui qui rend legitime le cache
 * d'un an pose par la route, et c'est parce que le serveur l'ignore qu'une
 * vieille URL sert quand meme l'image courante au lieu d'une erreur.
 *
 * LES DEUX SE TIENNENT DEBOUT MUTUELLEMENT. Une cle fixe avec `immutable`, ce
 * serait l'ancienne photo pendant un an, sur l'appareil meme qui vient de la
 * remplacer. Retirer l'un sans l'autre casse en silence.
 */
export function photoPath(recipeId: number, imageKey: string, size: PhotoSize = 'cover'): string {
  const v = imageKey.slice(photoPrefix(recipeId).length, -'.jpg'.length)
  return `/api/recipes/${recipeId}/image?size=${size}&v=${v}`
}

/**
 * Les dimensions apres reduction a rapport constant.
 *
 * N'AGRANDIT JAMAIS : une photo de 600 px reste a 600 px. C'est le comportement
 * du `thumbnail()` de Pillow, celui que le desktop utilisait. Agrandir ne cree
 * aucun detail et multiplie le poids par quatre.
 */
export function scaleFor(
  width: number,
  height: number,
  maxSide: number,
): { readonly width: number; readonly height: number } {
  const ratio = Math.min(1, maxSide / Math.max(width, height))
  return {
    // Au moins un pixel : une image de 1 x 4000 reduite a 320 donnerait 0 de
    // large, et un canvas de largeur nulle leve.
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}
