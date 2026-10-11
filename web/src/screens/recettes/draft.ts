/**
 * Tampon d'edition d'une recette : sa forme, ses regles, sa serialisation.
 *
 * Le desktop tenait ce tampon dans un ViewModel Qt et posait un drapeau
 * « dirty » a la main dans chaque mutation — d'ou l'oubli documente dans
 * l'inventaire de parite : changer l'unite d'une ligne ne marquait pas la
 * recette comme modifiee. Ici le drapeau est DEDUIT en comparant une signature
 * du tampon a celle de la derniere version enregistree. Aucune mutation ne peut
 * l'oublier, et un aller-retour qui revient a l'etat de depart (ajouter une
 * ligne puis la retirer) ne laisse pas la recette faussement sale.
 *
 * La quantite d'une ligne est `number | null` et non `number` : pendant la
 * frappe, le champ passe par l'etat vide. Stocker 0 a la place ferait
 * reapparaitre « 0 » sous les doigts de l'utilisateur des qu'il efface. La
 * conversion en nombre n'a lieu qu'au moment des calculs (`toRecipeLines`), et
 * `draftProblem` refuse d'enregistrer une ligne restee vide.
 */

import {
  COOKED_UNIT_CODE,
  PIECE_UNIT_CODE,
  fromGrams,
  toGrams,
  type Ingredient,
  type Recipe,
  type RecipeLine,
  type RecipeWrite,
} from '@prandia/shared'

export interface DraftLine {
  /**
   * Identite cote client, stable tant que la ligne existe. Ni l'identifiant
   * d'ingredient ni l'ordinal ne peuvent servir de cle React : le premier se
   * repete si l'on ajoute deux fois le meme ingredient, le second change des
   * qu'on reordonne, ce qui ferait remonter les etats de saisie d'une ligne a
   * l'autre.
   */
  readonly key: string
  readonly ingredient: Ingredient
  readonly quantityG: number | null
  /** Unite d'affichage choisie ('g', 'kg', '_piece'…). Cosmetique : le stockage est en grammes. */
  readonly unit: string | null
  readonly notes: string | null
  /** Rang de saisie. Ne sert qu'a departager deux lignes d'un meme rayon. */
  readonly ordinal: number
}

export interface RecipeDraft {
  readonly name: string
  readonly instructions: string
  readonly defaultPortions: number
  readonly prepTimeMin: number | null
  /*
   * PAS DE `imageKey` DANS LE BROUILLON, et c'est structurant.
   *
   * La photo s'enregistre toute seule au moment ou on la choisit, par
   * POST /api/recipes/:id/image. Elle ne voyage pas dans ce tampon, pour trois
   * raisons dont une seule suffirait. La securite : le champ etait libre en
   * ecriture, donc on pouvait faire pointer SA recette vers la cle d'un autre
   * foyer. La perte de donnee : cet editeur ne resynchronise JAMAIS son tampon
   * depuis la prop, donc un editeur ouvert le matin sur le bureau effacerait la
   * photo posee a midi depuis le telephone. Et iOS, qui recharge la page sous
   * pression memoire, dont le televersement d'une photo est un declencheur
   * documente : elle se perdrait au moment le plus probable.
   *
   * Consequence : `draftSignature` n'a rien a apprendre d'elle. Le probleme
   * disparait au lieu d'etre compense.
   */
  readonly sourceUrl: string | null
  readonly tagIds: number[]
  readonly lines: DraftLine[]
}

let sequence = 0

/** Cle de ligne unique pour la duree de la session. */
export function nextLineKey(): string {
  sequence += 1
  return `line-${sequence}`
}

export function toDraft(recipe: Recipe): RecipeDraft {
  return {
    name: recipe.name,
    instructions: recipe.instructions,
    defaultPortions: recipe.defaultPortions,
    prepTimeMin: recipe.prepTimeMin,
    sourceUrl: recipe.sourceUrl,
    tagIds: recipe.tags.map((tag) => tag.id).filter((id): id is number => id !== null),
    lines: recipe.lines.map((line) => ({
      key: nextLineKey(),
      ingredient: line.ingredient,
      quantityG: line.quantityG,
      unit: line.unit,
      notes: line.notes,
      ordinal: line.ordinal,
    })),
  }
}

/**
 * Nouvelle ligne pour un ingredient qu'on vient de choisir.
 *
 * Une piece quand l'ingredient en a une, 100 g sinon. Le desktop demandait la
 * quantite AVANT le choix, dans un champ voisin du champ de recherche : les
 * deux ne tiennent pas cote a cote en 375 px, et « 2 oeufs » se regle mieux une
 * fois la ligne visible.
 */
export function newLine(ingredient: Ingredient, ordinal: number): DraftLine {
  const piece = ingredient.pieceWeightG
  return {
    key: nextLineKey(),
    ingredient,
    quantityG: piece !== null && piece > 0 ? piece : 100,
    unit: piece !== null && piece > 0 ? '_piece' : 'g',
    notes: null,
    ordinal,
  }
}

/**
 * Lignes utilisables par @prandia/shared : une quantite en attente de saisie vaut
 * 0, ce qui la fait simplement compter pour rien dans les agregats.
 */
export function toRecipeLines(lines: readonly DraftLine[]): RecipeLine[] {
  return lines.map((line) => ({
    ingredient: line.ingredient,
    quantityG: line.quantityG ?? 0,
    unit: line.unit,
    notes: line.notes,
    ordinal: line.ordinal,
  }))
}

/** Les memes lignes, quantites multipliees par le facteur de mise a l'echelle. */
export function scaleLines(lines: readonly RecipeLine[], ratio: number): RecipeLine[] {
  if (ratio === 1) return lines as RecipeLine[]
  return lines.map((line) => ({ ...line, quantityG: line.quantityG * ratio }))
}

/**
 * Empreinte de ce qui part au serveur.
 *
 * Volontairement insensible a ce qui ne se persiste pas : la cle de ligne,
 * l'ordre du tableau de tags, les espaces autour du nom. Deux tampons de meme
 * empreinte produisent le meme enregistrement, donc l'un n'est pas « modifie »
 * par rapport a l'autre.
 */
export function draftSignature(draft: RecipeDraft): string {
  return JSON.stringify({
    name: draft.name.trim(),
    instructions: draft.instructions,
    portions: draft.defaultPortions,
    prep: draft.prepTimeMin,
    tags: [...draft.tagIds].sort((a, b) => a - b),
    lines: draft.lines.map((line) => [
      line.ingredient.id,
      line.quantityG,
      line.unit,
      line.notes ?? '',
    ]),
  })
}

/**
 * Ce qui empeche l'enregistrement, en francais, ou `null` si tout va bien.
 *
 * Le desktop echouait EN SILENCE sur un nom vide : `saveCurrent()` rendait
 * `false` et rien ne s'affichait. Le message est ici obligatoire — c'est le
 * defaut d'ergonomie que l'inventaire de parite demandait de corriger.
 */
export function draftProblem(draft: RecipeDraft): string | null {
  if (draft.name.trim() === '') return 'Le nom de la recette ne peut pas être vide.'

  const empty = draft.lines.find((line) => line.quantityG === null || line.quantityG <= 0)
  if (empty) return `Quantité manquante pour « ${empty.ingredient.name} ».`

  const orphan = draft.lines.find((line) => line.ingredient.id === null)
  if (orphan) return `« ${orphan.ingredient.name} » n’existe plus dans la bibliothèque.`

  return null
}

/**
 * Charge utile d'enregistrement.
 *
 * Les lignes sont envoyees DANS L'ORDRE AFFICHE : le serveur reattribue les
 * ordinaux depuis la position dans le tableau, c'est donc cet ordre qui fait
 * foi au rechargement.
 */
export function toPayload(draft: RecipeDraft): RecipeWrite {
  return {
    name: draft.name.trim(),
    instructions: draft.instructions,
    defaultPortions: Math.max(1, Math.round(draft.defaultPortions)),
    sourceUrl: draft.sourceUrl,
    // 0 minute n'est pas un temps de preparation : le schema le refuse, et
    // « non renseigne » se dit `null`.
    prepTimeMin:
      draft.prepTimeMin !== null && draft.prepTimeMin > 0 ? Math.round(draft.prepTimeMin) : null,
    lines: sortedByRayon(draft.lines).flatMap((line) =>
      line.ingredient.id === null || line.quantityG === null || line.quantityG <= 0
        ? []
        : [
            {
              ingredientId: line.ingredient.id,
              quantityG: line.quantityG,
              unit: line.unit,
              notes: line.notes,
            },
          ],
    ),
    tagIds: [...draft.tagIds],
  }
}

// ---------------------------------------------------------------------------
// Rayons
// ---------------------------------------------------------------------------

export const RAYON_FALLBACK = 'Autres'

/**
 * CIQUAL rend ses libelles en minuscules et avec des virgules
 * (« viandes, oeufs, poissons ») : on capitalise la premiere lettre, comme le
 * desktop, sans toucher au reste.
 */
export function rayonLabel(categoryL1: string | null): string {
  if (!categoryL1) return RAYON_FALLBACK
  return categoryL1.charAt(0).toUpperCase() + categoryL1.slice(1)
}

/**
 * Ordre d'affichage : par rayon, puis par rang de saisie.
 *
 * Les ingredients sans rayon passent en dernier via un rang explicite plutot
 * que par la sentinelle '~~~' du desktop : celle-ci reposait sur l'ordre ASCII,
 * or `localeCompare` place la ponctuation AVANT les lettres et l'aurait donc
 * fait remonter en tete.
 */
export function sortedByRayon(lines: readonly DraftLine[]): DraftLine[] {
  return [...lines].sort((a, b) => {
    const rankA = a.ingredient.categoryL1 ? 0 : 1
    const rankB = b.ingredient.categoryL1 ? 0 : 1
    if (rankA !== rankB) return rankA - rankB
    const byRayon = (a.ingredient.categoryL1 ?? '').localeCompare(
      b.ingredient.categoryL1 ?? '',
      'fr',
    )
    return byRayon !== 0 ? byRayon : a.ordinal - b.ordinal
  })
}

/**
 * Deplace une ligne d'un cran dans SON rayon.
 *
 * Le desktop n'offrait aucun reordonnancement : l'ordre etait entierement
 * derive du rayon puis du rang de saisie. On garde ce classement — c'est lui
 * qui rend la liste lisible en cuisine — et le deplacement n'agit qu'a
 * l'interieur d'un rayon, ou il change quelque chose de visible. Franchir une
 * frontiere de rayon serait sans effet a l'ecran, donc l'appel est ignore.
 *
 * Les ordinaux sont renumerotes avant l'echange : deux lignes importees
 * peuvent partager le meme, auquel cas les permuter ne ferait rien.
 */
export function moveLine(lines: readonly DraftLine[], key: string, delta: number): DraftLine[] {
  const numbered = sortedByRayon(lines).map((line, index) => ({ ...line, ordinal: index }))
  const index = numbered.findIndex((line) => line.key === key)
  const current = numbered[index]
  const neighbour = numbered[index + delta]
  if (!current || !neighbour) return numbered
  if ((current.ingredient.categoryL1 ?? '') !== (neighbour.ingredient.categoryL1 ?? '')) {
    return numbered
  }
  return numbered.map((line) => {
    if (line.key === current.key) return { ...line, ordinal: neighbour.ordinal }
    if (line.key === neighbour.key) return { ...line, ordinal: current.ordinal }
    return line
  })
}

const positif = (n: number | null | undefined): n is number => n !== null && n !== undefined && n > 0

/**
 * Remplacer l'ingredient d'une ligne : du beurre par de la margarine, de la
 * creme liquide par de la creme epaisse.
 *
 * ON GARDE CE QUI SE LIT. "3 c. a cafe" restent trois cuilleres a cafe,
 * "2 pieces" restent deux pieces, et ce sont les grammes qui suivent le
 * nouvel ingredient : deux oignons remplaces par deux echalotes ne pesent pas
 * pareil. Quand l'unite n'a plus de sens (une piece sans poids unitaire, du
 * "cuit" sans rendement connu), on garde la MASSE, en grammes : la recette ne
 * change pas de quantite en silence.
 *
 * La ligne garde sa cle (l'etat de saisie suit), sa note et son rang : une
 * note "egoutter" vaut encore pour la creme qui remplace la creme.
 */
export function replaceIngredient(line: DraftLine, next: Ingredient): DraftLine {
  const avant = line.ingredient
  // `null` veut dire "l'heuristique" : la piece si l'ingredient en a une.
  const unite = line.unit ?? (positif(avant.pieceWeightG) ? PIECE_UNIT_CODE : 'g')
  const garderLaMasse = { ...line, ingredient: next, unit: 'g' }

  if (unite === PIECE_UNIT_CODE || unite === COOKED_UNIT_CODE) {
    const facteurNouveau = unite === PIECE_UNIT_CODE ? next.pieceWeightG : next.cookedWeightPer100gRaw
    const facteurAncien = unite === PIECE_UNIT_CODE ? avant.pieceWeightG : avant.cookedWeightPer100gRaw
    if (!positif(facteurNouveau)) return garderLaMasse
    if (line.quantityG === null || !positif(facteurAncien)) return { ...line, ingredient: next, unit: unite }
    const lu = fromGrams(line.quantityG, unite, avant.pieceWeightG, avant.cookedWeightPer100gRaw)
    return {
      ...line,
      ingredient: next,
      unit: unite,
      quantityG: toGrams(lu, unite, next.pieceWeightG, next.cookedWeightPer100gRaw),
    }
  }

  // Grammes, litres, cuilleres, pincees : la conversion ne depend pas de
  // l'ingredient, les grammes ne bougent pas.
  return { ...line, ingredient: next, unit: unite }
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/**
 * Date-jour 'AAAA-MM-JJ' en francais.
 *
 * Interpretee a MIDI : construire un `Date` depuis 'AAAA-MM-JJ' le place a
 * minuit UTC, et l'affichage local recule alors d'un jour a l'ouest de
 * Greenwich. Meme piege que `toISOString()` dans l'autre sens.
 */
export function formatDay(day: string): string {
  const date = new Date(`${day}T12:00:00`)
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString('fr-FR')
}

/**
 * Reexportation. La fonction a demenage dans `lib/format.ts` le jour ou
 * l'anneau de macros est devenu un composant partage : un fichier de
 * `components/` ne peut pas dependre d'un dossier d'ecran. Les appelants
 * historiques continuent de l'importer d'ici.
 */
export { formatNumber } from '../../lib/format.js'

export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string =>
  count > 1 ? pluralForm : singular
