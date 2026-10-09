#!/usr/bin/env node
/**
 * Migration des donnees du SQLite local vers Cloudflare D1.
 *
 * Lit `prandia.db` et produit un fichier SQL applicable tel quel :
 *     npx wrangler d1 execute DB --local  --file=scripts/_dump/d1-seed.sql
 *     npx wrangler d1 execute DB --remote --file=scripts/_dump/d1-seed.sql
 *
 * La sortie va dans scripts/_dump/, qui est git-ignore : elle contient les
 * donnees personnelles (recettes, prix payes, contenu du frigo) et le depot
 * est public.
 *
 * ---------------------------------------------------------------------------
 * Les cinq transformations qui ne sont PAS une copie
 * ---------------------------------------------------------------------------
 *
 * 1. HORODATAGES — la base locale en melange deux sortes, et le format permet
 *    de les distinguer de facon fiable :
 *      - 'YYYY-MM-DD HH:MM:SS'         vient de CURRENT_TIMESTAMP -> deja UTC ;
 *      - 'YYYY-MM-DD HH:MM:SS.ffffff'  vient de datetime.now()    -> heure LOCALE.
 *    Les secondes seules sont donc reprises telles quelles, les microsecondes
 *    sont converties depuis le fuseau de cette machine vers UTC. Tout ressort
 *    en ISO-8601 UTC suffixe Z.
 *
 * 2. DATES-JOUR — `recorded_at` (prix) et `expiry_date` (frigo) sont des JOURS
 *    choisis par l'utilisateur, stockes a minuit heure locale. Les convertir en
 *    UTC les ferait reculer d'un jour (minuit a Paris = 22 h la veille en UTC).
 *    On garde donc les 10 premiers caracteres : la date que l'utilisateur a
 *    saisie, sans heure ni fuseau.
 *
 * 3. MONTANTS — stockes en REAL, et parfois en INTEGER (`price_eur` vaut
 *    litteralement `12` sur une ligne). Ils deviennent des chaines decimales
 *    a 4 decimales pour les prix, 2 pour les totaux.
 *
 * 4. name_normalized — calcule ici, la colonne n'existe pas en local.
 *    Doit rester identique a normalizeName() de shared/src/text.ts.
 *
 * 5. recipe.image_path -> image_key — le chemin local devient une cle R2.
 *    Le fichier lui-meme est televerse separement (voir le rapport en fin
 *    d'execution).
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DB = process.env['PRANDIA_DB_PATH'] ?? join(ROOT, 'prandia.db')
const OUT_DIR = join(ROOT, 'scripts', '_dump')
const OUT_FILE = join(OUT_DIR, 'd1-seed.sql')
const PHOTO_DIR = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.prandia', 'recipe_photos')

// --- helpers ---------------------------------------------------------------

/** Miroir de normalizeName() de shared/src/text.ts. */
const normalizeName = (s) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()

const stats = { localToUtc: 0, alreadyUtc: 0, dayDates: 0 }

/** Horodatage local ou UTC -> ISO-8601 UTC suffixe Z. Voir la note 1 en tete. */
function toUtcTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const s = String(value).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?/.exec(s)
  if (!m) throw new Error(`Horodatage non reconnu : ${JSON.stringify(value)}`)
  const [, y, mo, d, h, mi, sec, frac] = m
  if (!frac) {
    stats.alreadyUtc++
    return `${y}-${mo}-${d}T${h}:${mi}:${sec}Z`
  }
  // Microsecondes -> datetime.now() -> heure locale de cette machine.
  stats.localToUtc++
  const local = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec))
  return `${local.toISOString().slice(0, 19)}Z`
}

/** Date-jour telle que saisie, sans conversion de fuseau. Voir la note 2. */
function toDayDate(value) {
  if (value === null || value === undefined || value === '') return null
  stats.dayDates++
  return String(value).slice(0, 10)
}

/** REAL/INTEGER -> chaine decimale. Voir la note 3. */
function toMoney(value, decimals) {
  if (value === null || value === undefined) return null
  return Number(value).toFixed(decimals)
}

const sqlString = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const sqlNumber = (v) => (v === null || v === undefined ? 'NULL' : String(v))
const sqlBool = (v) => (v ? '1' : '0')

const chunks = []
const emit = (line) => chunks.push(line)
const section = (title) => emit(`\n-- ${'-'.repeat(72)}\n-- ${title}\n-- ${'-'.repeat(72)}`)

/**
 * Emet des INSERT multi-lignes par lots.
 *
 * Une instruction par ligne produisait 4 300 requetes, ce que wrangler ne
 * digere pas en un seul appel (« Body Timeout Error » en local, limites de
 * taille de requete en distant). Regroupees par 100, il en reste une
 * cinquantaine — et le chargement devient nettement plus rapide, chaque
 * instruction n'etant analysee qu'une fois.
 */
const CHUNK = 100
function emitInsert(table, columns, valueTuples) {
  for (let i = 0; i < valueTuples.length; i += CHUNK) {
    const slice = valueTuples.slice(i, i + CHUNK)
    emit(`INSERT INTO ${table} (${columns.join(', ')}) VALUES\n  ${slice.join(',\n  ')};`)
  }
}

// --- lecture ---------------------------------------------------------------

if (!existsSync(SOURCE_DB)) {
  console.error(`Base introuvable : ${SOURCE_DB}`)
  process.exit(1)
}

const db = new DatabaseSync(SOURCE_DB, { readOnly: true })
const all = (sql) => db.prepare(sql).all()
const counts = {}
const record = (table, rows) => {
  counts[table] = rows.length
  return rows
}

emit(`-- Genere par scripts/migrate-sqlite-to-d1.mjs depuis la base locale.
-- NE PAS COMMITTER : contient des donnees personnelles (depot public).
--
-- A appliquer APRES les migrations de schema :
--   npx wrangler d1 migrations apply DB --local
--   npx wrangler d1 execute DB --local --file=scripts/_dump/d1-seed.sql

PRAGMA defer_foreign_keys = ON;`)

// --- ingredient (avant tout le reste : presque tout y fait reference) -------
section('ingredient')
emitInsert(
  'ingredient',
  ['id', 'name', 'name_normalized', 'source', 'source_ref', 'brand',
   'kcal_per_100g', 'proteins_g', 'carbs_g', 'sugars_g', 'fats_g', 'saturated_fats_g', 'fiber_g', 'salt_g',
   'price_eur', 'price_quantity_g', 'piece_weight_g', 'cooked_weight_per_100g_raw',
   'in_personal_library', 'category_l1', 'category_l2', 'season_months', 'created_at', 'updated_at'],
  record('ingredient', all('SELECT * FROM ingredient ORDER BY id')).map(
    (r) =>
      '(' +
      [
        sqlNumber(r.id), sqlString(r.name), sqlString(normalizeName(r.name)),
        sqlString(r.source), sqlString(r.source_ref), sqlString(r.brand),
        sqlNumber(r.kcal_per_100g), sqlNumber(r.proteins_g), sqlNumber(r.carbs_g), sqlNumber(r.sugars_g),
        sqlNumber(r.fats_g), sqlNumber(r.saturated_fats_g), sqlNumber(r.fiber_g), sqlNumber(r.salt_g),
        sqlString(toMoney(r.price_eur, 4)), sqlNumber(r.price_quantity_g),
        sqlNumber(r.piece_weight_g), sqlNumber(r.cooked_weight_per_100g_raw),
        sqlBool(r.in_personal_library), sqlString(r.category_l1), sqlString(r.category_l2),
        sqlString(r.season_months), sqlString(toUtcTimestamp(r.created_at)), sqlString(toUtcTimestamp(r.updated_at)),
      ].join(', ') +
      ')',
  ),
)

// --- tag : deja seme par 0003, on realigne ids et couleurs -----------------
section('tag (realignement sur les ids locaux)')
emit('DELETE FROM tag;')
for (const r of record('tag', all('SELECT * FROM tag ORDER BY id'))) {
  emit(
    `INSERT INTO tag (id, name, color_hex, created_at) VALUES (` +
      [sqlNumber(r.id), sqlString(r.name), sqlString(r.color_hex), sqlString(toUtcTimestamp(r.created_at))].join(', ') +
      `);`,
  )
}

// --- recipe ----------------------------------------------------------------
section('recipe')
const photosToUpload = []
for (const r of record('recipe', all('SELECT * FROM recipe ORDER BY id'))) {
  const imageKey = r.image_path ? `recipes/${r.id}.jpg` : null
  if (r.image_path) photosToUpload.push({ recipeId: r.id, name: r.name, local: join(PHOTO_DIR, r.image_path), key: imageKey })
  emit(
    `INSERT INTO recipe (id, name, instructions, default_portions, image_key, source_url, prep_time_min, created_at, updated_at) VALUES (` +
      [
        sqlNumber(r.id), sqlString(r.name), sqlString(r.instructions ?? ''),
        sqlNumber(r.default_portions ?? 1), sqlString(imageKey), 'NULL', 'NULL',
        sqlString(toUtcTimestamp(r.created_at)), sqlString(toUtcTimestamp(r.updated_at)),
      ].join(', ') + `);`,
  )
}

section('recipe_ingredient')
for (const r of record('recipe_ingredient', all('SELECT * FROM recipe_ingredient ORDER BY recipe_id, ordinal'))) {
  emit(
    `INSERT INTO recipe_ingredient (recipe_id, ingredient_id, ordinal, quantity_g, notes, unit) VALUES (` +
      [sqlNumber(r.recipe_id), sqlNumber(r.ingredient_id), sqlNumber(r.ordinal ?? 0),
       sqlNumber(r.quantity_g), sqlString(r.notes), sqlString(r.unit)].join(', ') + `);`,
  )
}

section('recipe_tag')
for (const r of record('recipe_tag', all('SELECT * FROM recipe_tag ORDER BY recipe_id, tag_id'))) {
  emit(`INSERT INTO recipe_tag (recipe_id, tag_id) VALUES (${sqlNumber(r.recipe_id)}, ${sqlNumber(r.tag_id)});`)
}

// --- calendrier ------------------------------------------------------------
section('meal_plan_entry')
for (const r of record('meal_plan_entry', all('SELECT * FROM meal_plan_entry ORDER BY id'))) {
  // Le CHECK XOR de D1 est plus strict que celui du desktop : il refuse une
  // quantite sur une entree recette et des portions sur une entree ingredient.
  const isRecipe = r.recipe_id !== null
  emit(
    `INSERT INTO meal_plan_entry (id, iso_week, day_of_week, slot, recipe_id, ingredient_id, quantity_g, portions, ordinal) VALUES (` +
      [
        sqlNumber(r.id), sqlString(r.iso_week), sqlNumber(r.day_of_week), sqlString(r.slot),
        sqlNumber(r.recipe_id), sqlNumber(r.ingredient_id),
        isRecipe ? 'NULL' : sqlNumber(r.quantity_g),
        isRecipe ? sqlNumber(r.portions ?? 1) : 'NULL',
        sqlNumber(r.ordinal ?? 0),
      ].join(', ') + `);`,
  )
}

section('meal_plan_template')
for (const r of record('meal_plan_template', all('SELECT * FROM meal_plan_template ORDER BY id'))) {
  emit(
    `INSERT INTO meal_plan_template (id, name, snapshot_json, created_at, updated_at) VALUES (` +
      [sqlNumber(r.id), sqlString(r.name), sqlString(r.snapshot_json),
       sqlString(toUtcTimestamp(r.created_at)), sqlString(toUtcTimestamp(r.updated_at))].join(', ') + `);`,
  )
}

section('weekly_cost_snapshot')
for (const r of record('weekly_cost_snapshot', all('SELECT * FROM weekly_cost_snapshot ORDER BY iso_week'))) {
  emit(
    `INSERT INTO weekly_cost_snapshot (iso_week, total_eur, missing_count, captured_at) VALUES (` +
      [sqlString(r.iso_week), sqlString(toMoney(r.total_eur, 2) ?? '0.00'),
       sqlNumber(r.missing_count ?? 0), sqlString(toUtcTimestamp(r.captured_at))].join(', ') + `);`,
  )
}

// --- frigo, prix, cuisson --------------------------------------------------
section('pantry_stock')
for (const r of record('pantry_stock', all('SELECT * FROM pantry_stock ORDER BY id'))) {
  emit(
    `INSERT INTO pantry_stock (id, ingredient_id, quantity_g, expiry_date, notes, added_at, updated_at) VALUES (` +
      [sqlNumber(r.id), sqlNumber(r.ingredient_id), sqlNumber(r.quantity_g),
       sqlString(toDayDate(r.expiry_date)), sqlString(r.notes),
       sqlString(toUtcTimestamp(r.added_at)), sqlString(toUtcTimestamp(r.updated_at))].join(', ') + `);`,
  )
}

section('ingredient_price_history')
for (const r of record('ingredient_price_history', all('SELECT * FROM ingredient_price_history ORDER BY id'))) {
  emit(
    `INSERT INTO ingredient_price_history (id, ingredient_id, price_eur, quantity_g, store, recorded_at, notes, created_at) VALUES (` +
      [sqlNumber(r.id), sqlNumber(r.ingredient_id), sqlString(toMoney(r.price_eur, 4)),
       sqlNumber(r.quantity_g), sqlString(r.store), sqlString(toDayDate(r.recorded_at)),
       sqlString(r.notes), sqlString(toUtcTimestamp(r.created_at))].join(', ') + `);`,
  )
}

section('recipe_cooking_log')
for (const r of record('recipe_cooking_log', all('SELECT * FROM recipe_cooking_log ORDER BY id'))) {
  emit(
    `INSERT INTO recipe_cooking_log (id, recipe_id, cooked_at, rating, notes, created_at) VALUES (` +
      [sqlNumber(r.id), sqlNumber(r.recipe_id), sqlString(toDayDate(r.cooked_at)),
       sqlNumber(r.rating), sqlString(r.notes), sqlString(toUtcTimestamp(r.created_at))].join(', ') + `);`,
  )
}

// --- tickets ---------------------------------------------------------------
section('imported_receipt')
for (const r of record('imported_receipt', all('SELECT * FROM imported_receipt ORDER BY ticket_id'))) {
  emit(
    `INSERT INTO imported_receipt (ticket_id, store, imported_at, receipt_date, total_eur, line_count) VALUES (` +
      [sqlString(r.ticket_id), sqlString(r.store), sqlString(toUtcTimestamp(r.imported_at)),
       sqlString(toDayDate(r.receipt_date)), sqlString(toMoney(r.total_eur, 2)),
       sqlNumber(r.line_count ?? 0)].join(', ') + `);`,
  )
}

section('receipt_alias')
for (const r of record('receipt_alias', all('SELECT * FROM receipt_alias ORDER BY id'))) {
  emit(
    `INSERT INTO receipt_alias (id, store, source_key, ingredient_id, hit_count, created_at, updated_at) VALUES (` +
      [sqlNumber(r.id), sqlString(r.store), sqlString(r.source_key), sqlNumber(r.ingredient_id),
       sqlNumber(r.hit_count ?? 0), sqlString(toUtcTimestamp(r.created_at)),
       sqlString(toUtcTimestamp(r.updated_at))].join(', ') + `);`,
  )
}

// --- rayons ----------------------------------------------------------------
section('category_definition (parents avant enfants)')
const categories = record('category_definition', all('SELECT * FROM category_definition ORDER BY (parent_id IS NOT NULL), id'))
for (const r of categories) {
  emit(
    `INSERT INTO category_definition (id, name, parent_id, ordinal, created_at) VALUES (` +
      [sqlNumber(r.id), sqlString(r.name), sqlNumber(r.parent_id), sqlNumber(r.ordinal ?? 0),
       sqlString(toUtcTimestamp(r.created_at))].join(', ') + `);`,
  )
}

// --- reglages --------------------------------------------------------------
section('app_setting (remplace lidl_plus_settings)')
const lidl = all('SELECT * FROM lidl_plus_settings ORDER BY id LIMIT 1')[0]
if (lidl) {
  counts['lidl_plus_settings'] = 1
  // Aucun secret ici : le refresh token vivait dans le Credential Manager
  // Windows et n'a de toute facon pas d'equivalent cote Worker.
  const value = JSON.stringify({
    enabled: Boolean(lidl.enabled),
    pollIntervalMinutes: lidl.poll_interval_minutes ?? 60,
    lastFetchedAt: toUtcTimestamp(lidl.last_fetched_at),
    lastError: lidl.last_error ?? null,
  })
  emit(`INSERT INTO app_setting (key, value_json) VALUES ('lidl_plus', ${sqlString(value)});`)
}

// --- index plein-texte -----------------------------------------------------
section('reconstruction de l index FTS5')
emit(`-- OBLIGATOIRE : la table a contenu externe n'est alimentee que par les
-- triggers. Sans ce rebuild apres un chargement de masse, toute recherche
-- renvoie 0 resultat — sans lever la moindre erreur.
INSERT INTO ingredient_fts (ingredient_fts) VALUES ('rebuild');`)

// --- ecriture --------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_FILE, chunks.join('\n') + '\n', 'utf8')

const total = Object.values(counts).reduce((a, b) => a + b, 0)
console.log('\n=== Lignes exportees ===')
for (const [table, n] of Object.entries(counts).sort()) {
  console.log(`  ${table.padEnd(28)} ${String(n).padStart(6)}`)
}
console.log(`  ${'TOTAL'.padEnd(28)} ${String(total).padStart(6)}`)

console.log('\n=== Horodatages ===')
console.log(`  deja en UTC (CURRENT_TIMESTAMP)        ${stats.alreadyUtc}`)
console.log(`  convertis depuis l heure locale        ${stats.localToUtc}`)
console.log(`  dates-jour conservees sans conversion  ${stats.dayDates}`)

if (photosToUpload.length > 0) {
  console.log('\n=== Photos a televerser sur R2 ===')
  for (const p of photosToUpload) {
    const ok = existsSync(p.local)
    console.log(`  ${ok ? 'present ' : 'ABSENT  '} ${p.key}  <- ${p.local}`)
    if (ok) console.log(`      npx wrangler r2 object put prandia-media/${p.key} --file="${p.local}"`)
  }
}

console.log(`\nEcrit : ${OUT_FILE}`)
