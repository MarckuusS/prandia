/**
 * Le brouillon d'un article du chariot — la matiere des quatre champs.
 *
 * Isole des composants pour une raison concrete : la MEME structure se remplit
 * de quatre facons (fiche deja en bibliotheque, reponse OpenFoodFacts, prix
 * constate, saisie a la main) et se relit depuis deux endroits (l'ajout au
 * scan, la correction d'une ligne du chariot). Laisser la conversion dans
 * chacun d'eux, c'est s'assurer qu'un jour l'un des deux enverra un prix
 * flottant la ou le serveur attend une chaine decimale.
 */

import { parseDateLue, type ArticleLu, type Ingredient, type SessionItem } from '@prandia/shared'

import type { SessionItemWrite } from '../../lib/queries.js'

/**
 * Les macros telles que l'API les accepte.
 *
 * On les prend sur le modele partage plutot que d'ecrire `Partial<NutritionTotal>` :
 * sous `exactOptionalPropertyTypes`, les deux ne sont PAS le meme type, et le
 * second refuserait ce que zod produit reellement.
 */
type ItemMacros = NonNullable<SessionItem['macros']>

/** Les 8 macros du tableau reglementaire, telles que les porte un ingredient. */
const MACRO_KEYS = [
  'kcal',
  'proteins',
  'carbs',
  'sugars',
  'fats',
  'saturatedFats',
  'fiber',
  'salt',
] as const

export interface ItemDraft {
  /** `null` pour un article sans code-barres : vrac, boucherie, marche. */
  readonly ean: string | null
  readonly name: string
  /** Chaine vide plutot que `null` : un champ de saisie n'a pas d'etat « absent ». */
  readonly brand: string
  /** Masse mise dans le chariot. Toujours en grammes, comme partout ailleurs. */
  readonly quantityG: number | null
  /** Montant en euros. `null` = prix non note, l'article compte quand meme. */
  readonly priceEur: number | null
  readonly ingredientId: number | null
  readonly macros: ItemMacros | null
  readonly pieceWeightG: number | null
  /** Date lue sur l'emballage, facultative ; sinon elle se donne en rangeant. */
  readonly expiryDate: string | null
  /** Vrac pese en caisse : poids et prix viendront du ticket. */
  readonly aPeser: boolean
}

export const emptyDraft = (ean: string | null): ItemDraft => ({
  ean,
  name: '',
  brand: '',
  quantityG: null,
  priceEur: null,
  ingredientId: null,
  macros: null,
  pieceWeightG: null,
  expiryDate: null,
  aPeser: false,
})

/** Les macros connues, sous la forme attendue par la creation differee. */
function macrosOf(product: Ingredient): ItemMacros | null {
  const macros: ItemMacros = {}
  let any = false
  for (const key of MACRO_KEYS) {
    const value = product[key]
    // Une macro absente reste absente : « 0 g de sucres » et « sucres
    // inconnus » ne sont pas la meme information, et un zero invente
    // fausserait tous les totaux de la semaine.
    if (value === null) continue
    macros[key] = value
    any = true
  }
  return any ? macros : null
}

/**
 * Brouillon issu d'un produit — fiche de la bibliotheque ou candidat OFF.
 *
 * L'identifiant n'est repris que si la fiche est DEJA dans la bibliotheque
 * personnelle. Une ligne de catalogue (importee mais jamais adoptee) part avec
 * `ingredientId: null` : c'est precisement ce qui declenche, a la validation,
 * sa reprise en bibliotheque. Lui donner son identifiant la ferait entrer au
 * frigo sans jamais entrer dans la bibliotheque — un produit fantome, present
 * en stock et introuvable a la recherche.
 */
export function draftFromProduct(ean: string | null, product: Ingredient): ItemDraft {
  const ingredientId = product.inLibrary ? product.id : null
  return {
    ean,
    name: product.name,
    brand: product.brand ?? '',
    // La contenance d'une piece est la quantite la plus probable : un pot, une
    // boite, une brique. Fausse au rayon boucherie, mais toujours a un champ
    // de la correction.
    quantityG: product.pieceWeightG,
    priceEur: null,
    ingredientId,
    // Les macros ne servent qu'a CREER la fiche manquante. Quand elle existe
    // deja, les renvoyer serait au mieux inutile, au pire une regression sur
    // des valeurs corrigees a la main.
    macros: ingredientId === null ? macrosOf(product) : null,
    pieceWeightG: product.pieceWeightG,
    expiryDate: null,
    aPeser: false,
  }
}

/**
 * Complete un brouillon avec ce qu'OpenFoodFacts vient de rendre.
 *
 * On ne remplace JAMAIS une saisie : la reponse arrive apres une seconde de
 * reseau de magasin, et l'utilisateur a pu commencer a taper le prix pendant
 * ce temps. Voir son montant disparaitre sous ses doigts est la facon la plus
 * sure de lui faire fermer l'application.
 */
export function mergeProduct(draft: ItemDraft, product: Ingredient): ItemDraft {
  const found = draftFromProduct(draft.ean, product)
  return {
    ...found,
    name: draft.name.trim() === '' ? found.name : draft.name,
    brand: draft.brand.trim() === '' ? found.brand : draft.brand,
    quantityG: draft.quantityG ?? found.quantityG,
    priceEur: draft.priceEur ?? found.priceEur,
    expiryDate: draft.expiryDate,
    aPeser: draft.aPeser,
  }
}

/** Brouillon d'une ligne deja au chariot, pour la corriger. */
export function draftFromItem(item: SessionItem): ItemDraft {
  return {
    ean: item.ean,
    name: item.name,
    brand: item.brand ?? '',
    quantityG: item.quantityG,
    priceEur: item.priceEur === null ? null : Number(item.priceEur),
    ingredientId: item.ingredientId,
    macros: item.macros,
    pieceWeightG: item.pieceWeightG,
    expiryDate: item.expiryDate,
    aPeser: item.aPeser,
  }
}

/** Les champs qu'une lecture de Savarin peut remplir, pour les encadrer de jaune. */
export type ChampLu = 'name' | 'brand' | 'quantityG' | 'priceEur' | 'expiryDate'

/**
 * Pose dans le brouillon ce que Savarin a lu sur les photos d'un article.
 *
 * `avant` est le brouillon AU MOMENT DE L'ENVOI des photos. La lecture arrive
 * des secondes plus tard, parfois feuille fermee : un champ que la personne a
 * touche entre-temps garde sa valeur, un champ intact prend celle de Savarin,
 * meme s'il en avait une (la contenance d'OpenFoodFacts, un prix ancien) : on
 * a photographie le poids et le prix pour qu'ils soient pris. Le nom et la
 * marque, eux, ne remplissent qu'un champ VIDE : apres un code-barres, ils
 * viennent deja de la fiche, et les photos visaient le prix, le poids et la
 * date. L'utilisateur prefere aller vite : rien n'est relu avant d'ecrire.
 */
export function appliquerArticle(
  draft: ItemDraft,
  avant: ItemDraft,
  lu: ArticleLu,
  aujourdhui: string,
): { readonly draft: ItemDraft; readonly champs: readonly ChampLu[] } {
  const suite: { -readonly [K in keyof ItemDraft]?: ItemDraft[K] } = {}
  const champs: ChampLu[] = []

  // UN AUTRE PRODUIT que celui du code-barres : la base collaborative s'est
  // trompee (des tenders sous "Mini saucissons"). La face avant fait foi pour
  // le nom et la marque, et les valeurs nutritionnelles venues avec le mauvais
  // nom sont ecartees : la fiche naitra sans valeurs, a completer. Seulement
  // pour un produit encore inconnu de la bibliotheque (celle-ci a deja ete
  // relue), et si le nom n'a pas ete touche depuis l'envoi.
  const corrige = lu.autreProduit && lu.nom !== null && draft.ingredientId === null && draft.name === avant.name
  if (corrige && lu.nom !== null) {
    suite.name = lu.nom
    suite.brand = lu.marque ?? ''
    suite.macros = null
    champs.push('name', 'brand')
  } else {
    if (lu.nom !== null && draft.name.trim() === '') {
      suite.name = lu.nom
      champs.push('name')
    }
    if (lu.marque !== null && draft.brand.trim() === '') {
      suite.brand = lu.marque
      champs.push('brand')
    }
  }
  const quantiteIntacte = draft.quantityG === avant.quantityG && draft.pieceWeightG === avant.pieceWeightG
  if (lu.contenanceG !== null && quantiteIntacte) {
    if (lu.pese) {
      // Etiquette de balance : un poids pese n'est pas une piece.
      suite.quantityG = lu.contenanceG
    } else {
      // "12 x 125 g" : le lot, dont l'unite devient la piece.
      suite.quantityG = (lu.nombre ?? 1) * lu.contenanceG
      suite.pieceWeightG = lu.contenanceG
    }
    // Un poids lu est un poids connu : plus rien a peser en caisse.
    suite.aPeser = false
    champs.push('quantityG')
  }
  if (lu.prixEur !== null && draft.priceEur === avant.priceEur) {
    suite.priceEur = lu.prixEur
    champs.push('priceEur')
  }
  const date = lu.dateTexte === null ? null : parseDateLue(lu.dateTexte, aujourdhui)
  if (date !== null && draft.expiryDate === avant.expiryDate) {
    suite.expiryDate = date.date
    champs.push('expiryDate')
  }
  return { draft: { ...draft, ...suite }, champs }
}

/**
 * L'article tel qu'il part au chariot depuis le SCAN EN CHAINE : sans
 * exigence. Le nom ou le poids peuvent manquer, Savarin les lit en
 * arriere-plan sur les photos ; la validation des courses refusera ce qui
 * manquerait encore. La saisie a la main, elle, passe par `readDraft`.
 */
export function brouillonEnArticle(draft: ItemDraft): SessionItemWrite {
  const brand = draft.brand.trim()
  return {
    ean: draft.ean,
    name: draft.name.trim(),
    brand: brand === '' ? null : brand,
    quantityG: draft.quantityG !== null && draft.quantityG > 0 ? draft.quantityG : null,
    aPeser: draft.aPeser,
    priceEur: draft.priceEur === null || draft.priceEur <= 0 ? null : draft.priceEur.toFixed(2),
    ingredientId: draft.ingredientId,
    macros: draft.macros,
    pieceWeightG: draft.pieceWeightG,
    expiryDate: draft.expiryDate,
  }
}

export type DraftReading =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'ready'; readonly item: SessionItemWrite }

/**
 * Ce que vaut le brouillon au moment de l'envoyer.
 *
 * Deux exigences seulement, et ce sont celles du serveur : un nom, et une
 * quantite strictement positive. Le prix, lui, est facultatif — on scanne
 * parfois plus vite qu'on ne lit les etiquettes, et un article sans prix vaut
 * mieux qu'un article oublie.
 */
export function readDraft(draft: ItemDraft): DraftReading {
  const name = draft.name.trim()
  if (name === '') return { kind: 'invalid', message: 'Donne un nom à cet article.' }

  // Un article "a peser en caisse" n'a pas encore de poids : le ticket le
  // donnera. Une quantite estimee ("3 tomates") reste permise.
  const quantite = draft.quantityG !== null && draft.quantityG > 0 ? draft.quantityG : null
  if (quantite === null && !draft.aPeser) {
    return { kind: 'invalid', message: 'Indique la quantité mise dans le chariot.' }
  }

  const brand = draft.brand.trim()
  return {
    kind: 'ready',
    item: {
      ean: draft.ean,
      name,
      brand: brand === '' ? null : brand,
      quantityG: quantite,
      aPeser: draft.aPeser,
      // Chaine decimale et non flottant : 0,1 € n'a pas de representation
      // binaire exacte et l'ecart s'accumule sur trente articles. Le serveur
      // refuse d'ailleurs tout ce qui ne ressemble pas a « 2.49 ».
      //
      // Un montant nul ou negatif est traite comme une absence de prix plutot
      // que comme une erreur : le champ affiche deja le zero comme une case
      // vide (`emptyOnZero`), et signaler une faute sur un champ qui PARAIT
      // vide n'aide personne.
      priceEur: draft.priceEur === null || draft.priceEur <= 0 ? null : draft.priceEur.toFixed(2),
      ingredientId: draft.ingredientId,
      macros: draft.macros,
      pieceWeightG: draft.pieceWeightG,
      expiryDate: draft.expiryDate,
    },
  }
}
