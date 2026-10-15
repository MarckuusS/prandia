import { describe, expect, it } from 'vitest'

import { interpretTicket, mergeTicketReadings, ticketQuestion, type TicketArticle } from './ticket.js'

const CHARIOT: TicketArticle[] = [
  { id: 'a', name: 'Tomates grappe', brand: null, quantityG: null, priceEur: null, aPeser: true },
  { id: 'b', name: 'Yaourt nature', brand: 'Danone', quantityG: 500, priceEur: '1.89', aPeser: false },
  { id: 'c', name: 'Thon à l’huile', brand: 'Nixe', quantityG: 240, priceEur: null, aPeser: false },
]

describe('ticketQuestion', () => {
  it('numerote le chariot et dit ce qui est a peser et ce qui a deja un prix', () => {
    const q = ticketQuestion(CHARIOT)
    expect(q).toContain('1 : Tomates grappe (a peser)')
    expect(q).toContain('2 : Yaourt nature (Danone, 500 g, prix saisi 1.89 EUR)')
    expect(q).toContain('3 : Thon à l’huile (Nixe, 240 g)')
  })

  it('deduit une remise immediate de son article, et ignore les remises globales', () => {
    // Carrefour, 2026-10-15 : avocats 2,98 puis remise -0,48 sous la ligne, bon de reduction de 1 EUR.
    const q = ticketQuestion(CHARIOT)
    expect(q).toContain('se deduit du prix de CET article')
    expect(q).toContain('bon de reduction')
  })
})

describe('interpretTicket', () => {
  it('rend le poids et le prix lus pour chaque article retrouve', () => {
    const r = interpretTicket(
      {
        correspondances: [
          { article: 1, libelle: 'TOMATE GRAPPE', poids: 0.734, unite: 'kg', prix: 2.19 },
          { article: 3, libelle: 'THON HUILE NIXE', poids: null, unite: null, prix: 3.45 },
        ],
        hors_chariot: [{ libelle: 'SAC CABAS', prix: 0.1 }],
      },
      CHARIOT,
    )
    expect(r.matches).toEqual([
      { itemId: 'a', libelle: 'TOMATE GRAPPE', poidsG: 734, prixEur: 2.19 },
      { itemId: 'c', libelle: 'THON HUILE NIXE', poidsG: null, prixEur: 3.45 },
    ])
    expect(r.horsChariot).toEqual([{ libelle: 'SAC CABAS', prixEur: 0.1 }])
  })

  it('ecarte un numero inexistant, un article servi deux fois, une remise, une ligne vide', () => {
    const r = interpretTicket(
      {
        correspondances: [
          { article: 9, libelle: 'X', poids: null, unite: null, prix: 1 },
          { article: 2, libelle: 'YAOURT', poids: null, unite: null, prix: 1.89 },
          { article: 2, libelle: 'YAOURT BIS', poids: null, unite: null, prix: 1.99 },
          { article: 3, libelle: 'REMISE', poids: null, unite: null, prix: -0.5 },
          { article: 1, libelle: 'TOMATE', poids: 'illisible', unite: 'kg', prix: null },
        ],
        hors_chariot: [],
      },
      CHARIOT,
    )
    expect(r.matches).toEqual([{ itemId: 'b', libelle: 'YAOURT', poidsG: null, prixEur: 1.89 }])
  })

  it('rend une lecture vide sur une reponse mal formee', () => {
    expect(interpretTicket(null, CHARIOT)).toEqual({ matches: [], horsChariot: [] })
  })
})

describe('mergeTicketReadings', () => {
  it('ajoute la suite du ticket sans servir deux fois un article ni repeter une ligne', () => {
    const haut = interpretTicket(
      {
        correspondances: [{ article: 1, libelle: 'TOMATE', poids: 734, unite: 'g', prix: 2.19 }],
        hors_chariot: [{ libelle: 'SAC', prix: 0.1 }],
      },
      CHARIOT,
    )
    const bas = interpretTicket(
      {
        correspondances: [
          { article: 1, libelle: 'TOMATE', poids: 734, unite: 'g', prix: 2.19 },
          { article: 3, libelle: 'THON', poids: null, unite: null, prix: 3.45 },
        ],
        hors_chariot: [{ libelle: 'SAC', prix: 0.1 }],
      },
      CHARIOT,
    )
    const tout = mergeTicketReadings(haut, bas)
    expect(tout.matches.map((m) => m.itemId)).toEqual(['a', 'c'])
    expect(tout.horsChariot).toHaveLength(1)
  })
})
