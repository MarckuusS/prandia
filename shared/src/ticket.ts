/**
 * Lire un ticket de caisse contre le chariot : le poids et le prix de chaque
 * article, tels que la caisse les a comptes.
 *
 * Le vrac se pese souvent EN CAISSE : au rayon, il n'existe ni poids ni prix
 * a lire. Le seul document qui les porte est le ticket ("TOMATE GRAPPE 0,734
 * kg x 2,99 EUR/kg 2,19"). Le modele recoit la photo ET la liste numerotee du
 * chariot, et rend pour chaque ligne du ticket l'article qu'elle paie. Il fait
 * le rapprochement des intitules abreges ("TOM GRAP" pour "Tomates grappe"),
 * ce qu'aucune regle ecrite ne ferait d'une enseigne a l'autre.
 *
 * Un long ticket se lit en plusieurs photos : chaque lecture rend ce qu'elle
 * voit, et l'ecran fusionne. Rien n'est ecrit sans la revue de la personne.
 */

import type { ScanTool } from './scan.js'

/** Un article du chariot, tel qu'on le decrit au modele. */
export interface TicketArticle {
  readonly id: string
  readonly name: string
  readonly brand: string | null
  readonly quantityG: number | null
  readonly priceEur: string | null
  readonly aPeser: boolean
}

/** Ce que le ticket dit d'un article du chariot. */
export interface TicketMatch {
  readonly itemId: string
  readonly libelle: string | null
  readonly poidsG: number | null
  readonly prixEur: number | null
}

export interface TicketReading {
  readonly matches: readonly TicketMatch[]
  /** Payes mais absents du chariot : un oubli de scan, ou un sac. */
  readonly horsChariot: ReadonlyArray<{ readonly libelle: string; readonly prixEur: number | null }>
  /** L'enseigne imprimee en tete du ticket : le magasin des courses, quand on ne l'a pas dit. */
  readonly magasin: string | null
}

const texteOuNul = { type: ['string', 'null'] }
const nombreOuNul = { type: ['number', 'null'] }

export const TICKET_TOOL: ScanTool = {
  name: 'ticket_lu',
  description: 'Rend, pour chaque ligne du ticket, l’article du chariot qu’elle paie.',
  input_schema: {
    type: 'object',
    properties: {
      correspondances: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            article: { type: 'integer', description: 'Numero de l’article du chariot.' },
            libelle: { ...texteOuNul, description: 'L’intitule tel qu’imprime sur le ticket.' },
            poids: { ...nombreOuNul, description: 'Poids net si la ligne en indique un.' },
            unite: { type: ['string', 'null'], enum: ['g', 'kg', null] },
            prix: { ...nombreOuNul, description: 'Prix paye pour cet article, en euros.' },
          },
          required: ['article', 'libelle', 'poids', 'unite', 'prix'],
        },
      },
      hors_chariot: {
        type: 'array',
        items: {
          type: 'object',
          properties: { libelle: { type: 'string' }, prix: { ...nombreOuNul } },
          required: ['libelle', 'prix'],
        },
      },
      magasin: { ...texteOuNul, description: 'L’enseigne imprimee en tete du ticket, ex. Carrefour, Lidl, ou null.' },
    },
    required: ['correspondances', 'hors_chariot', 'magasin'],
  },
}

const grammesLisibles = (g: number) => (g >= 1000 ? `${(g / 1000).toLocaleString('fr-FR')} kg` : `${Math.round(g)} g`)

export function ticketQuestion(articles: readonly TicketArticle[]): string {
  const lignes = articles.map((a, i) => {
    const details = [
      a.brand,
      a.aPeser || a.quantityG === null ? 'a peser' : grammesLisibles(a.quantityG),
      a.priceEur === null ? null : `prix saisi ${a.priceEur} EUR`,
    ].filter(Boolean)
    return `${i + 1} : ${a.name === '' ? '(nom en cours de lecture)' : a.name}${details.length > 0 ? ` (${details.join(', ')})` : ''}`
  })
  return [
    'Photo d’un ticket de caisse, entier ou en partie. Donne aussi l’enseigne imprimee en tete (magasin), si elle est visible. Voici les articles du chariot, numerotes :',
    ...lignes,
    '',
    'Pour chaque ligne du ticket qui paie un article du chariot, donne le numero de l’article, l’intitule tel qu’imprime, le poids net si la ligne en indique un, et le prix paye pour cet article : le montant de la ligne, divise si elle regroupe plusieurs articles identiques du chariot. Une remise immediate imprimee juste sous un article (montant negatif, "Remise Immediate") se deduit du prix de CET article : "Avocat 2,98" puis "Remise -0,48", le prix paye est 2,50. Les lignes du ticket sans article correspondant vont dans hors_chariot. Ignore les sous-totaux, le total, la TVA, les remises globales (bon de reduction, remise sur le total) et les moyens de paiement.',
  ].join('\n')
}

const nombre = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

const prixBorne = (v: unknown): number | null => {
  const p = nombre(v)
  return p !== null && p >= 0.01 && p <= 500 ? Math.round(p * 100) / 100 : null
}

const texte = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null

/**
 * La lecture, reduite a ce qui est sur : un numero d'article qui existe, un
 * article servi une seule fois (la premiere ligne l'emporte), un poids de 1 g
 * a 20 kg, un prix d'un centime a 500 EUR. Une remise (montant negatif) n'est
 * pas un prix d'article.
 */
export function interpretTicket(entree: unknown, articles: readonly TicketArticle[]): TicketReading {
  const o = (entree !== null && typeof entree === 'object' ? entree : {}) as Record<string, unknown>
  const matches: TicketMatch[] = []
  const servis = new Set<string>()

  for (const brut of Array.isArray(o['correspondances']) ? o['correspondances'] : []) {
    if (brut === null || typeof brut !== 'object') continue
    const c = brut as Record<string, unknown>
    const numero = nombre(c['article'])
    const article = numero !== null && Number.isInteger(numero) ? articles[numero - 1] : undefined
    if (article === undefined || servis.has(article.id)) continue
    const facteur = c['unite'] === 'kg' ? 1000 : c['unite'] === 'g' ? 1 : null
    const poids = nombre(c['poids'])
    const poidsG = facteur !== null && poids !== null && poids * facteur >= 1 && poids * facteur <= 20_000
      ? Math.round(poids * facteur * 10) / 10
      : null
    const prixEur = prixBorne(c['prix'])
    if (poidsG === null && prixEur === null) continue
    servis.add(article.id)
    matches.push({ itemId: article.id, libelle: texte(c['libelle'], 60), poidsG, prixEur })
  }

  const horsChariot: Array<{ libelle: string; prixEur: number | null }> = []
  for (const brut of Array.isArray(o['hors_chariot']) ? o['hors_chariot'] : []) {
    if (brut === null || typeof brut !== 'object') continue
    const h = brut as Record<string, unknown>
    const libelle = texte(h['libelle'], 60)
    if (libelle !== null) horsChariot.push({ libelle, prixEur: prixBorne(h['prix']) })
  }
  return { matches, horsChariot, magasin: texte(o['magasin'], 40) }
}

/**
 * Fusionner une nouvelle lecture (la suite du ticket) dans la precedente : un
 * article deja servi garde sa premiere correspondance, une ligne hors chariot
 * deja vue (meme intitule, meme prix) n'est pas repetee.
 */
export function mergeTicketReadings(avant: TicketReading, apres: TicketReading): TicketReading {
  const servis = new Set(avant.matches.map((m) => m.itemId))
  const vus = new Set(avant.horsChariot.map((h) => `${h.libelle}|${h.prixEur}`))
  return {
    matches: [...avant.matches, ...apres.matches.filter((m) => !servis.has(m.itemId))],
    horsChariot: [...avant.horsChariot, ...apres.horsChariot.filter((h) => !vus.has(`${h.libelle}|${h.prixEur}`))],
    // La suite d'un ticket n'a souvent plus l'en-tete : la premiere enseigne lue reste.
    magasin: avant.magasin ?? apres.magasin,
  }
}
