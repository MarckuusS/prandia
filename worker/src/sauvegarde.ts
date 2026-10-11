/**
 * La sauvegarde quotidienne de la base, vers R2.
 *
 * POURQUOI LA NOTRE : `wrangler d1 export` refuse la base, a cause de la table
 * virtuelle de recherche (`ingredient_fts`). D1 garde bien 30 jours de retour
 * en arriere ("Time Travel", plan payant), mais DANS la base elle-meme : une
 * base supprimee, un compte perdu ou une erreur remarquee trop tard l'emportent
 * avec elle. Ici, un fichier SQL autonome, range ailleurs.
 *
 * CE QUE CONTIENT LE FICHIER, dans l'ordre qui se rejoue sur une base VIDE
 * (`npx wrangler d1 execute <base> --remote --file <fichier>`) :
 *   1. les tables, parents avant enfants, et la table de recherche ;
 *   2. les lignes, en INSERT groupes sous la taille qu'accepte D1 ;
 *   3. les index, les declencheurs et les vues, APRES les lignes : un
 *      declencheur pose avant rejouerait ses effets sur chaque ligne chargee ;
 *   4. la reconstruction de l'index de recherche, qui se deduit de `ingredient`
 *      (contenu externe, migration 0002) : ses tables internes ne sont pas
 *      copiees.
 *
 * CE QUI N'Y EST PAS, volontairement : le secret de signature des sessions
 * (`app_setting`, foyer 0). Une copie qui fuirait ne doit pas permettre de
 * fabriquer une session ; restaure sans lui, le serveur en tire un nouveau et
 * chacun se reconnecte. Ni les tables internes de SQLite et de D1.
 *
 * UNE FOIS PAR JOUR (heure de Paris), essayee toutes les heures : le premier
 * passage du jour sauvegarde, les suivants ne lisent qu'une ligne. Une copie
 * qui echoue est retentee l'heure d'apres, sans rien faire d'autre.
 */

import type { D1Database, R2Bucket } from '@cloudflare/workers-types'
import { parisClock } from '@prandia/shared'

export const PREFIXE_SAUVEGARDES = 'sauvegardes/'
/** Le bilan de la derniere sauvegarde reussie, lu par l'onglet Profil. */
export const CLE_BILAN = 'sauvegarde.derniere'
/** Le reglage serveur qui ne doit jamais sortir de la base (voir auth.ts). */
const SECRET_DE_SESSION = 'auth.session_secret'
const FOYER_SERVEUR = 0

/** Les sauvegardes quotidiennes gardees ; au-dela, une par mois pendant un an. */
export const JOURS_GARDES = 30
export const MOIS_GARDES = 12

/** Une page de lecture : assez pour aller vite, assez peu pour rester leger. */
const PAGE = 1000
/** D1 refuse une instruction de plus de 100 Ko : on regroupe sous la moitie. */
const INSERT_MAX_OCTETS = 50_000

export interface ObjetSchema {
  readonly type: string
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
}

/** Ce que la sauvegarde lit : la structure, puis les lignes table par table. */
export interface LecteurBase {
  schema(): Promise<ObjetSchema[]>
  pages(table: string, sansRowid: boolean): AsyncIterable<Array<Record<string, unknown>>>
}

export interface Bilan {
  readonly jour: string
  readonly cle: string
  readonly octets: number
  readonly tables: number
  readonly lignes: number
  readonly faiteLe: string
}

// ------------------------------------------------------------------ SQL

const ident = (nom: string) => `"${nom.replace(/"/g, '""')}"`

/** Une valeur rendue par D1, en litteral SQL. */
export function litteral(valeur: unknown): string {
  if (valeur === null || valeur === undefined) return 'NULL'
  if (typeof valeur === 'number') {
    if (!Number.isFinite(valeur)) throw new Error(`nombre non representable : ${valeur}`)
    return String(valeur)
  }
  if (typeof valeur === 'bigint') return valeur.toString()
  if (typeof valeur === 'boolean') return valeur ? '1' : '0'
  if (typeof valeur === 'string') return `'${valeur.replace(/'/g, "''")}'`
  // D1 rend un BLOB en tableau d'octets.
  if (valeur instanceof ArrayBuffer || ArrayBuffer.isView(valeur) || Array.isArray(valeur)) {
    const octets = Array.isArray(valeur)
      ? valeur
      : [...new Uint8Array(valeur instanceof ArrayBuffer ? valeur : valeur.buffer)]
    return `X'${octets.map((o) => Number(o).toString(16).padStart(2, '0')).join('')}'`
  }
  throw new Error(`valeur non representable : ${typeof valeur}`)
}

/** Les tables a copier, parents avant enfants (d'apres leurs REFERENCES). */
export function tablesDansLOrdre(schema: readonly ObjetSchema[]): ObjetSchema[] {
  const virtuelles = schema.filter((o) => o.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql ?? ''))
  const internes = (nom: string) =>
    nom.startsWith('sqlite_') || nom.startsWith('_cf_') || virtuelles.some((v) => nom.startsWith(`${v.name}_`))
  const tables = schema.filter((o) => o.type === 'table' && o.sql !== null && !internes(o.name))

  const parNom = new Map(tables.map((t) => [t.name, t]))
  const parents = (t: ObjetSchema) =>
    [...(t.sql ?? '').matchAll(/REFERENCES\s+["`[]?(\w+)/gi)]
      .map((m) => m[1] ?? '')
      .filter((p) => p !== t.name && parNom.has(p))

  const rendu: ObjetSchema[] = []
  const vus = new Set<string>()
  const visiter = (t: ObjetSchema, chemin: Set<string>) => {
    if (vus.has(t.name) || chemin.has(t.name)) return
    chemin.add(t.name)
    for (const p of parents(t)) visiter(parNom.get(p) as ObjetSchema, chemin)
    chemin.delete(t.name)
    vus.add(t.name)
    rendu.push(t)
  }
  for (const t of [...tables].sort((a, b) => a.name.localeCompare(b.name))) visiter(t, new Set())
  return rendu
}

/** Une ligne qui ne doit pas sortir de la base. */
function exclue(table: string, ligne: Record<string, unknown>): boolean {
  return table === 'app_setting' && ligne['household_id'] === FOYER_SERVEUR && ligne['key'] === SECRET_DE_SESSION
}

/**
 * Le fichier de sauvegarde, entier. Les lignes de chaque table partent en
 * INSERT groupes, coupes avant `INSERT_MAX_OCTETS`.
 */
export async function ecrireSauvegarde(
  lecteur: LecteurBase,
  quand: Date,
): Promise<{ sql: string; tables: number; lignes: number }> {
  const schema = await lecteur.schema()
  const tables = tablesDansLOrdre(schema)
  const virtuelles = tables.filter((t) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql ?? ''))
  const ordinaires = tables.filter((t) => !virtuelles.includes(t))
  const horloge = parisClock(quand)

  const morceaux: string[] = [
    `-- Sauvegarde de la base Prandia, ${horloge.day} a ${String(Math.floor(horloge.minutes / 60)).padStart(2, '0')}:${String(horloge.minutes % 60).padStart(2, '0')} (heure de Paris).`,
    '-- A rejouer sur une base VIDE : npx wrangler d1 execute <base> --remote --file <ce fichier>',
    "-- Le secret de signature des sessions n'y est pas : restaure, le serveur en tire un nouveau.",
    'PRAGMA defer_foreign_keys = true;',
    '',
    ...tables.map((t) => `${(t.sql ?? '').trim()};`),
    '',
  ]

  let lignes = 0
  for (const table of ordinaires) {
    const sansRowid = /WITHOUT\s+ROWID/i.test(table.sql ?? '')
    let colonnes: string[] | null = null
    let lot: string[] = []
    let taille = 0
    const vider = () => {
      if (lot.length === 0 || colonnes === null) return
      morceaux.push(`INSERT INTO ${ident(table.name)} (${colonnes.map(ident).join(', ')}) VALUES\n${lot.join(',\n')};`)
      lot = []
      taille = 0
    }
    for await (const page of lecteur.pages(table.name, sansRowid)) {
      for (const ligne of page) {
        if (exclue(table.name, ligne)) continue
        colonnes ??= Object.keys(ligne)
        const valeurs = `(${colonnes.map((c) => litteral(ligne[c])).join(', ')})`
        if (taille + valeurs.length > INSERT_MAX_OCTETS) vider()
        lot.push(valeurs)
        taille += valeurs.length + 2
        lignes++
      }
    }
    vider()
  }

  morceaux.push('')
  for (const type of ['index', 'trigger', 'view']) {
    for (const o of schema) {
      if (o.type === type && o.sql !== null && tables.some((t) => t.name === o.tbl_name)) morceaux.push(`${o.sql.trim()};`)
    }
  }
  for (const v of virtuelles) morceaux.push(`INSERT INTO ${ident(v.name)} (${ident(v.name)}) VALUES ('rebuild');`)

  return { sql: `${morceaux.join('\n')}\n`, tables: tables.length, lignes }
}

// ------------------------------------------------------------------ D1

/**
 * La lecture par D1 : les lignes par PAGES, a la suite du dernier `rowid` lu
 * (un OFFSET relirait toutes les lignes sautees, a chaque page). Une table
 * sans rowid (hydratation, pesees : une ligne par jour et par personne) se lit
 * d'un coup.
 */
export function lecteurD1(db: D1Database): LecteurBase {
  return {
    async schema() {
      const { results } = await db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' ORDER BY rowid")
        .all<ObjetSchema>()
      return results
    },
    async *pages(table, sansRowid) {
      if (sansRowid) {
        yield (await db.prepare(`SELECT * FROM ${ident(table)}`).all<Record<string, unknown>>()).results
        return
      }
      let apres = Number.MIN_SAFE_INTEGER
      for (;;) {
        const { results } = await db
          .prepare(`SELECT rowid AS "__rowid", * FROM ${ident(table)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`)
          .bind(apres)
          .all<Record<string, unknown>>()
        if (results.length === 0) return
        apres = Number(results[results.length - 1]?.['__rowid'])
        yield results.map(({ __rowid: _, ...reste }) => reste)
        if (results.length < PAGE) return
      }
    },
  }
}

// ------------------------------------------------------------------ R2

/** `sauvegardes/prandia-2026-10-12.sql.gz` */
export const cleDuJour = (jour: string) => `${PREFIXE_SAUVEGARDES}prandia-${jour}.sql.gz`

/**
 * Les sauvegardes a effacer : on garde les `JOURS_GARDES` derniers jours, puis
 * la premiere de chaque mois sur `MOIS_GARDES` mois. Une cle qui ne suit pas
 * le format n'est jamais touchee.
 */
export function sauvegardesAEffacer(cles: readonly string[], aujourdhui: string): string[] {
  const motif = /^sauvegardes\/prandia-(\d{4}-\d{2}-\d{2})\.sql\.gz$/
  const datees = cles
    .map((cle) => ({ cle, jour: motif.exec(cle)?.[1] }))
    .filter((c): c is { cle: string; jour: string } => c.jour !== undefined)
    .sort((a, b) => a.jour.localeCompare(b.jour))

  const jourEnMs = (jour: string) => Date.parse(`${jour}T00:00:00Z`)
  const ageEnJours = (jour: string) => Math.round((jourEnMs(aujourdhui) - jourEnMs(jour)) / 86_400_000)
  const [annee, mois] = aujourdhui.split('-').map(Number) as [number, number]
  const moisDepuis = (jour: string) => {
    const [a, m] = jour.split('-').map(Number) as [number, number]
    return (annee - a) * 12 + (mois - m)
  }

  const premiereDuMois = new Set<string>()
  const moisVus = new Set<string>()
  for (const { cle, jour } of datees) {
    const m = jour.slice(0, 7)
    if (!moisVus.has(m)) {
      moisVus.add(m)
      premiereDuMois.add(cle)
    }
  }
  return datees
    .filter(({ cle, jour }) => ageEnJours(jour) >= JOURS_GARDES && !(premiereDuMois.has(cle) && moisDepuis(jour) <= MOIS_GARDES))
    .map(({ cle }) => cle)
}

async function gzip(texte: string): Promise<ArrayBuffer> {
  const flux = new Blob([texte]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(flux).arrayBuffer()
}

/**
 * Le passage horaire. Rend le bilan de la sauvegarde faite, ou `null` quand
 * celle du jour existe deja.
 */
export async function sauvegarder(env: { readonly DB: D1Database; readonly MEDIA: R2Bucket }, maintenant = new Date()): Promise<Bilan | null> {
  const jour = parisClock(maintenant).day
  const precedent = await env.DB.prepare('SELECT value_json FROM app_setting WHERE household_id = ? AND key = ?')
    .bind(FOYER_SERVEUR, CLE_BILAN)
    .first<{ value_json: string }>()
  if (precedent !== null && (JSON.parse(precedent.value_json) as Partial<Bilan>).jour === jour) return null

  const { sql, tables, lignes } = await ecrireSauvegarde(lecteurD1(env.DB), maintenant)
  const contenu = await gzip(sql)
  const cle = cleDuJour(jour)
  await env.MEDIA.put(cle, contenu, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: { tables: String(tables), lignes: String(lignes) },
  })

  // Le bilan n'est ecrit qu'APRES le depot : il dit ce qui existe vraiment.
  const bilan: Bilan = { jour, cle, octets: contenu.byteLength, tables, lignes, faiteLe: maintenant.toISOString() }
  await env.DB.prepare(
    `INSERT INTO app_setting (household_id, key, value_json, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(household_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  )
    .bind(FOYER_SERVEUR, CLE_BILAN, JSON.stringify(bilan))
    .run()

  // Le menage vient en dernier : une sauvegarde faite vaut mieux qu'un menage fait.
  const existantes: string[] = []
  let curseur: string | undefined
  do {
    const liste = await env.MEDIA.list({ prefix: PREFIXE_SAUVEGARDES, ...(curseur ? { cursor: curseur } : {}) })
    existantes.push(...liste.objects.map((o) => o.key))
    curseur = liste.truncated ? liste.cursor : undefined
  } while (curseur !== undefined)
  const aEffacer = sauvegardesAEffacer(existantes, jour)
  if (aEffacer.length > 0) await env.MEDIA.delete(aEffacer)

  return bilan
}

/** Le bilan de la derniere sauvegarde, pour l'onglet Profil ; `null` s'il n'y en a jamais eu. */
export async function derniereSauvegarde(db: D1Database): Promise<Bilan | null> {
  const ligne = await db
    .prepare('SELECT value_json FROM app_setting WHERE household_id = ? AND key = ?')
    .bind(FOYER_SERVEUR, CLE_BILAN)
    .first<{ value_json: string }>()
  if (ligne === null) return null
  try {
    return JSON.parse(ligne.value_json) as Bilan
  } catch {
    return null
  }
}
