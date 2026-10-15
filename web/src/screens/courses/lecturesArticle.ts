/**
 * Les lectures de Savarin EN ARRIERE-PLAN, au chariot (decision du 2026-10-14).
 *
 * En magasin, on mitraille le prix, le poids et la date d'un article, on
 * envoie, et l'on va chercher l'article suivant pendant que Savarin lit :
 * attendre chaque reponse devant le rayon faisait perdre le temps que les
 * photos devaient faire gagner. PLUSIEURS lectures tournent a la fois, une
 * par article, et aucune n'attend la precedente.
 *
 * Une lecture survit donc a la feuille qui l'a lancee, et meme a l'ecran du
 * chariot : elle vit ici, hors de React, et ecrit dans l'article par
 * `modifierArticleEnFond` (qui passe dans la file des ecritures du chariot).
 * L'utilisateur prefere aller vite : ce qui est lu s'ecrit sans relecture, et
 * la ligne du chariot porte Savarin jusqu'a ce qu'on la rouvre.
 *
 * Trois cas pour une reponse qui arrive :
 *   - une feuille ouverte l'ecoute (l'article qu'on est en train d'ajouter, ou
 *     de corriger) : elle va dans son brouillon, encadree de jaune ;
 *   - l'article est au chariot : elle y est ecrite, en arriere-plan ;
 *   - l'article est en train d'etre ajoute (`detacher`) : elle attend son
 *     identifiant (`rattacher`), puis elle y est ecrite.
 *
 * RIEN N'EST CONSERVE au rechargement de la page : une lecture interrompue est
 * perdue, l'article reste tel qu'il a ete ajoute. Les photos ne quittent la
 * memoire qu'apres une lecture reussie, pour pouvoir relancer celle qui a
 * echoue (reseau du magasin, ecran verrouille).
 */

import { useSyncExternalStore } from 'react'
import { isEmptyArticle, todayLocalIsoDate, type ArticleLu } from '@prandia/shared'

import { lireArticle, modifierArticleEnFond } from '../../lib/queries.js'
import { appliquerArticle, draftFromItem, readDraft, type ChampLu, type ItemDraft } from './sessionDraft.js'

export type EtatLecture = 'lecture' | 'lue' | 'echec'

export interface Lecture {
  readonly cle: string
  /** L'article du chariot ; `null` tant que la feuille d'ajout ne l'a pas ajoute. */
  readonly itemId: string | null
  readonly etat: EtatLecture
  /** Ce que Savarin a rempli dans l'article, a encadrer quand on le rouvre. */
  readonly champs: readonly ChampLu[]
  readonly erreur: string | null
  /** La ligne a ete rouverte depuis la lecture : Savarin s'en va. */
  readonly vue: boolean
}

export type Ecouteur = (lu: ArticleLu, avant: ItemDraft) => void

interface Interne {
  lecture: Lecture
  photos: readonly Blob[]
  /** Le brouillon a l'envoi des photos : un champ touche depuis garde sa valeur. */
  avant: ItemDraft
  resultat: ArticleLu | null
  ecouteur: Ecouteur | null
  /** L'article est en cours d'ajout : la reponse attend son identifiant. */
  attente: boolean
  /** La reponse est deja dans le brouillon d'une feuille ouverte. */
  livree: boolean
}

const entrees = new Map<string, Interne>()
const abonnes = new Set<() => void>()
let instantane: readonly Lecture[] = []

function publier() {
  instantane = [...entrees.values()].map((e) => e.lecture)
  for (const abonne of abonnes) abonne()
}

function poser(e: Interne, suite: Partial<Lecture>) {
  e.lecture = { ...e.lecture, ...suite }
  publier()
}

const abonner = (abonne: () => void) => {
  abonnes.add(abonne)
  return () => abonnes.delete(abonne)
}

/** Toutes les lectures, pour les lignes du chariot et les feuilles. */
export const useLectures = (): readonly Lecture[] => useSyncExternalStore(abonner, () => instantane)

/** La lecture la plus recente d'un article du chariot. */
export const lectureDeLArticle = (lectures: readonly Lecture[], itemId: string): Lecture | undefined =>
  lectures.filter((l) => l.itemId === itemId).at(-1)

export function lancerLecture({
  cle,
  photos,
  avant,
  itemId,
  ecouteur,
}: {
  readonly cle: string
  readonly photos: readonly Blob[]
  readonly avant: ItemDraft
  readonly itemId: string | null
  readonly ecouteur: Ecouteur | null
}) {
  // Une seule lecture par article : relancer des photos remplace l'ancienne.
  if (itemId !== null) for (const [c, e] of entrees) if (e.lecture.itemId === itemId) entrees.delete(c)
  const entree: Interne = {
    lecture: { cle, itemId, etat: 'lecture', champs: [], erreur: null, vue: false },
    photos,
    avant,
    resultat: null,
    ecouteur,
    attente: false,
    livree: false,
  }
  entrees.set(cle, entree)
  publier()
  void executer(entree)
}

async function executer(e: Interne) {
  let lu: ArticleLu
  try {
    lu = await lireArticle(e.photos, { nom: e.avant.name, marque: e.avant.brand, grammes: e.avant.quantityG })
  } catch (erreur) {
    if (entrees.get(e.lecture.cle) !== e) return
    poser(e, { etat: 'echec', erreur: erreur instanceof Error ? erreur.message : 'La lecture a échoué.' })
    return
  }
  // Abandonnee (feuille annulee) ou remplacee pendant la lecture.
  if (entrees.get(e.lecture.cle) !== e) return
  if (isEmptyArticle(lu)) {
    poser(e, { etat: 'echec', erreur: 'Savarin n’a rien pu lire sur ces photos.' })
    return
  }
  e.resultat = lu
  e.photos = []
  await livrer(e)
}

async function livrer(e: Interne) {
  const lu = e.resultat
  if (lu === null) return
  if (e.ecouteur !== null && !e.livree) {
    e.ecouteur(lu, e.avant)
    e.livree = true
  }
  const itemId = e.lecture.itemId
  if (itemId === null) {
    // Dans le brouillon d'une feuille d'ajout, ou en attente de son identifiant.
    if (e.livree) poser(e, { etat: 'lue', vue: true })
    return
  }
  let champs: readonly ChampLu[] = []
  let existe: boolean
  try {
    existe = await modifierArticleEnFond(itemId, (item) => {
      const applique = appliquerArticle(draftFromItem(item), e.avant, lu, todayLocalIsoDate())
      champs = applique.champs
      if (champs.length === 0) return null
      const lecture = readDraft(applique.draft)
      return lecture.kind === 'ready' ? lecture.item : null
    })
  } catch (erreur) {
    poser(e, { etat: 'echec', erreur: erreur instanceof Error ? erreur.message : 'L’article n’a pas pu être mis à jour.' })
    return
  }
  if (!existe) {
    // Retire du chariot pendant la lecture : rien a montrer.
    entrees.delete(e.lecture.cle)
    publier()
    return
  }
  poser(e, { etat: 'lue', champs, vue: e.livree })
}

/** L'article part au chariot : la reponse, si elle arrive, attend son identifiant. */
export function detacher(cle: string) {
  const e = entrees.get(cle)
  if (e === undefined) return
  e.ecouteur = null
  e.attente = true
}

/** L'ajout a echoue, la feuille reste ouverte : elle reprend la reponse. */
export function reprendre(cle: string, ecouteur: Ecouteur) {
  const e = entrees.get(cle)
  if (e === undefined) return
  e.attente = false
  ecouter(cle, ecouteur)
}

/** L'article est au chariot, sous cet identifiant. */
export function rattacher(cle: string, itemId: string) {
  const e = entrees.get(cle)
  if (e === undefined) return
  e.attente = false
  e.ecouteur = null
  if (e.livree) {
    // La reponse est deja dans ce qui vient d'etre ajoute.
    entrees.delete(cle)
    publier()
    return
  }
  poser(e, { itemId })
  if (e.resultat !== null) void livrer(e)
}

/** Une feuille ouverte veut la reponse dans son brouillon. Rend de quoi se desabonner. */
export function ecouter(cle: string, ecouteur: Ecouteur): () => void {
  const e = entrees.get(cle)
  if (e === undefined) return () => undefined
  e.ecouteur = ecouteur
  if (e.resultat !== null && !e.livree) {
    ecouteur(e.resultat, e.avant)
    e.livree = true
  }
  return () => {
    if (e.ecouteur === ecouteur) e.ecouteur = null
  }
}

/**
 * La feuille d'ajout se ferme. Annulee, sa lecture n'a plus de destination :
 * elle est oubliee. En cours d'ajout, elle attend son identifiant.
 */
export function quitterFeuille(cle: string) {
  const e = entrees.get(cle)
  if (e === undefined) return
  e.ecouteur = null
  if (e.lecture.itemId === null && !e.attente) {
    entrees.delete(cle)
    publier()
  }
}

/** La ligne a ete rouverte : Savarin s'eteint sur elle. */
export function marquerVue(cle: string) {
  const e = entrees.get(cle)
  if (e !== undefined && !e.lecture.vue) poser(e, { vue: true })
}

/** Relancer une lecture echouee, avec les memes photos. */
export function relancer(cle: string) {
  const e = entrees.get(cle)
  if (e === undefined || e.photos.length === 0) return
  e.livree = false
  poser(e, { etat: 'lecture', erreur: null, vue: false })
  void executer(e)
}

export const peutRelancer = (cle: string): boolean => (entrees.get(cle)?.photos.length ?? 0) > 0

/** Les courses sont terminees ou abandonnees : plus aucun article a remplir. */
export function oublierLectures() {
  entrees.clear()
  publier()
}
