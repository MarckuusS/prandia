/**
 * La sauvegarde de la base, sans D1 : le fichier produit, l'ordre de ce qu'il
 * rejoue, ce qu'il laisse dehors, et le menage des anciennes copies.
 *
 * La preuve qu'il se RESTAURE est ailleurs : rejoue sur une base locale vide,
 * puis compte par compte (voir JOURNAL.md, 2026-10-11). Une sauvegarde jamais
 * restauree n'est pas une sauvegarde.
 */

import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  CLE_BILAN,
  CLE_ESSAI,
  ESSAI_MS,
  cleDuJour,
  ecrireSauvegarde,
  litteral,
  sauvegardesAEffacer,
  sauvegarder,
  tablesDansLOrdre,
  type LecteurBase,
  type ObjetSchema,
} from './sauvegarde.js'

const SCHEMA: ObjetSchema[] = [
  { type: 'table', name: 'recipe_ingredient', tbl_name: 'recipe_ingredient', sql: 'CREATE TABLE recipe_ingredient (recipe_id INTEGER REFERENCES recipe (id), ingredient_id INTEGER REFERENCES ingredient (id))' },
  { type: 'table', name: 'recipe', tbl_name: 'recipe', sql: 'CREATE TABLE recipe (id INTEGER PRIMARY KEY, household_id INTEGER REFERENCES household (id))' },
  { type: 'table', name: 'household', tbl_name: 'household', sql: 'CREATE TABLE household (id INTEGER PRIMARY KEY, name TEXT)' },
  { type: 'table', name: 'ingredient', tbl_name: 'ingredient', sql: 'CREATE TABLE ingredient (id INTEGER PRIMARY KEY, name TEXT)' },
  { type: 'table', name: 'category_definition', tbl_name: 'category_definition', sql: 'CREATE TABLE category_definition (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES category_definition (id))' },
  { type: 'table', name: 'app_setting', tbl_name: 'app_setting', sql: 'CREATE TABLE app_setting (household_id INTEGER, key TEXT, value_json TEXT, PRIMARY KEY (household_id, key))' },
  { type: 'table', name: 'weight_log', tbl_name: 'weight_log', sql: 'CREATE TABLE weight_log (user_id INTEGER, day TEXT, kg REAL, PRIMARY KEY (user_id, day)) WITHOUT ROWID' },
  { type: 'table', name: 'ingredient_fts', tbl_name: 'ingredient_fts', sql: "CREATE VIRTUAL TABLE ingredient_fts USING fts5(name, content='ingredient', content_rowid='id')" },
  { type: 'table', name: 'ingredient_fts_data', tbl_name: 'ingredient_fts_data', sql: 'CREATE TABLE ingredient_fts_data(id INTEGER PRIMARY KEY, block BLOB)' },
  { type: 'table', name: 'ingredient_fts_idx', tbl_name: 'ingredient_fts_idx', sql: 'CREATE TABLE ingredient_fts_idx(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID' },
  { type: 'table', name: 'sqlite_sequence', tbl_name: 'sqlite_sequence', sql: 'CREATE TABLE sqlite_sequence(name,seq)' },
  { type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID' },
  { type: 'index', name: 'ix_ingredient_name', tbl_name: 'ingredient', sql: 'CREATE INDEX ix_ingredient_name ON ingredient (name)' },
  { type: 'index', name: 'sqlite_autoindex_app_setting_1', tbl_name: 'app_setting', sql: null },
  { type: 'trigger', name: 'ingredient_ai', tbl_name: 'ingredient', sql: 'CREATE TRIGGER ingredient_ai AFTER INSERT ON ingredient BEGIN\n  INSERT INTO ingredient_fts (rowid, name) VALUES (new.id, new.name);\nEND' },
]

function lecteur(lignes: Record<string, Array<Record<string, unknown>>>): LecteurBase {
  return {
    schema: async () => SCHEMA,
    async *pages(table) {
      const toutes = lignes[table] ?? []
      for (let i = 0; i < toutes.length; i += 2) yield toutes.slice(i, i + 2)
    },
  }
}

const QUAND = new Date('2026-10-12T00:17:00Z')

describe('litteral', () => {
  it('rend chaque valeur de D1 en SQL rejouable', () => {
    expect(litteral(null)).toBe('NULL')
    expect(litteral(12.5)).toBe('12.5')
    expect(litteral("L'astuce du chef :\n2 c. a soupe")).toBe("'L''astuce du chef :\n2 c. a soupe'")
    expect(litteral([0, 15, 255])).toBe("X'000fff'")
    expect(() => litteral(Number.NaN)).toThrow()
  })
})

describe('tablesDansLOrdre', () => {
  it('met les parents avant les enfants et laisse dehors les tables internes', () => {
    const noms = tablesDansLOrdre(SCHEMA).map((t) => t.name)
    expect(noms).not.toContain('ingredient_fts_data')
    expect(noms).not.toContain('ingredient_fts_idx')
    expect(noms).not.toContain('sqlite_sequence')
    expect(noms).not.toContain('_cf_KV')
    expect(noms).toContain('ingredient_fts')
    expect(noms.indexOf('household')).toBeLessThan(noms.indexOf('recipe'))
    expect(noms.indexOf('recipe')).toBeLessThan(noms.indexOf('recipe_ingredient'))
    expect(noms.indexOf('ingredient')).toBeLessThan(noms.indexOf('recipe_ingredient'))
    // Une table qui se reference elle-meme ne boucle pas.
    expect(noms).toContain('category_definition')
  })
})

describe('ecrireSauvegarde', () => {
  const donnees = {
    household: [{ id: 1, name: 'Maison' }],
    ingredient: [
      { id: 1, name: 'Riz' },
      { id: 2, name: "Huile d'olive" },
      { id: 3, name: 'Sel' },
    ],
    recipe: [{ id: 7, household_id: 1 }],
    recipe_ingredient: [{ recipe_id: 7, ingredient_id: 1 }],
    app_setting: [
      { household_id: 0, key: 'auth.session_secret', value_json: '{"secret":"ne-doit-pas-sortir"}' },
      { household_id: 0, key: 'auth.failures', value_json: '{}' },
      { household_id: 1, key: 'auth.session_secret', value_json: '{"note":"un foyer reel peut avoir ce nom"}' },
    ],
    weight_log: [{ user_id: 1, day: '2026-10-11', kg: 72.4 }],
  }

  it('rejoue structure, lignes, puis index et declencheurs, puis reconstruit la recherche', async () => {
    const { sql, tables, lignes } = await ecrireSauvegarde(lecteur(donnees), QUAND)
    expect(tables).toBe(8)
    expect(lignes).toBe(9)
    const position = (motif: string) => {
      const i = sql.indexOf(motif)
      expect(i, motif).toBeGreaterThanOrEqual(0)
      return i
    }
    expect(position('PRAGMA defer_foreign_keys = true;')).toBeLessThan(position('CREATE TABLE household'))
    expect(position('CREATE TABLE household')).toBeLessThan(position('INSERT INTO "household"'))
    expect(position('INSERT INTO "recipe_ingredient"')).toBeLessThan(position('CREATE INDEX ix_ingredient_name'))
    expect(position('CREATE INDEX ix_ingredient_name')).toBeLessThan(position('CREATE TRIGGER ingredient_ai'))
    expect(position('CREATE TRIGGER ingredient_ai')).toBeLessThan(position(`INSERT INTO "ingredient_fts" ("ingredient_fts") VALUES ('rebuild');`))
    expect(sql).toContain(`("id", "name") VALUES\n(1, 'Riz'),\n(2, 'Huile d''olive'),\n(3, 'Sel');`)
    expect(sql).toContain(`INSERT INTO "weight_log" ("user_id", "day", "kg") VALUES\n(1, '2026-10-11', 72.4);`)
    // Ni copie des tables internes de la recherche, ni insertion dans la table virtuelle.
    expect(sql).not.toContain('ingredient_fts_data')
    expect(sql).not.toContain('INSERT INTO "ingredient_fts" ("name")')
    expect(sql).not.toContain('sqlite_autoindex')
  })

  it('laisse le secret de session dehors, et lui seul', async () => {
    const { sql } = await ecrireSauvegarde(lecteur(donnees), QUAND)
    expect(sql).not.toContain('ne-doit-pas-sortir')
    expect(sql).toContain("(0, 'auth.failures', '{}')")
    expect(sql).toContain('un foyer reel peut avoir ce nom')
  })

  it('coupe les INSERT avant la taille que D1 refuse', async () => {
    const longues = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: 'x'.repeat(4000) }))
    const { sql } = await ecrireSauvegarde(lecteur({ ingredient: longues }), QUAND)
    const instructions = sql.split(';\n').filter((s) => s.includes('INSERT INTO "ingredient"'))
    expect(instructions.length).toBeGreaterThan(1)
    for (const s of instructions) expect(s.length).toBeLessThan(100_000)
  })
})

describe('sauvegardesAEffacer', () => {
  const cles = (jours: string[]) => jours.map(cleDuJour)

  it('garde trente jours, puis la premiere de chaque mois pendant un an', () => {
    const jours: string[] = []
    for (let d = Date.parse('2025-08-01T00:00:00Z'); d <= Date.parse('2026-10-12T00:00:00Z'); d += 86_400_000) {
      jours.push(new Date(d).toISOString().slice(0, 10))
    }
    const effacees = new Set(sauvegardesAEffacer(cles(jours), '2026-10-12'))
    const gardees = jours.filter((j) => !effacees.has(cleDuJour(j)))
    // Les trente derniers jours, du 13 septembre au 12 octobre.
    expect(gardees.filter((j) => j >= '2026-09-13')).toHaveLength(30)
    // Plus anciens : seulement le 1er de chaque mois, d'octobre 2025 a septembre 2026.
    expect(gardees.filter((j) => j < '2026-09-13')).toEqual([
      '2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01',
      '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01',
    ])
  })

  it('ne touche jamais a une cle qui ne suit pas le format', () => {
    expect(sauvegardesAEffacer(['sauvegardes/notes.txt', 'recipes/3/abc.jpg'], '2027-01-01')).toEqual([])
  })
})

describe('sauvegarder', () => {
  function environnement(bilanDuJour: string | null, dernierEssai: string | null = null) {
    const depots: Array<{ cle: string; contenu: ArrayBuffer }> = []
    const effacees: string[][] = []
    const reglages: Array<unknown[]> = []
    const anciennes = ['sauvegardes/prandia-2026-01-15.sql.gz', 'sauvegardes/prandia-2026-01-01.sql.gz']
    const etat = [
      ...(bilanDuJour === null ? [] : [{ key: CLE_BILAN, value_json: JSON.stringify({ jour: bilanDuJour }) }]),
      ...(dernierEssai === null ? [] : [{ key: CLE_ESSAI, value_json: JSON.stringify({ a: dernierEssai }) }]),
    ]
    const DB = {
      prepare: (sql: string) => ({
        bind: (...valeurs: unknown[]) => ({
          run: async () => void reglages.push([sql, ...valeurs]),
          // Les deux reglages de la sauvegarde ; une page vide pour une table.
          all: async () => ({ results: sql.includes('app_setting') ? etat : [] }),
        }),
        all: async () => ({ results: sql.includes('sqlite_master') ? SCHEMA.filter((o) => o.name === 'household') : [] }),
      }),
    }
    const MEDIA = {
      put: async (cle: string, contenu: ArrayBuffer) => void depots.push({ cle, contenu }),
      list: async () => ({ objects: anciennes.map((key) => ({ key })), truncated: false }),
      delete: async (cles: string[]) => void effacees.push(cles),
    }
    return { env: { DB, MEDIA } as unknown as Parameters<typeof sauvegarder>[0], depots, effacees, reglages }
  }

  it('note l’essai, depose la copie du jour, ecrit le bilan APRES, puis fait le menage', async () => {
    const { env, depots, effacees, reglages } = environnement('2026-10-11')
    const bilan = await sauvegarder(env, QUAND)
    expect(bilan?.cle).toBe('sauvegardes/prandia-2026-10-12.sql.gz')
    expect(depots).toHaveLength(1)
    const texte = gunzipSync(Buffer.from(depots[0]!.contenu)).toString('utf8')
    expect(texte).toContain('CREATE TABLE household')
    expect(reglages.map((r) => r[2])).toEqual([CLE_ESSAI, CLE_BILAN])
    expect(effacees).toEqual([['sauvegardes/prandia-2026-01-15.sql.gz']])
  })

  it('ne refait rien quand la copie du jour existe', async () => {
    const { env, depots, reglages } = environnement('2026-10-12')
    expect(await sauvegarder(env, QUAND)).toBeNull()
    expect(depots).toHaveLength(0)
    expect(reglages).toHaveLength(0)
  })

  it('ne retente pas dans l’heure qui suit un essai, retente apres', async () => {
    // Une panne ne doit pas faire relire toute la base a chaque passage de l'horloge.
    const recent = environnement('2026-10-11', new Date(QUAND.getTime() - 20 * 60_000).toISOString())
    expect(await sauvegarder(recent.env, QUAND)).toBeNull()
    expect(recent.depots).toHaveLength(0)
    const ancien = environnement('2026-10-11', new Date(QUAND.getTime() - ESSAI_MS - 1000).toISOString())
    expect(await sauvegarder(ancien.env, QUAND)).not.toBeNull()
    expect(ancien.depots).toHaveLength(1)
  })
})
