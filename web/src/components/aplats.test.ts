/**
 * Un seul aplat de couleur par ecran : son action principale.
 *
 * CE TEST EXISTE PARCE QUE LA REGLE A ETE APPLIQUEE ECRAN PAR ECRAN. La feuille
 * d'un repas d'abord, puis le chariot, la recette et l'etiquette, puis le frigo,
 * l'ingredient, le rayon et la croix d'un critere : a chaque passe, d'autres
 * rouges pleins attendaient ailleurs. Il verifie desormais le TEXTE de toutes
 * les sources de l'interface.
 *
 * Le rouge plein garde UNE place, le bouton qui CONFIRME une suppression
 * (`ConfirmDialog`, dans Sheet.tsx) : la, detruire est l'action principale.
 * Retirer s'ecrit partout ailleurs `.button--retrait`, du texte rouge.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ICI = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(ICI, '..')

/** Toutes les sources .tsx de l'interface, tests exclus. */
function sources(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom)
    if (statSync(chemin).isDirectory()) return sources(chemin)
    return nom.endsWith('.tsx') && !nom.includes('.test.') ? [chemin] : []
  })
}

/** La source sans ses commentaires : ce projet raconte ce qu'il a retire. */
const codeSeul = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const FICHIERS = sources(SRC).map((chemin) => ({
  nom: relative(SRC, chemin).replace(/\\/g, '/'),
  code: codeSeul(readFileSync(chemin, 'utf8')),
}))

describe('les aplats de couleur', () => {
  it('lit bien les sources (garde-fou du test lui-meme)', () => {
    expect(FICHIERS.length).toBeGreaterThan(50)
    expect(FICHIERS.some((f) => f.nom === 'components/Sheet.tsx')).toBe(true)
  })

  it('ne pose le rouge plein que sur le bouton qui confirme', () => {
    const fautifs = FICHIERS.filter((f) => f.code.includes('button--danger')).map((f) => f.nom)
    expect(fautifs).toEqual(['components/Sheet.tsx'])
  })

  it('n’emploie plus le vert de reussite comme bouton', () => {
    const fautifs = FICHIERS.filter((f) => f.code.includes('button--success')).map((f) => f.nom)
    expect(fautifs).toEqual([])
  })
})
