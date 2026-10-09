#!/usr/bin/env node
/**
 * Valide que les migrations 0001 + 0002 s'appliquent proprement et que la
 * recherche plein-texte se comporte comme celle du desktop.
 *
 * C'est le tout premier controle du portage (spec section 6, risque #1) : si
 * FTS5 ou le tokenizer `unicode61 remove_diacritics 2` n'etaient pas
 * disponibles, il faudrait basculer sur `name_normalized` + LIKE AVANT
 * d'ecrire quoi que ce soit d'autre.
 *
 * Ce script s'execute contre le SQLite embarque dans Node, qui n'est pas le
 * meme binaire que celui de D1 : il valide la SYNTAXE et le COMPORTEMENT
 * attendus. La validation sur un vrai D1 se fait avec :
 *     npx wrangler d1 execute DB --local --file=migrations/0001_core.sql
 *
 * Usage : node scripts/check-fts5.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, 'migrations', f), 'utf8')

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}`)
  if (!ok) console.log(`        attendu : ${JSON.stringify(expected)}\n        obtenu  : ${JSON.stringify(actual)}`)
}

/**
 * Miroir volontaire de `normalizeName` de shared/src/text.ts, qui fait foi.
 * Duplique ici pour que ce script reste executable sans etape de build TS.
 * Les deux sont couverts par des tests : toute divergence se voit.
 */
const normalize = (s) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()

const db = new DatabaseSync(':memory:')
db.exec('PRAGMA foreign_keys = ON')

console.log('\n=== Application des migrations ===')
for (const f of ['0001_core.sql', '0002_fts.sql', '0003_seed_tags.sql']) {
  db.exec(read(f))
  console.log(`  OK   ${f}`)
}

// --- Structure -------------------------------------------------------------
console.log('\n=== Structure ===')
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'ingredient_fts_%' ORDER BY name")
  .all()
  .map((r) => r.name)
// 16 tables reelles + la table virtuelle ingredient_fts.
check('17 tables creees', tables.length, 17)

const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name)
check('3 triggers FTS', triggers, ['ingredient_ad', 'ingredient_ai', 'ingredient_au'])
check('10 tags semes', db.prepare('SELECT COUNT(*) c FROM tag').get().c, 10)

// --- Recherche plein-texte -------------------------------------------------
console.log('\n=== Recherche plein-texte ===')
const ins = db.prepare('INSERT INTO ingredient (name, name_normalized, source) VALUES (?, ?, ?)')
for (const n of ['Tomate', 'Tomate cerise', 'Crème fraîche épaisse', 'Épinard cuit', 'Œuf de poule', 'Pomme de terre', 'Pomme']) {
  ins.run(n, normalize(n), 'ciqual')
}

const search = (q) =>
  db
    .prepare('SELECT i.name FROM ingredient_fts f JOIN ingredient i ON i.id = f.rowid WHERE ingredient_fts MATCH ? ORDER BY rank')
    .all(q)
    .map((r) => r.name)

check('les triggers alimentent l index', db.prepare('SELECT COUNT(*) c FROM ingredient_fts').get().c, 7)
check('prefixe "tomat*"', search('"tomat"*').sort(), ['Tomate', 'Tomate cerise'])
// Le point qui justifie remove_diacritics 2 : sans lui, ces trois requetes
// ne renverraient rien. C'est ce que le desktop offre deja.
check('sans accent -> avec accent ("creme")', search('"creme"*'), ['Crème fraîche épaisse'])
check('sans accent -> avec accent ("epinard")', search('"epinard"*'), ['Épinard cuit'])
check('multi-tokens implicitement ET', search('"pomme"* "terre"*'), ['Pomme de terre'])

// LIMITE CONNUE de `remove_diacritics 2` : il retire les diacritiques mais ne
// DECOMPOSE pas les ligatures. « oeuf » ne trouve donc pas « Œuf ». Le desktop
// a exactement la meme limite — son traitement de Œ/œ (str.casefold) ne sert
// qu'a la detection de collision de nom, pas a la recherche.
// On le documente ici pour que personne ne "corrige" le tokenizer par erreur.
check('ligature OE : FTS5 seul ne matche PAS (limite documentee)', search('"oeuf"*'), [])

// La parade vit dans name_normalized, qui plie les ligatures en plus des
// accents. La recherche du Worker interroge les deux et fusionne.
console.log('\n=== Repli name_normalized (ligatures) ===')
const searchNormalized = (q) =>
  db
    .prepare('SELECT name FROM ingredient WHERE name_normalized LIKE ? ORDER BY name')
    .all(`%${normalize(q)}%`)
    .map((r) => r.name)
check('ligature OE via name_normalized ("oeuf")', searchNormalized('oeuf'), ['Œuf de poule'])
check('ligature OE via name_normalized ("Œuf")', searchNormalized('Œuf'), ['Œuf de poule'])
check('name_normalized reste accent-insensible', searchNormalized('creme'), ['Crème fraîche épaisse'])

// --- Maintenance de l index ------------------------------------------------
console.log('\n=== Maintenance de l index ===')
db.prepare('UPDATE ingredient SET name = ? WHERE name = ?').run('Tomate ancienne', 'Tomate')
check('UPDATE resynchronise', search('"ancienne"*'), ['Tomate ancienne'])
db.prepare("DELETE FROM ingredient WHERE name = 'Pomme'").run()
check('DELETE resynchronise', search('"pomme"*').sort(), ['Pomme de terre'])
db.exec("INSERT INTO ingredient_fts (ingredient_fts) VALUES ('rebuild')")
check('rebuild sans casse', search('"tomat"*').sort(), ['Tomate ancienne', 'Tomate cerise'])

// --- Contraintes que le desktop n avait pas --------------------------------
console.log('\n=== Contraintes ===')
const rejects = (label, fn) => {
  try {
    fn()
    failures++
    console.log(` FAIL  ${label} — accepte alors qu'il devrait etre refuse`)
  } catch {
    console.log(`  OK   ${label}`)
  }
}
rejects('XOR : recette ET ingredient', () =>
  db.exec("INSERT INTO meal_plan_entry (iso_week, day_of_week, slot, recipe_id, ingredient_id, portions) VALUES ('2026-W18', 0, 'noon', 1, 1, 1)"),
)
rejects('XOR : ni l un ni l autre', () =>
  db.exec("INSERT INTO meal_plan_entry (iso_week, day_of_week, slot) VALUES ('2026-W18', 0, 'noon')"),
)
rejects('iso_week mal formee', () =>
  db.exec("INSERT INTO meal_plan_entry (iso_week, day_of_week, slot, ingredient_id, quantity_g) VALUES ('2026-W 5', 0, 'noon', 2, 100)"),
)
rejects('slot inconnu', () =>
  db.exec("INSERT INTO meal_plan_entry (iso_week, day_of_week, slot, ingredient_id, quantity_g) VALUES ('2026-W18', 0, 'brunch', 2, 100)"),
)
rejects('macro negative', () => db.exec("INSERT INTO ingredient (name, proteins_g) VALUES ('X', -1)"))
rejects('unicite de rayon racine (COALESCE)', () => {
  db.exec("INSERT INTO category_definition (name) VALUES ('Frais')")
  db.exec("INSERT INTO category_definition (name) VALUES ('Frais')")
})

// 'snack_afternoon' fait 15 caracteres : il ne tenait pas dans le VARCHAR(10)
// declare cote Python (SQLite ne l'appliquait pas, D1 non plus, mais le
// schema mentait).
db.exec("INSERT INTO meal_plan_entry (iso_week, day_of_week, slot, ingredient_id, quantity_g) VALUES ('2026-W18', 0, 'snack_afternoon', 2, 100)")
check("slot 'snack_afternoon' accepte", db.prepare("SELECT COUNT(*) c FROM meal_plan_entry WHERE slot='snack_afternoon'").get().c, 1)

console.log(`\n${failures === 0 ? 'TOUT PASSE' : `${failures} ECHEC(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
