/**
 * Les quatre espaces de "Chez moi", et ce qui les distingue.
 *
 * TROIS ESPACES ET UN QUATRIEME ETAT, et la nuance porte tout l'ecran :
 * "A ranger" n'est pas un lieu, c'est l'absence de lieu. Il n'apparait que
 * lorsqu'il contient quelque chose, et il disparait des qu'on l'a vide. Un
 * onglet permanent et vide se lirait comme une fonction cassee.
 *
 * CHAQUE ESPACE A SA LOGIQUE, ce qui justifie de les separer plutot que de
 * poser un filtre de plus sur une seule liste :
 *
 *   frigo       -> des JOURS. La date limite commande, le tri par urgence est
 *                  le defaut, les badges comptent a rebours.
 *   placard     -> un NIVEAU. Le seuil de reappro commande, aucune date ne
 *                  presse, et un compte a rebours rouge sur un paquet de riz
 *                  serait absurde.
 *   congelateur -> du TEMPS PASSE depuis l'entree. On ne compte pas ce qui
 *                  reste, on compte depuis quand c'est la : "encore 3 mois"
 *                  supposerait une table de durees par aliment que personne ne
 *                  publie.
 *
 * Pur : aucune requete, aucun composant. Testable, et surtout recalculable au
 * retour au premier plan sans rien redemander au reseau.
 */

import { STORAGE_LABELS, UNSTORED_LABEL, type StorageSpace } from '@prandia/shared'

import type { Lot } from './lots.js'

/** L'onglet actif. `null` designe l'espace des lots pas encore ranges. */
export type EspaceTab = StorageSpace | null

/** Lu depuis l'URL : l'onglet survit a un rafraichissement devant le frigo. */
export const ESPACE_PARAM: Record<string, EspaceTab> = {
  ranger: null,
  frigo: 'frigo',
  placard: 'placard',
  congelateur: 'congelateur',
}

export const espaceToParam = (espace: EspaceTab): string =>
  espace === null ? 'ranger' : espace

export const espaceLabel = (espace: EspaceTab): string =>
  espace === null ? UNSTORED_LABEL : STORAGE_LABELS[espace]

/** Les lots d'un espace donne. `null` rend ceux qui n'ont pas encore de place. */
export function lotsOf(lots: readonly Lot[], espace: EspaceTab): Lot[] {
  return lots.filter((lot) => lot.stock.storage === espace)
}

export interface EspaceOnglet {
  readonly espace: EspaceTab
  readonly label: string
  readonly count: number
}

/**
 * Les onglets a afficher, dans l'ordre.
 *
 * "A ranger" passe EN PREMIER quand il existe : c'est une file d'attente, pas
 * une categorie, et une file qu'on ne voit pas ne se vide jamais. Il s'efface
 * des qu'elle est vide, ce qui est l'etat normal.
 */
export function onglets(lots: readonly Lot[]): EspaceOnglet[] {
  const compte = (espace: EspaceTab) => lotsOf(lots, espace).length
  const aRanger = compte(null)

  const trois: EspaceOnglet[] = (['frigo', 'placard', 'congelateur'] as const).map((espace) => ({
    espace,
    label: STORAGE_LABELS[espace],
    count: compte(espace),
  }))

  return aRanger > 0
    ? [{ espace: null, label: UNSTORED_LABEL, count: aRanger }, ...trois]
    : trois
}

/**
 * L'onglet a ouvrir quand aucun n'est demande.
 *
 * Ce qui attend d'etre range PASSE AVANT : c'est la seule chose qui demande une
 * action, et c'est l'etat dans lequel on arrive apres des courses. A defaut, le
 * frigo, qui est l'espace ou les choses se perdent.
 */
export function espaceParDefaut(lots: readonly Lot[]): EspaceTab {
  return lotsOf(lots, null).length > 0 ? null : 'frigo'
}

/**
 * Depuis combien de jours ce lot est a sa place.
 *
 * `storageSince` d'abord, `addedAt` en repli : un lot achete en mai et descendu
 * au congelateur en juillet doit compter depuis juillet. Le repli sert aux lots
 * anterieurs a la migration, qui n'ont pas de date d'entree.
 *
 * `null` quand on ne sait pas : on n'ecrit alors rien, plutot que d'ecrire
 * "depuis 0 jour", qui affirmerait une entree du jour meme.
 */
export function joursDepuisEntree(lot: Lot, today: Date): number | null {
  const iso = lot.stock.storageSince ?? lot.stock.addedAt
  if (iso === null || iso === undefined) return null
  const entree = new Date(iso)
  if (Number.isNaN(entree.getTime())) return null

  const jour = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12)
  const ecart = Math.round((jour(today) - jour(entree)) / 86_400_000)
  return ecart < 0 ? 0 : ecart
}

/**
 * "Depuis 6 jours", "depuis 2 mois". En mois au-dela de huit semaines.
 *
 * MESURE, JAMAIS PROJETEE. Le mockup annonce "3 mois" comme une duree
 * restante ; celle-ci est le temps ecoule, qu'on sait, et rien d'autre.
 */
export function formatDepuis(jours: number | null): string | null {
  if (jours === null) return null
  if (jours === 0) return "Rangé aujourd'hui"
  if (jours === 1) return 'Rangé hier'
  if (jours < 56) return `Depuis ${jours} jours`
  const mois = Math.round(jours / 30)
  return `Depuis ${mois} mois`
}
