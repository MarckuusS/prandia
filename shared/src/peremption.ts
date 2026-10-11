/**
 * Lire une date de peremption dans un texte : tape au clavier, ou lu sur
 * l'emballage par l'iPhone ("Scanner le texte", la lecture de texte du
 * systeme, offerte dans tout champ de saisie).
 *
 * POURQUOI UN TEXTE ET NON LE SELECTEUR DE DATE. Le selecteur natif d'iOS
 * impose trois roues a faire tourner ; la lecture du systeme, elle, ne remplit
 * qu'un champ TEXTE, et rend ce qu'elle voit tel quel : "A consommer
 * jusqu'au 14/10/25 L5285 12:41". Cette fonction en retrouve la date.
 *
 * AUCUNE DATE N'EST DEVINEE. Une duree de conservation apprise d'un achat
 * precedent a ete envisagee puis ecartee : pour un meme produit, l'ecart entre
 * l'achat et la date varie de plusieurs jours selon la rotation du rayon, et
 * une date fausse declenche de faux rappels. Seule la date imprimee fait foi.
 */

import { normalizeName } from './text.js'

export interface ExpiryReading {
  /** 'AAAA-MM-JJ'. Pour une date au mois, le dernier jour du mois. */
  readonly date: string
  /**
   * 'jour' pour une date complete (DLC), 'mois' pour "a consommer de
   * preference avant fin 03/2027" (DDM), qui vaut jusqu'au dernier jour.
   */
  readonly precision: 'jour' | 'mois'
}

/** Les mois, par leurs abreviations d'emballage, francaises et anglaises. */
const MOIS: Readonly<Record<string, number>> = {
  jan: 1, janv: 1, fev: 2, fevr: 2, feb: 2, mar: 3, mars: 3, avr: 4, apr: 4, mai: 5, may: 5,
  juin: 6, jun: 6, juil: 7, jul: 7, aou: 8, aout: 8, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11,
  dec: 12,
}

function moisDuMot(mot: string): number | null {
  for (const cle of [mot, mot.slice(0, 4), mot.slice(0, 3)]) {
    const m = MOIS[cle]
    if (m !== undefined) return m
  }
  return null
}

const deuxChiffres = (n: number) => String(n).padStart(2, '0')

/** La date si elle existe au calendrier ("31/02" n'existe pas), sinon `null`. */
function dateValide(annee: number, mois: number, jour: number): string | null {
  if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null
  const d = new Date(Date.UTC(annee, mois - 1, jour))
  if (d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) return null
  return `${annee}-${deuxChiffres(mois)}-${deuxChiffres(jour)}`
}

const finDeMois = (annee: number, mois: number): string =>
  `${annee}-${deuxChiffres(mois)}-${deuxChiffres(new Date(Date.UTC(annee, mois, 0)).getUTCDate())}`

/** "25" vaut 2025 : aucun emballage ne porte une date du siecle dernier. */
const anneePleine = (brute: string): number => (brute.length === 2 ? 2000 + Number(brute) : Number(brute))

/** 'AAAA-MM-JJ' plus `jours`, au calendrier (UTC, sans heure d'ete). */
export function addDaysIso(iso: string, jours: number): string {
  const [a, m, j] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(a ?? 1970, (m ?? 1) - 1, (j ?? 1) + jours))
  return `${d.getUTCFullYear()}-${deuxChiffres(d.getUTCMonth() + 1)}-${deuxChiffres(d.getUTCDate())}`
}

/**
 * Separateur entre jour, mois et annee : point, barre, tiret, ou espaces seuls.
 * Les deux-points sont exclus : "12:41" est l'heure de fabrication.
 */
const SEP = String.raw`(?:\s*[./-]\s*|\s+)`

/*
 * Pas d'assertion arriere (`(?<!\d)`) : Safari ne la lit que depuis la 16.4,
 * et une expression qu'il ne sait pas lire fait echouer tout le paquet. Un
 * prefixe `(?:^|\D)` consomme a la place le caractere qui precede.
 */
const JOUR_MOIS_ANNEE = new RegExp(String.raw`(?:^|\D)(\d{1,2})${SEP}(\d{1,2})${SEP}(\d{4}|\d{2})(?=\D|$)`, 'g')
const JOUR_NOM_ANNEE = /(?:^|[^\d])(\d{1,2})\s*(?:er)?\s*([a-z]{3,9})\.?(?:\s*(\d{4}|\d{2}))?(?=\D|$)/g
const NOM_ANNEE = /(?:^|[^a-z])([a-z]{3,9})\.?\s*(\d{4})(?=\D|$)/g
const MOIS_ANNEE = /(?:^|\D)(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})(?=\D|$)/g
const JOUR_MOIS = /(?:^|\D)(\d{1,2})\s*[./-]\s*(\d{1,2})(?=\D|$)/g

/**
 * La date de peremption lue dans `texte`, ou `null`.
 *
 * `aujourdhui` ('AAAA-MM-JJ') sert a deux choses : ecarter une annee absurde
 * (un numero de lot pris pour une date) et dater un "14/10" sans annee.
 *
 * Quand le texte porte plusieurs dates completes, la PLUS TARDIVE l'emporte :
 * un emballage imprime parfois la date de fabrication a cote, et elle precede
 * toujours celle de peremption.
 */
export function parseExpiryText(texte: string, aujourdhui: string): ExpiryReading | null {
  const t = normalizeName(texte)
  if (t === '') return null
  const annee = Number(aujourdhui.slice(0, 4))
  const plausible = (a: number) => a >= annee - 2 && a <= annee + 15

  // 1. Dates completes : "14/10/25", "14.10.2025", "14 OCT 2025".
  const completes: string[] = []
  for (const m of t.matchAll(JOUR_MOIS_ANNEE)) {
    const a = anneePleine(m[3] ?? '')
    const d = plausible(a) ? dateValide(a, Number(m[2]), Number(m[1])) : null
    if (d !== null) completes.push(d)
  }
  for (const m of t.matchAll(JOUR_NOM_ANNEE)) {
    const mois = moisDuMot(m[2] ?? '')
    if (mois === null || m[3] === undefined) continue
    const a = anneePleine(m[3])
    const d = plausible(a) ? dateValide(a, mois, Number(m[1])) : null
    if (d !== null) completes.push(d)
  }
  // Tape d'un trait au clavier : "141025" ou "14102025". Seulement quand le
  // texte n'est QUE des chiffres, sinon un numero de lot passerait pour une date.
  const nu = /^(\d{2})(\d{2})(\d{2}|\d{4})$/.exec(t.replace(/\s/g, ''))
  if (nu) {
    const a = anneePleine(nu[3] ?? '')
    const d = plausible(a) ? dateValide(a, Number(nu[2]), Number(nu[1])) : null
    if (d !== null) completes.push(d)
  }
  const plusTardive = completes.sort()[completes.length - 1]
  if (plusTardive !== undefined) return { date: plusTardive, precision: 'jour' }

  // Une date complete ecartee (annee absurde, jour inexistant) ne doit pas
  // revenir par les regles suivantes : "14/10/99" n'est pas un "14/10".
  const reste = t.replace(JOUR_MOIS_ANNEE, ' ')

  // 2. Au mois : "03/2027", "MARS 2027", "03/27" (27 ne peut pas etre un mois).
  for (const m of reste.matchAll(MOIS_ANNEE)) {
    const mois = Number(m[1])
    const brute = m[2] ?? ''
    if (brute.length === 2 && Number(brute) <= 12) continue
    const a = anneePleine(brute)
    if (mois >= 1 && mois <= 12 && plausible(a)) return { date: finDeMois(a, mois), precision: 'mois' }
  }
  for (const m of reste.matchAll(NOM_ANNEE)) {
    const mois = moisDuMot(m[1] ?? '')
    const a = Number(m[2])
    if (mois !== null && plausible(a)) return { date: finDeMois(a, mois), precision: 'mois' }
  }

  // 3. Sans annee : "14/10", "14 oct". L'annee est celle qui met la date au
  // plus pres d'aujourd'hui sans la renvoyer a plus de deux mois en arriere :
  // un produit deja perime de quelques jours se range encore, un "05/01" lu en
  // octobre est celui de janvier prochain.
  const sansAnnee: Array<[number, number]> = []
  for (const m of reste.matchAll(JOUR_MOIS)) sansAnnee.push([Number(m[1]), Number(m[2])])
  for (const m of reste.matchAll(JOUR_NOM_ANNEE)) {
    const mois = moisDuMot(m[2] ?? '')
    if (mois !== null && m[3] === undefined) sansAnnee.push([Number(m[1]), mois])
  }
  const limite = addDaysIso(aujourdhui, -60)
  for (const [jour, mois] of sansAnnee) {
    const cetteAnnee = dateValide(annee, mois, jour)
    if (cetteAnnee === null) continue
    const date = cetteAnnee < limite ? dateValide(annee + 1, mois, jour) : cetteAnnee
    if (date !== null) return { date, precision: 'jour' }
  }
  return null
}

/**
 * L'annee d'une date BIEN FORMEE mais hors de portee, ou `null`.
 *
 * "30.06.2081" lu sur une boite de thon (constate le 2026-10-11) : le jour et
 * le mois existent, l'annee est a cinquante-cinq ans. La lecture s'est
 * trompee d'un chiffre, et "date non reconnue" ne disait pas lequel : l'ecran
 * nomme desormais l'annee a corriger.
 */
export function implausibleExpiryYear(texte: string, aujourdhui: string): number | null {
  const annee = Number(aujourdhui.slice(0, 4))
  for (const m of normalizeName(texte).matchAll(JOUR_MOIS_ANNEE)) {
    const a = anneePleine(m[3] ?? '')
    if (a >= annee - 2 && a <= annee + 15) continue
    if (dateValide(a, Number(m[2]), Number(m[1])) !== null) return a
  }
  return null
}

/** 'AAAA-MM-JJ' en "14/10/25", la forme qu'on lit et qu'on tape. */
export function formatExpiryInput(iso: string): string {
  const [a, m, j] = iso.split('-')
  return a !== undefined && m !== undefined && j !== undefined ? `${j}/${m}/${a.slice(2)}` : iso
}
