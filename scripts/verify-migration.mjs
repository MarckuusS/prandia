#!/usr/bin/env node
/**
 * Verifie la migration de bout en bout, AVANT de toucher a un vrai D1.
 *
 * Applique les migrations de schema puis le dump sur une base neuve, et
 * compare le resultat a la base source ligne par ligne. Une migration de
 * donnees qui « passe » sans erreur SQL peut tres bien avoir perdu des
 * lignes, decale des dates d'un jour ou vide l'index de recherche : ce sont
 * ces trois choses-la qu'on controle ici, pas la seule absence d'exception.
 *
 * Usage : node scripts/verify-migration.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DB = process.env['PRANDIA_DB_PATH'] ?? join(ROOT, 'prandia.db')
const SEED = join(ROOT, 'scripts', '_dump', 'd1-seed.sql')

if (!existsSync(SEED)) {
  console.error(`Dump absent : ${SEED}\nLance d'abord : node scripts/migrate-sqlite-to-d1.mjs`)
  process.exit(1)
}

let failures = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}`)
  if (!ok) console.log(`        attendu : ${JSON.stringify(expected)}\n        obtenu  : ${JSON.stringify(expected === undefined ? null : actual)}`)
}

const src = new DatabaseSync(SOURCE_DB, { readOnly: true })
const dst = new DatabaseSync(':memory:')

console.log('=== Application du schema puis du dump ===')
for (const f of ['0001_core.sql', '0002_fts.sql', '0003_seed_tags.sql']) {
  dst.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
}
dst.exec(readFileSync(SEED, 'utf8'))
console.log('  OK   applique sans erreur SQL')

// --- 1. Aucune ligne perdue ------------------------------------------------
console.log('\n=== Comptes, table par table ===')
const TABLES = [
  'ingredient', 'tag', 'recipe', 'recipe_ingredient', 'recipe_tag',
  'meal_plan_entry', 'meal_plan_template', 'weekly_cost_snapshot',
  'pantry_stock', 'ingredient_price_history', 'recipe_cooking_log',
  'imported_receipt', 'receipt_alias', 'category_definition',
]
for (const t of TABLES) {
  const a = src.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
  const b = dst.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
  check(`${t.padEnd(26)} ${String(b).padStart(5)}`, b, a)
}

// --- 2. L'index de recherche est reellement peuple -------------------------
console.log('\n=== Recherche plein-texte ===')
const ftsCount = dst.prepare('SELECT COUNT(*) c FROM ingredient_fts').get().c
check('index FTS peuple autant que la table', ftsCount, src.prepare('SELECT COUNT(*) c FROM ingredient').get().c)

const search = (q) =>
  dst.prepare('SELECT COUNT(*) c FROM ingredient_fts f JOIN ingredient i ON i.id = f.rowid WHERE ingredient_fts MATCH ?').get(q).c
check('« tomate » remonte des resultats', search('"tomat"*') > 0, true)
check('« creme » sans accent remonte des resultats', search('"creme"*') > 0, true)

// --- 3. Les montants sont des chaines decimales, pas des flottants ---------
console.log('\n=== Montants ===')
const priceTypes = dst.prepare("SELECT DISTINCT typeof(price_eur) t FROM ingredient WHERE price_eur IS NOT NULL").all().map((r) => r.t)
check('ingredient.price_eur stocke en TEXT', priceTypes, ['text'])

// La ligne a 12 EUR etait stockee en INTEGER cote SQLite local.
const twelve = dst.prepare("SELECT price_eur FROM ingredient WHERE CAST(price_eur AS REAL) = 12 LIMIT 1").get()
check('l entier 12 devient "12.0000"', twelve?.price_eur ?? null, '12.0000')

const srcSum = src.prepare('SELECT ROUND(SUM(price_eur), 4) s FROM ingredient WHERE price_eur IS NOT NULL').get().s
const dstSum = dst.prepare('SELECT ROUND(SUM(CAST(price_eur AS REAL)), 4) s FROM ingredient WHERE price_eur IS NOT NULL').get().s
check('somme des prix inchangee', dstSum, srcSum)

// --- 4. Horodatages normalises --------------------------------------------
console.log('\n=== Horodatages ===')
const badTs = dst.prepare(`
  SELECT COUNT(*) c FROM ingredient
  WHERE created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
     OR updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'`).get().c
check('tous les horodatages ingredient sont en ISO-8601 UTC', badTs, 0)

// Le piege : minuit heure locale converti en UTC recule d'un jour.
const srcDates = src.prepare('SELECT id, substr(recorded_at, 1, 10) d FROM ingredient_price_history ORDER BY id').all()
const dstDates = dst.prepare('SELECT id, recorded_at d FROM ingredient_price_history ORDER BY id').all()
check('les dates de prix ne bougent pas d un jour', dstDates, srcDates)

// --- 5. Le contenu, pas seulement les comptes ------------------------------
console.log('\n=== Contenu ===')
const srcLib = src.prepare('SELECT COUNT(*) c FROM ingredient WHERE in_personal_library = 1').get().c
const dstLib = dst.prepare('SELECT COUNT(*) c FROM ingredient WHERE in_personal_library = 1').get().c
check('bibliotheque personnelle preservee', dstLib, srcLib)

const srcBySource = src.prepare('SELECT source, COUNT(*) c FROM ingredient GROUP BY source ORDER BY source').all()
const dstBySource = dst.prepare('SELECT source, COUNT(*) c FROM ingredient GROUP BY source ORDER BY source').all()
check('repartition par source preservee', dstBySource, srcBySource)

const srcQty = src.prepare('SELECT ROUND(SUM(quantity_g), 4) s FROM recipe_ingredient').get().s
const dstQty = dst.prepare('SELECT ROUND(SUM(quantity_g), 4) s FROM recipe_ingredient').get().s
check('masse totale des lignes de recette preservee', dstQty, srcQty)

const srcNames = src.prepare('SELECT id, name FROM recipe ORDER BY id').all()
const dstNames = dst.prepare('SELECT id, name FROM recipe ORDER BY id').all()
check('noms et ids de recettes identiques', dstNames, srcNames)

// name_normalized doit etre calcule partout, sinon la recherche par nom
// et la detection de collision tombent en silence.
const emptyNorm = dst.prepare("SELECT COUNT(*) c FROM ingredient WHERE name_normalized = '' OR name_normalized IS NULL").get().c
check('name_normalized renseigne partout', emptyNorm, 0)

// --- 6. Integrite referentielle -------------------------------------------
console.log('\n=== Integrite ===')
dst.exec('PRAGMA foreign_keys = ON')
check('aucune violation de cle etrangere', dst.prepare('PRAGMA foreign_key_check').all(), [])
check('aucune anomalie d integrite', dst.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')

const photoRecipes = dst.prepare("SELECT id, image_key FROM recipe WHERE image_key IS NOT NULL").all()
check('la seule photo pointe vers une cle R2', photoRecipes, [{ id: 6, image_key: 'recipes/6.jpg' }])

console.log(`\n${failures === 0 ? 'MIGRATION FIDELE' : `${failures} ECHEC(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
