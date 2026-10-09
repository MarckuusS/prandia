#!/usr/bin/env node
/**
 * Cree un compte, ou change le mot de passe d'un compte existant.
 *
 *     node scripts/add-user.mjs marius "Marius"
 *
 * Le mot de passe est demande de facon interactive et ne quitte JAMAIS cette
 * machine : le script calcule l'empreinte en local et n'affiche que le SQL a
 * executer. Rien ne transite par le reseau, rien n'apparait dans un historique
 * de commandes.
 *
 * Le hachage est volontairement identique a celui du Worker (PBKDF2-SHA256,
 * 100 000 iterations, sel de 16 octets). Node et les Workers exposent tous
 * deux WebCrypto : le meme calcul donne le meme resultat des deux cotes, sinon
 * un compte cree ici ne pourrait pas se connecter en production.
 */

import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stdin, stdout } from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sqlCreationCuisine, sqlString } from './lib/cuisine-sql.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Plafond impose par Cloudflare Workers : au-dela de 100 000, PBKDF2 leve
// « iteration counts above 100000 are not supported ». La limite n'est PAS
// appliquee par le runtime local, d'ou un compte qui marche en developpement
// et casse en production. Voir shared/src/password.ts.
const ITERATIONS = 100_000
const MIN_LENGTH = 10

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  )
  return { hash: toHex(bits), salt: toHex(salt), iterations: ITERATIONS }
}

// ---------------------------------------------------------------------------
// Saisie masquee
// ---------------------------------------------------------------------------
//
// Lecture directe des touches, sans `readline`. Deux raisons, toutes deux
// constatees a l'usage :
//
//   - readline ne masque pas de facon fiable — cela repose sur
//     `_writeToOutput`, une API privee dont le comportement varie ;
//   - enchainer deux questions laissait l'entree standard dans un etat ou
//     plus rien n'arrivait, et la seconde promesse ne se resolvait jamais.
//
// Ici le tampon est gere explicitement : rien n'est jamais reecrit a l'ecran.

const KEY_ENTER = '\r'
const KEY_NEWLINE = '\n'
const KEY_CTRL_C = ''
const KEY_CTRL_D = ''
const KEY_BACKSPACE = ''
const KEY_BACKSPACE_ALT = '\b'
const KEY_ESCAPE = ''

/** Toutes les lignes d'un coup quand l'entree n'est pas un terminal. */
async function readAllPipedLines() {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
}

const pipedLines = stdin.isTTY ? null : await readAllPipedLines()
let pipedIndex = 0

function askHidden(question) {
  stdout.write(question)

  // Hors terminal (pipe, redirection, CI) : aucun ecran a proteger, et
  // setRawMode n'existe pas sur un flux qui n'est pas un TTY.
  if (!stdin.isTTY) {
    const line = pipedLines?.[pipedIndex++] ?? ''
    stdout.write('\n')
    return Promise.resolve(line)
  }

  return new Promise((resolve) => {
    let buffer = ''

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const finish = (value) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onKey)
      stdout.write('\n')
      resolve(value)
    }

    const onKey = (key) => {
      if (key === KEY_ENTER || key === KEY_NEWLINE || key === KEY_CTRL_D) {
        finish(buffer)
        return
      }
      if (key === KEY_CTRL_C) {
        // Remettre le terminal dans un etat utilisable avant de sortir :
        // sans cela, le shell reste en mode brut et n'affiche plus rien.
        stdin.setRawMode(false)
        stdout.write('\n')
        process.exit(130)
      }
      if (key === KEY_BACKSPACE || key === KEY_BACKSPACE_ALT) {
        buffer = buffer.slice(0, -1)
        return
      }
      // Ignore les sequences d'echappement (fleches, touches de fonction) :
      // elles commencent par ESC et n'ont rien a faire dans un mot de passe.
      if (key >= ' ' && !key.startsWith(KEY_ESCAPE)) buffer += key
    }

    stdin.on('data', onKey)
  })
}

// ---------------------------------------------------------------------------

const quit = (message) => {
  console.error(message)
  process.exit(1)
}

/**
 * Execute la commande wrangler directement.
 *
 * Le SQL n'est PAS colle dans un terminal : il est passe en argument via
 * `spawn`, sans passer par un shell. C'est ce qui evite le probleme de
 * guillemets — la requete contient des apostrophes, la commande des
 * guillemets doubles, et selon le terminal le collage casse l'un ou l'autre.
 *
 * Le mot de passe ne part toujours pas sur le reseau : wrangler ne transmet
 * que l'empreinte, deja calculee ici.
 */
async function runWrangler(sql, target, persistTo, { json = false, viaCommand = false } = {}) {
  /*
   * LE FICHIER POUR ECRIRE, `--command` POUR LIRE, et ce n'est pas un gout.
   *
   * Le SQL d'ecriture passe par un FICHIER : un argument contenant
   * apostrophes, espaces et parentheses se fait reinterpreter par le shell,
   * ce qui cassait le copier-coller manuel, et `shell: true` reproduisait le
   * probleme.
   *
   * Mais `--file` ne rend PAS les lignes lues : wrangler repond alors par un
   * resume (« Total queries executed », « Rows read »), et un `SELECT
   * COUNT(*)` y devient introuvable. Lu ainsi, un compte existant passait pour
   * absent — le controle prealable rendait toujours « non ». Il faut
   * `--command`, dont la sortie porte vraiment les colonnes demandees.
   *
   * L'interpolation reste sure : les seules lectures faites ici portent sur un
   * identifiant deja valide contre /^[a-z0-9_-]{2,32}$/, et `spawn` ne passe
   * par aucun shell.
   */
  const file = viaCommand ? null : join(tmpdir(), `prandia-user-${Date.now()}.sql`)
  if (file !== null) await writeFile(file, sql, 'utf8')

  // On appelle l'entree JavaScript de wrangler avec le Node courant, plutot
  // que `npx`. Sur Windows npx est un script .cmd, que Node refuse de lancer
  // sans shell — et le shell est justement ce qu'on veut eviter.
  //
  // ON LA RESOUT AU LIEU DE LA DEVINER. Le chemin etait ecrit en dur sous la
  // racine du depot ; dans un arbre de travail git, les dependances vivent
  // souvent dans le depot PARENT, et la commande echouait alors sur un
  // « Cannot find module » que rien n'expliquait. `createRequire` remonte les
  // dossiers exactement comme le ferait un `import`.
  const wrangler = fileURLToPath(
    new URL(
      './bin/wrangler.js',
      pathToFileURL(createRequire(import.meta.url).resolve('wrangler/package.json')),
    ),
  )

  try {
    return await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          wrangler,
          'd1',
          'execute',
          'prandia',
          target,
          // LE MEME EMPLACEMENT QUE LE SERVEUR, sinon on ecrit dans une base
          // que personne ne lit. Le defaut s'est produit : `mobile.bat` place
          // son etat hors du projet, dont le chemin contient une espace et un
          // signe plus que miniflare ne sait pas ouvrir, et un compte cree
          // sans cette option n'apparaissait nulle part.
          ...(persistTo ? ['--persist-to', persistTo] : []),
          ...(json ? ['--json'] : []),
          ...(viaCommand ? ['--command', sql] : ['--file', file]),
        ],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let output = ''
      child.stdout.on('data', (d) => (output += d))
      child.stderr.on('data', (d) => (output += d))
      child.on('close', (code) => resolve({ code, output }))
      child.on('error', (err) => resolve({ code: 1, output: String(err) }))
    })
  } finally {
    // Le fichier ne contient que l'empreinte, jamais le mot de passe — mais
    // il n'a aucune raison de trainer.
    if (file !== null) await rm(file, { force: true })
  }
}

/**
 * Le compte existe-t-il deja ? `null` si on n'a pas pu le savoir.
 *
 * ON LE DEMANDE A LA BASE AVANT D'ECRIRE, parce que la suite n'est pas
 * transactionnelle : `wrangler d1 execute` enchaine les instructions et rien
 * ne defait les precedentes si la derniere echoue.
 *
 * LE DEFAUT QUE CE CONTROLE REPARE, constate en production le 16 aout 2026.
 * Le script posait un `ON CONFLICT(username) DO UPDATE` qui excluait
 * volontairement `household_id` — ce qu'il faut pour un changement de mot de
 * passe. Mais relance avec `--cuisine` sur un identifiant deja pris, la
 * sequence creait la cuisine, y copiait les 3 484 lignes du catalogue, puis
 * tombait dans le ON CONFLICT et laissait le compte dans sa cuisine d'origine.
 * Le script affichait « Nouvelle cuisine, donnees entierement separees » sans
 * avoir rien deplace, et abandonnait derriere lui un foyer sans habitant.
 *
 * C'est la pire forme d'echec : celle qui annonce le succes de l'operation
 * qu'on venait justement corriger.
 */
async function accountExists(username, target, persistTo) {
  const { code, output } = await runWrangler(
    `SELECT COUNT(*) AS n FROM user WHERE username = ${sqlString(username)}`,
    target,
    persistTo,
    { json: true, viaCommand: true },
  )
  if (code !== 0) return null

  /*
   * On CHERCHE le tableau JSON au lieu de supposer qu'il commence au premier
   * crochet. Wrangler prefixe sa sortie de lignes d'avancement, dont
   * certaines portent des crochets : partir du premier donnerait un JSON
   * invalide, donc un `null`, donc la perte silencieuse du controle.
   */
  const fin = output.lastIndexOf(']')
  if (fin === -1) return null

  for (let debut = output.indexOf('['); debut !== -1 && debut < fin; debut = output.indexOf('[', debut + 1)) {
    try {
      const parsed = JSON.parse(output.slice(debut, fin + 1))
      const n = parsed?.[0]?.results?.[0]?.n
      // Une reponse sans colonne `n` n'est pas un « zero » : c'est une sortie
      // qu'on n'a pas comprise. La confondre avec « le compte n'existe pas »
      // est exactement le defaut que ce bloc repare.
      if (n === undefined) return null
      return Number(n) > 0
    } catch {
      /* pas le bon crochet : on essaie le suivant */
    }
  }
  return null
}

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')))
const options = new Map(
  args
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => {
      const at = a.indexOf('=')
      return [a.slice(2, at), a.slice(at + 1)]
    }),
)
const [usernameRaw, displayNameRaw] = args.filter((a) => !a.startsWith('--'))

if (!usernameRaw) {
  quit(`Usage : node scripts/add-user.mjs <identifiant> "Nom affiché" --cuisine="Nom"

  identifiant        ce qu'on tape pour se connecter (minuscules, sans espace)
  Nom affiché        ce qui apparaît dans le journal d'activité

  --cuisine="Nom"    OBLIGATOIRE. Crée la cuisine de ce compte. Chaque compte
                     a la sienne : recettes, frigo, prix et planning lui
                     appartiennent et ne sont visibles de personne d'autre.
                     Il n'existe AUCUNE option pour placer un compte dans la
                     cuisine de quelqu'un d'autre — voir la note en tête de ce
                     fichier.

  --changer-mot-de-passe
                     Change le mot de passe d'un compte EXISTANT. Ne touche ni
                     à sa cuisine ni à ses données. Incompatible avec
                     --cuisine.

  --local            applique sur la base de développement
  --persist-to=CHEMIN  où vit cette base de développement. À passer dès que le
                     serveur local en utilise une autre que celle par défaut,
                     ce qui est le cas de mobile.bat : sans cette option, le
                     compte est créé dans une base que personne ne lit, et
                     l'écran de connexion répond "aucun compte configuré"
                     alors qu'on vient d'en créer un.
  --print            affiche seulement le SQL, sans rien appliquer

Exemples :
  node scripts/add-user.mjs paul "Paul" --cuisine="Chez Paul"
      → nouveau compte, cuisine à lui, données entièrement séparées

  node scripts/add-user.mjs paul --changer-mot-de-passe
      → nouveau mot de passe, rien d'autre ne bouge`)
}

const newKitchen = options.get('cuisine')?.trim() ?? null
if (newKitchen !== null && newKitchen === '') {
  quit('--cuisine attend un nom : --cuisine="Chez Paul"')
}

/*
 * UNE CUISINE PAR COMPTE, ET AUCUN MOYEN DE L'ENFREINDRE.
 *
 * Ce script a d'abord place tout compte sans `--cuisine` dans la cuisine n° 1.
 * L'intention etait le cas du conjoint, ou partager est le but. Le defaut
 * etait le mauvais : l'option dangereuse etait celle qu'on obtenait sans rien
 * taper, et le partage etait silencieux.
 *
 * CE QUE CELA A COUTE, le 16 aout 2026 : un compte cree en une commande a
 * ouvert a un tiers les recettes, le frigo, les prix et le planning de repas
 * du foyer 1. Rien de tout cela n'avait ete consenti.
 *
 * Partager une cuisine redeviendra possible, mais par une INVITATION que le
 * proprietaire emet et que l'invite accepte. Tant que ce chemin n'existe pas,
 * il n'y en a aucun : ni option, ni defaut, ni raccourci.
 */
const changePassword = flags.has('--changer-mot-de-passe')

if (changePassword && newKitchen !== null) {
  quit(
    '--changer-mot-de-passe et --cuisine ne vont pas ensemble.\n\n' +
      "Changer un mot de passe ne deplace personne, et ne cree aucune cuisine.",
  )
}

if (!changePassword && newKitchen === null) {
  quit(
    `Il manque --cuisine="Nom".\n\n` +
      `Chaque compte a sa propre cuisine : ses recettes, son frigo, ses prix et\n` +
      `son planning n'appartiennent qu'a lui. Il n'existe pas d'option pour\n` +
      `placer un compte dans la cuisine de quelqu'un d'autre.\n\n` +
      `    node scripts/add-user.mjs ${usernameRaw} "${displayNameRaw ?? usernameRaw}" --cuisine="Chez ${displayNameRaw ?? usernameRaw}"\n\n` +
      `Pour changer le mot de passe d'un compte existant :\n` +
      `    node scripts/add-user.mjs ${usernameRaw} --changer-mot-de-passe`,
  )
}

const username = usernameRaw.trim().toLowerCase()
if (!/^[a-z0-9_-]{2,32}$/.test(username)) {
  quit("L'identifiant doit faire 2 à 32 caractères : lettres, chiffres, tiret, souligné.")
}
const displayName = (displayNameRaw ?? usernameRaw).trim()

const target = flags.has('--local') ? '--local' : '--remote'
const where = target === '--local' ? 'la base de développement' : 'la production'
const persistTo = options.get('persist-to') ?? null

/*
 * On interroge la base AVANT de demander le mot de passe.
 *
 * Echouer apres deux saisies masquees pour un identifiant deja pris serait
 * une perte de temps gratuite, et surtout : la creation de cuisine part sur
 * la meme lancee. Mieux vaut refuser ici que laisser un foyer orphelin.
 */
if (!flags.has('--print')) {
  const existe = await accountExists(username, target, persistTo)

  if (existe === true && !changePassword) {
    quit(
      `L'identifiant « ${username} » est deja pris sur ${where}.\n\n` +
        `Creer un compte ne peut pas ecraser un compte existant, et ne peut pas\n` +
        `le deplacer de cuisine.\n\n` +
        `Pour changer son mot de passe :\n` +
        `    node scripts/add-user.mjs ${username} --changer-mot-de-passe` +
        (target === '--local' ? ' --local' : ''),
    )
  }

  if (existe === false && changePassword) {
    quit(
      `Aucun compte « ${username} » sur ${where}.\n\n` +
        `Pour le creer, avec sa propre cuisine :\n` +
        `    node scripts/add-user.mjs ${username} "${displayName}" --cuisine="Chez ${displayName}"` +
        (target === '--local' ? ' --local' : ''),
    )
  }

  if (existe === null) {
    stdout.write(
      `\n[!] Impossible de verifier si « ${username} » existe deja sur ${where}.\n` +
        `    La commande continue, mais relis le resultat : en cas de doublon,\n` +
        `    rien ne sera cree.\n`,
    )
  }
}

if (stdin.isTTY) {
  stdout.write("\nLa saisie est masquée : rien ne s'affiche pendant que tu tapes, c'est normal.\n\n")
}

const password = await askHidden(`Mot de passe pour « ${username} » : `)

if (password.length < MIN_LENGTH) {
  // C'est le seul facteur d'authentification, sur une application joignable
  // publiquement : un mot de passe court n'a pas de sens ici.
  quit(`Trop court : ${password.length} caractère(s), il en faut au moins ${MIN_LENGTH}.`)
}

const confirmation = await askHidden('Confirme : ')
if (password !== confirmation) {
  quit('Les deux saisies diffèrent.')
}

const { hash, salt, iterations } = await hashPassword(password)

// Le SQL de creation vit dans scripts/lib/cuisine-sql.mjs : la console
// d'administration cree des cuisines elle aussi, et deux copies de cette
// requete finiraient par diverger.
const kitchenSql = newKitchen === null ? '' : sqlCreationCuisine(newKitchen)

/*
 * DEUX INTENTIONS, DEUX INSTRUCTIONS, ET PLUS DE ON CONFLICT.
 *
 * L'ancienne version faisait les deux d'un coup : un INSERT qui, en cas de
 * doublon, se muait en UPDATE. Pratique, et c'est ce qui a coute cher — la
 * bascule etait invisible, et la creation d'une cuisine qui la precedait ne
 * l'etait pas moins. Un `INSERT` nu echoue franchement sur l'unicite de
 * `username` ; un `UPDATE` nu ne cree rien s'il ne trouve personne.
 *
 * Aucune des deux ne touche a `household_id` : la creation le fixe une fois,
 * le changement de mot de passe n'y touche pas. Deplacer quelqu'un de cuisine
 * n'est le travail d'aucune des deux, et ne le sera que le jour ou une
 * invitation acceptee existera.
 */
const sql = changePassword
  ? `UPDATE user SET password_hash = ${sqlString(hash)}, password_salt = ${sqlString(salt)}, ` +
    `iterations = ${iterations}, is_active = 1 WHERE username = ${sqlString(username)};`
  : kitchenSql +
    `INSERT INTO user (username, display_name, household_id, password_hash, password_salt, iterations) ` +
    `VALUES (${sqlString(username)}, ${sqlString(displayName)}, (SELECT MAX(id) FROM household), ` +
    `${sqlString(hash)}, ${sqlString(salt)}, ${iterations});`

if (flags.has('--print')) {
  stdout.write(`\n${sql}\n`)
  process.exit(0)
}

stdout.write(`\nApplication sur ${where}…\n`)
const { code, output } = await runWrangler(sql, target, persistTo)

if (code !== 0) {
  const migrate = `npm run db:migrate:${target === '--local' ? 'local' : 'remote'}`

  // La cause la plus frequente, et la plus opaque quand elle remonte brute :
  // le schema multi-cuisines n'a jamais ete applique a CETTE base. SQLite dit
  // « no such table: household » et laisse deviner tout le reste.
  if (/no such table: household/i.test(output)) {
    quit(
      `Cette base ne connaît pas encore les cuisines séparées.\n\n` +
        `Applique d'abord la migration :\n    ${migrate}\n\n` +
        `Puis relance cette commande.`,
    )
  }

  if (/no such column: household_id/i.test(output)) {
    quit(
      `Cette base est à moitié migrée : la table « household » existe, pas la colonne.\n` +
        `Relance « ${migrate} ».`,
    )
  }

  // Le controle prealable a laisse passer un doublon : deux lancements en
  // parallele, ou une base modifiee entretemps. L'INSERT nu a fait son
  // travail — il a refuse — mais la cuisine, elle, vient d'etre creee.
  if (/UNIQUE constraint failed: user\.username/i.test(output)) {
    quit(
      `L'identifiant « ${username} » existe déjà : rien n'a été créé pour ce compte.\n\n` +
        (newKitchen === null
          ? ''
          : `En revanche la cuisine « ${newKitchen} » vient d'être créée et n'a aucun\n` +
            `habitant. Supprime-la :\n` +
            `    DELETE FROM ingredient WHERE household_id = (SELECT MAX(id) FROM household);\n` +
            `    DELETE FROM household WHERE id = (SELECT MAX(id) FROM household);\n\n`) +
        `Pour changer le mot de passe du compte existant :\n` +
        `    node scripts/add-user.mjs ${username} --changer-mot-de-passe` +
        (target === '--local' ? ' --local' : ''),
    )
  }

  stdout.write(`\n${output}\n`)
  quit(
    `Échec. Si c'est un problème d'authentification, lance « npx wrangler login ».\n` +
      `Tu peux aussi récupérer le SQL avec --print et l'appliquer toi-même.`,
  )
}

if (changePassword) {
  stdout.write(`
Mot de passe de « ${username} » changé sur ${where}.
Sa cuisine et ses données n'ont pas bougé.

Le mot de passe n'est stocké nulle part : seule son empreinte l'est.
`)
} else {
  stdout.write(`
Compte « ${username} » (${displayName}) créé sur ${where}.
Cuisine « ${newKitchen} », avec sa copie du catalogue CIQUAL.

Il ne voit les données d'aucun autre compte, et aucun autre compte ne voit les
siennes. C'est la seule configuration que ce script sait produire.

Le mot de passe n'est stocké nulle part : seule son empreinte l'est.

Tu peux maintenant te connecter avec l'identifiant « ${username} ».
`)
}
