/**
 * Acces a D1 pour la console d'administration.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CE MODULE PARLE A WRANGLER ET NON A UNE API
 * ---------------------------------------------------------------------------
 * La console est un outil LOCAL. Elle n'a aucun secret a elle : elle emprunte
 * l'authentification que `wrangler` detient deja sur cette machine. C'est ce
 * qui permet au site deploye de ne gagner AUCUNE route privilegiee — voir la
 * note en tete de serveur.mjs.
 *
 * Consequence a connaitre : qui peut lancer cette console peut deja lancer
 * `wrangler d1 execute` a la main. Elle n'ouvre aucun pouvoir nouveau, elle
 * rend seulement lisible ce qui se faisait en SQL.
 */

import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BASE = 'prandia'

// Un nom de fichier temporaire par appel. `Date.now()` ne suffirait pas : deux
// ecritures dans la meme milliseconde se marcheraient dessus.
let compteur = 0

/**
 * Chemin de l'entree JavaScript de wrangler.
 *
 * On l'appelle avec le Node courant plutot que par `npx` : sur Windows npx est
 * un script .cmd que Node refuse de lancer sans shell, et le shell est
 * justement ce qu'on evite. `createRequire` remonte les dossiers comme le
 * ferait un `import`, ce qui trouve les dependances meme depuis un arbre de
 * travail git ou elles vivent dans le depot parent.
 */
const wranglerBin = fileURLToPath(
  new URL(
    './bin/wrangler.js',
    pathToFileURL(createRequire(import.meta.url).resolve('wrangler/package.json')),
  ),
)

/**
 * Cibles connues. Aucune autre n'est acceptee : pas de base arbitraire.
 *
 * `site` sert a fabriquer les liens d'invitation. Il DOIT correspondre a la
 * base visee : un lien vers la production adosse a un jeton ecrit en base de
 * developpement enverrait son destinataire sur une invitation introuvable.
 */
export const CIBLES = {
  production: {
    drapeaux: ['--remote'],
    nom: 'production',
    site: 'https://prandia.pages.dev',
  },
  local: {
    drapeaux: ['--local', '--persist-to', `${process.env['LOCALAPPDATA']}\\Prandia\\dev-state`],
    nom: 'base de développement',
    site: 'http://localhost:8788',
  },
}

/**
 * Extrait le tableau JSON de la sortie de wrangler.
 *
 * ON LE CHERCHE au lieu de supposer qu'il commence au premier crochet :
 * wrangler prefixe sa sortie de lignes d'avancement, dont certaines en
 * portent. Partir du premier donnerait un JSON invalide, donc une erreur, sur
 * une commande qui a pourtant reussi.
 */
function extraireJson(sortie) {
  const fin = sortie.lastIndexOf(']')
  if (fin === -1) return null
  for (
    let debut = sortie.indexOf('[');
    debut !== -1 && debut < fin;
    debut = sortie.indexOf('[', debut + 1)
  ) {
    try {
      return JSON.parse(sortie.slice(debut, fin + 1))
    } catch {
      /* pas le bon crochet */
    }
  }
  return null
}

/**
 * Execute une requete et rend ses lignes.
 *
 * `--command` ET NON `--file`, et ce n'est pas interchangeable : avec
 * `--file`, wrangler repond par un resume (« Total queries executed », « Rows
 * read ») au lieu des colonnes demandees. Un `SELECT` y devient introuvable,
 * et le defaut est silencieux — un COUNT lu ainsi vaut toujours zero. Mesure
 * faite le 16 aout 2026, sur exactement ce piege.
 */
export async function requete(sql, cible) {
  const config = CIBLES[cible]
  if (!config) throw new Error(`Cible inconnue : ${cible}`)

  const { code, sortie } = await new Promise((resoudre) => {
    const enfant = spawn(
      process.execPath,
      [wranglerBin, 'd1', 'execute', BASE, ...config.drapeaux, '--json', '--command', sql],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let sortie = ''
    enfant.stdout.on('data', (d) => (sortie += d))
    enfant.stderr.on('data', (d) => (sortie += d))
    enfant.on('close', (code) => resoudre({ code, sortie }))
    enfant.on('error', (err) => resoudre({ code: 1, sortie: String(err) }))
  })

  const parsed = extraireJson(sortie)

  if (code !== 0 || parsed === null) {
    // La sortie brute part dans l'erreur : sur un outil d'administration, un
    // message vague coute plus cher qu'un message technique.
    const err = new Error(sortie.trim() || `wrangler a rendu le code ${code}`)
    err.sortieBrute = sortie
    throw err
  }

  const premier = parsed[0] ?? {}
  return {
    lignes: premier.results ?? [],
    /*
     * `null` VEUT DIRE « ON NE SAIT PAS », ET SUREMENT PAS ZERO.
     *
     * La production renseigne `meta.changes` ; en local, miniflare ne rend
     * qu'une `duration`. Ecrit `?? 0`, un renommage parfaitement applique se
     * lisait « aucune ligne modifiée » et l'ecran annoncait une erreur pour
     * une operation reussie. Constate le 16 aout 2026.
     *
     * Tout appelant qui a besoin de savoir si l'ecriture a pris doit RELIRE la
     * donnee, jamais se fier a ce compteur.
     */
    modifications: typeof premier.meta?.changes === 'number' ? premier.meta.changes : null,
  }
}

/**
 * Execute plusieurs instructions d'ecriture, via un FICHIER.
 *
 * L'ecriture ne rend rien a lire, donc le defaut de `--file` — repondre par un
 * resume au lieu des colonnes — n'a ici aucune importance, et le fichier evite
 * de passer un SQL de plusieurs kilo-octets en argument de commande.
 *
 * ATTENTION : rien ici n'est transactionnel. `wrangler d1 execute` enchaine les
 * instructions et ne defait pas les precedentes si l'une echoue. Tout appelant
 * qui cree plusieurs lignes liees doit verifier le resultat et nettoyer
 * lui-meme — c'est ce qui a laisse un foyer sans habitant le 16 aout 2026.
 */
export async function executer(sql, cible) {
  const config = CIBLES[cible]
  if (!config) throw new Error(`Cible inconnue : ${cible}`)

  const fichier = join(tmpdir(), `prandia-admin-${process.pid}-${compteur++}.sql`)
  await writeFile(fichier, sql, 'utf8')

  try {
    const { code, sortie } = await new Promise((resoudre) => {
      const enfant = spawn(
        process.execPath,
        [wranglerBin, 'd1', 'execute', BASE, ...config.drapeaux, '--file', fichier],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let sortie = ''
      enfant.stdout.on('data', (d) => (sortie += d))
      enfant.stderr.on('data', (d) => (sortie += d))
      enfant.on('close', (code) => resoudre({ code, sortie }))
      enfant.on('error', (err) => resoudre({ code: 1, sortie: String(err) }))
    })
    if (code !== 0) throw new Error(sortie.trim() || `wrangler a rendu le code ${code}`)
    return sortie
  } finally {
    // Le fichier ne contient aucune empreinte de mot de passe utilisable, mais
    // il n'a aucune raison de trainer.
    await rm(fichier, { force: true })
  }
}

/**
 * Un entier, ou rien.
 *
 * `--command` ne prend pas de parametres lies : tout ce qui entre dans une
 * requete y entre par interpolation. La console n'accepte donc QUE des
 * entiers dans ses chemins, valides ici, et ne construit jamais de SQL a
 * partir d'un texte libre.
 */
export function entier(valeur) {
  const n = Number(valeur)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
