#!/usr/bin/env node
/**
 * Console d'administration — serveur LOCAL.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CET OUTIL N'EST PAS UN ECRAN DE L'APPLICATION
 * ---------------------------------------------------------------------------
 * Administrer, c'est voir TOUS les foyers. Or tout le serveur deploye est bati
 * sur `Repositories(db, householdId)` : un appelant ne peut pas oublier le
 * foyer, puisqu'il ne le fournit pas. C'est la principale mesure de securite du
 * modele (voir worker/src/repos/index.ts).
 *
 * Un ecran d'administration dans l'application aurait exige d'ouvrir une
 * echappatoire a cette regle dans le Worker deploye : un role privilegie en
 * base, et un chemin d'acces qui voit tout. Une echappatoire qui existe finit
 * par etre empruntee ailleurs.
 *
 * D'ou cette forme : la console vit sur la machine de l'administrateur et
 * emprunte l'authentification de `wrangler`. Le site deploye ne gagne pas une
 * seule route. Ce qui n'existe pas ne se contourne pas.
 *
 * CE QUE CELA COUTE, et c'est assume : on n'administre pas depuis le
 * telephone. Il faut la machine ou `wrangler` est authentifie. Pour des gestes
 * rares et lourds de consequences, l'echange est bon.
 *
 * ---------------------------------------------------------------------------
 * PERIMETRE
 * ---------------------------------------------------------------------------
 * Les COMPTES : lister, desactiver, reactiver, supprimer.
 *
 * La creation n'est pas ici : elle passe par un lien d'invitation, pour que le
 * mot de passe ne transite ni par le reseau ni par l'ecran de l'administrateur,
 * et cette brique demande une route publique cote production. Second temps.
 *
 * Il n'y a AUCUN passe-plat SQL. Chaque geste est une route nommee, avec sa
 * requete ecrite ici : un champ « executer du SQL » serait plus souple, et
 * serait exactement le genre d'outil qui detruit une base un vendredi soir.
 */

import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CUISINE_CREEE, sqlCreationCuisine, sqlString } from '../lib/cuisine-sql.mjs'
import { TABLES_DU_FOYER } from '../lib/tables-foyer.mjs'
import { CIBLES, entier, executer, requete } from './d1.mjs'

const ICI = dirname(fileURLToPath(import.meta.url))
const RACINE = join(ICI, '..', '..')
const PUBLIC = join(ICI, 'public')

const PORT = Number(process.env['ADMIN_PORT'] ?? 8790)

// ---------------------------------------------------------------------------
// Requetes
// ---------------------------------------------------------------------------

/**
 * La liste des comptes, avec de quoi decider.
 *
 * On joint le foyer et on compte ce qu'il contient : « supprimer Ruddy » ne se
 * decide pas de la meme facon selon qu'il laisse derriere lui une cuisine vide
 * ou soixante recettes.
 */
const SQL_COMPTES = `
  SELECT u.id, u.username, u.display_name, u.is_active, u.created_at, u.last_login_at,
         u.household_id, h.name AS cuisine,
         (SELECT COUNT(*) FROM user x WHERE x.household_id = u.household_id) AS colocataires,
         (SELECT COUNT(*) FROM recipe r WHERE r.household_id = u.household_id) AS recettes,
         (SELECT COUNT(*) FROM ingredient i WHERE i.household_id = u.household_id) AS ingredients,
         (SELECT COUNT(*) FROM meal_plan_entry m WHERE m.household_id = u.household_id) AS planning,
         -- Une invitation encore ouverte : le compte existe mais n'a pas de mot
         -- de passe utilisable. Sans cette colonne, il apparaitrait « actif »
         -- alors que personne ne peut s'y connecter.
         (SELECT COUNT(*) FROM user_invite v
           WHERE v.user_id = u.id AND v.used_at IS NULL
             AND v.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS invitation_en_attente
    FROM user u
    LEFT JOIN household h ON h.id = u.household_id
   ORDER BY u.id`

/** Validite d'une invitation. Assez pour un aller-retour, pas pour dormir. */
const JOURS_VALIDITE = 7

const horodatage = (msDepuisMaintenant = 0) =>
  new Date(Date.now() + msDepuisMaintenant).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Pose une invitation sur un compte existant et rend le lien.
 *
 * Partage par la creation et par la reinitialisation : c'est le meme objet, et
 * deux copies auraient fini par diverger sur la duree ou sur le hachage.
 *
 * LES INVITATIONS PRECEDENTES SONT EFFACEES. Deux liens vivants pour un meme
 * compte, c'est un lien de trop a intercepter, et celui qu'on croyait perime
 * ouvre encore.
 */
async function poserInvitation(cible, identifiant, genre) {
  const jeton = randomBytes(32).toString('hex')
  const empreinte = createHash('sha256').update(jeton).digest('hex')
  const expiration = horodatage(JOURS_VALIDITE * 24 * 60 * 60 * 1000)
  const ou = `(SELECT id FROM user WHERE username = ${sqlString(identifiant)})`

  await executer(
    `DELETE FROM user_invite WHERE user_id = ${ou};\n` +
      `INSERT INTO user_invite (token_hash, user_id, expires_at, kind)\n` +
      `VALUES (${sqlString(empreinte)}, ${ou}, ${sqlString(expiration)}, ${sqlString(genre)});\n`,
    cible,
  )

  return { lien: `${CIBLES[cible].site}/invitation/${jeton}`, expiration }
}

/**
 * Reinitialise le mot de passe d'un compte existant.
 *
 * L'administrateur n'en choisit pas davantage un ici qu'a la creation. Le
 * compte garde sa cuisine, ses recettes et son historique : seul le moyen d'y
 * entrer est renouvele.
 *
 * L'ancien mot de passe reste valable jusqu'a ce que le lien soit suivi. Le
 * revoquer tout de suite couperait quelqu'un qui n'a rien demande, sur la foi
 * d'un clic. Pour couper immediatement, il y a « Desactiver ».
 */
async function reinitialiser(cible, id) {
  const { lignes } = await requete(
    `SELECT username FROM user WHERE id = ${id}`,
    cible,
  )
  const identifiant = lignes[0]?.username
  if (!identifiant) throw new Error(`Aucun compte n° ${id} sur ${CIBLES[cible].nom}.`)

  const { lien, expiration } = await poserInvitation(cible, identifiant, 'reinitialisation')
  return { identifiant, lien, expiration }
}

/**
 * Cree un compte, sa cuisine, et l'invitation qui permettra d'y poser un mot
 * de passe.
 *
 * L'ADMINISTRATEUR NE CHOISIT PAS LE MOT DE PASSE D'AUTRUI. Le compte nait
 * avec une empreinte tiree au hasard, qu'aucune saisie ne peut satisfaire :
 * il est inutilisable jusqu'a ce que son proprietaire suive le lien. Le mot de
 * passe ne transite alors ni par le reseau de l'administrateur ni par son
 * ecran.
 */
async function creerCompte(cible, corps) {
  const identifiant = String(corps.identifiant ?? '')
    .trim()
    .toLowerCase()
  const nomAffiche = String(corps.nomAffiche ?? '').trim() || identifiant
  const cuisine = String(corps.cuisine ?? '').trim()

  if (!/^[a-z0-9_-]{2,32}$/.test(identifiant)) {
    throw new Error("L'identifiant doit faire 2 à 32 caractères : lettres, chiffres, tiret, souligné.")
  }
  if (cuisine === '') {
    throw new Error(
      'Le nom de la cuisine est obligatoire. Chaque compte a la sienne : il n’existe aucun ' +
        'moyen de placer quelqu’un dans la cuisine d’un autre.',
    )
  }
  if (nomAffiche.length > 60 || cuisine.length > 60) {
    throw new Error('Nom affiché et cuisine : 60 caractères au maximum.')
  }

  // On demande a la base AVANT d'ecrire : rien ici n'est transactionnel, et un
  // INSERT de compte qui echoue apres la creation de la cuisine laisserait un
  // foyer sans habitant. C'est exactement ce qui s'est produit le 16 aout 2026.
  const { lignes } = await requete(
    `SELECT COUNT(*) AS n FROM user WHERE username = ${sqlString(identifiant)}`,
    cible,
  )
  if (Number(lignes[0]?.n ?? 0) > 0) {
    throw new Error(`L'identifiant « ${identifiant} » est déjà pris sur ${CIBLES[cible].nom}.`)
  }

  // Empreinte de mot de passe inutilisable : aucune saisie ne peut deriver
  // vers une valeur aleatoire. Le compte n'ouvre qu'apres l'invitation.
  const hashImpossible = randomBytes(32).toString('hex')
  const selImpossible = randomBytes(16).toString('hex')

  await executer(
    sqlCreationCuisine(cuisine) +
      `INSERT INTO user (username, display_name, household_id, password_hash, password_salt, iterations)\n` +
      `VALUES (${sqlString(identifiant)}, ${sqlString(nomAffiche)}, ${CUISINE_CREEE},\n` +
      `        ${sqlString(hashImpossible)}, ${sqlString(selImpossible)}, 100000);\n`,
    cible,
  )

  /*
   * ON VERIFIE, ON NE CROIT PAS LE CODE DE SORTIE.
   *
   * Faute de transaction, la cuisine peut exister sans son compte. On le
   * constate et on nettoie, plutot que de laisser un foyer fantome que
   * personne ne verra avant des semaines.
   */
  const apres = await requete(
    `SELECT id FROM user WHERE username = ${sqlString(identifiant)}`,
    cible,
  )

  if (!apres.lignes[0]) {
    await executer(
      `DELETE FROM ingredient WHERE household_id = ${CUISINE_CREEE};\n` +
        `DELETE FROM household WHERE id = ${CUISINE_CREEE};\n`,
      cible,
    )
    throw new Error(
      "Le compte n'a pas été créé. La cuisine qui venait d'être ouverte a été retirée.",
    )
  }

  const { lien, expiration } = await poserInvitation(cible, identifiant, 'creation')
  return { identifiant, lien, expiration }
}

// ---------------------------------------------------------------------------
// Cuisines
// ---------------------------------------------------------------------------

const SQL_CUISINES = `
  SELECT h.id, h.name,
         (SELECT group_concat(u.username) FROM user u WHERE u.household_id = h.id) AS habitants,
         (SELECT COUNT(*) FROM user u WHERE u.household_id = h.id) AS comptes,
         (SELECT COUNT(*) FROM recipe r WHERE r.household_id = h.id) AS recettes,
         (SELECT COUNT(*) FROM ingredient i WHERE i.household_id = h.id) AS ingredients,
         (SELECT COUNT(*) FROM meal_plan_entry m WHERE m.household_id = h.id) AS planning,
         (SELECT COUNT(*) FROM pantry_stock p WHERE p.household_id = h.id) AS frigo,
         (SELECT COUNT(*) FROM ingredient_price_history x WHERE x.household_id = h.id) AS prix
    FROM household h
   ORDER BY h.id`

async function renommerCuisine(cible, id, corps) {
  const nom = String(corps.nom ?? '').trim()
  if (nom === '') throw new Error('Le nom ne peut pas être vide.')
  if (nom.length > 60) throw new Error('60 caractères au maximum.')

  // On verifie l'EXISTENCE avant, et le RESULTAT apres, plutot que de croire
  // `meta.changes` : il n'existe pas sur la cible locale (voir d1.mjs).
  const avant = await requete(`SELECT name FROM household WHERE id = ${id}`, cible)
  if (!avant.lignes[0]) throw new Error(`Aucune cuisine n° ${id}.`)

  await requete(`UPDATE household SET name = ${sqlString(nom)} WHERE id = ${id}`, cible)

  const apres = await requete(`SELECT name FROM household WHERE id = ${id}`, cible)
  if (apres.lignes[0]?.name !== nom) {
    throw new Error(`Le renommage n'a pas pris : la cuisine n° ${id} s'appelle toujours « ${apres.lignes[0]?.name} ».`)
  }
  return { nom }
}

/**
 * Retire une cuisine ET tout ce qu'elle contient.
 *
 * C'est la seule action de cette console qui detruit des donnees en volume,
 * d'ou le refus categorique tant qu'un compte l'habite : supprimer la cuisine
 * de quelqu'un lui laisserait un compte qui s'ouvre sur une application vide,
 * sans rien pour lui dire ce qui s'est passe.
 */
async function supprimerCuisine(cible, id) {
  const { lignes } = await requete(
    `SELECT (SELECT COUNT(*) FROM user WHERE household_id = ${id}) AS comptes,
            (SELECT name FROM household WHERE id = ${id}) AS nom`,
    cible,
  )
  const etat = lignes[0]
  if (!etat || etat.nom === null || etat.nom === 'null') throw new Error(`Aucune cuisine n° ${id}.`)
  if (Number(etat.comptes ?? 0) > 0) {
    throw new Error(
      `« ${etat.nom} » est habitée par ${etat.comptes} compte(s). ` +
        `Supprime-les ou déplace-les d'abord : une cuisine retirée sous un compte ` +
        `le laisserait devant une application vide.`,
    )
  }

  const sql =
    TABLES_DU_FOYER.map((t) => `DELETE FROM ${t} WHERE household_id = ${id};`).join('\n') +
    `\nDELETE FROM household WHERE id = ${id};\n`

  await executer(sql, cible)

  const reste = await requete(`SELECT COUNT(*) AS n FROM household WHERE id = ${id}`, cible)
  if (Number(reste.lignes[0]?.n ?? 0) > 0) {
    throw new Error(`La cuisine n° ${id} n'a pas pu être retirée. Rien n'a été confirmé.`)
  }
  return { supprimee: etat.nom }
}

// ---------------------------------------------------------------------------
// Controle de sante
// ---------------------------------------------------------------------------

/**
 * Les verifications faites a la main le 16 aout 2026, en un ecran.
 *
 * Chacune correspond a un desordre CONSTATE, pas imagine. Un controle qui ne
 * s'est jamais declenche sur du reel finit par etre ignore.
 */
const SQL_SANTE = `
  SELECT
    (SELECT COUNT(*) FROM household h WHERE NOT EXISTS
       (SELECT 1 FROM user u WHERE u.household_id = h.id))                       AS cuisines_sans_habitant,
    (SELECT COUNT(*) FROM user u WHERE u.household_id NOT IN
       (SELECT id FROM household))                                               AS comptes_sans_cuisine,
    (SELECT COUNT(*) FROM household h WHERE
       (SELECT COUNT(*) FROM user u WHERE u.household_id = h.id) > 1)            AS cuisines_partagees,
    (SELECT COUNT(*) FROM ingredient)                                            AS ingredients,
    (SELECT COUNT(*) FROM ingredient_fts)                                        AS index_fts,
    (SELECT COUNT(*) FROM user_invite WHERE used_at IS NULL
       AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now'))                    AS invitations_ouvertes,
    (SELECT COUNT(*) FROM user_invite WHERE used_at IS NULL
       AND expires_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now'))                   AS invitations_perimees,
    (SELECT COUNT(*) FROM user WHERE is_active = 0)                              AS comptes_desactives`

async function sante(cible) {
  const { lignes } = await requete(SQL_SANTE, cible)
  const b = lignes[0] ?? {}
  const n = (cle) => Number(b[cle] ?? 0)

  /*
   * Chaque constat porte son verdict ET ce qu'il faut en faire.
   *
   * Un tableau de bord qui affiche « 3 » sans dire si c'est grave oblige a
   * aller relire le code pour l'interpreter — donc n'est pas consulte.
   */
  const controles = [
    {
      nom: 'Cuisines partagées',
      valeur: n('cuisines_partagees'),
      grave: n('cuisines_partagees') > 0,
      detail:
        'Le projet prévoit une cuisine par compte. Le partage ne doit venir que ' +
        "d'une invitation acceptée, fonctionnalité qui n'existe pas encore : toute " +
        'cuisine partagée aujourd’hui est donc un accident.',
    },
    {
      nom: 'Comptes sans cuisine',
      valeur: n('comptes_sans_cuisine'),
      grave: n('comptes_sans_cuisine') > 0,
      detail:
        'Le compte pointe vers un foyer inexistant : il ouvre une application vide ' +
        'et aucune écriture ne retrouvera ses données.',
    },
    {
      nom: 'Cuisines sans habitant',
      valeur: n('cuisines_sans_habitant'),
      grave: false,
      detail:
        "Reste d'une création interrompue ou d'un compte supprimé. Sans gravité, " +
        'mais chacune porte une copie du catalogue : elles pèsent.',
    },
    {
      nom: 'Index de recherche',
      valeur: `${n('index_fts')} / ${n('ingredients')}`,
      grave: n('index_fts') !== n('ingredients'),
      detail:
        "L'index FTS5 doit compter exactement autant de lignes que la table des " +
        'ingrédients. Un écart fait disparaître des aliments de la recherche sans ' +
        'aucun message.',
    },
    {
      nom: 'Invitations ouvertes',
      valeur: n('invitations_ouvertes'),
      grave: false,
      detail: "Liens encore valables. Chacun ouvre un compte : il n'en faut pas d'oubliés.",
    },
    {
      nom: 'Invitations périmées',
      valeur: n('invitations_perimees'),
      grave: false,
      detail: 'Sans effet. Elles disparaissent au prochain lien émis pour le même compte.',
    },
    {
      nom: 'Comptes désactivés',
      valeur: n('comptes_desactives'),
      grave: false,
      detail: 'Ils ne peuvent plus se connecter, leurs données sont conservées.',
    },
  ]

  return { controles }
}

/** Active ou desactive, et RELIT pour dire ce qui s'est reellement passe. */
async function basculerActif(cible, id, valeur) {
  await requete(`UPDATE user SET is_active = ${valeur} WHERE id = ${id}`, cible)
  const { lignes } = await requete(`SELECT is_active FROM user WHERE id = ${id}`, cible)
  if (!lignes[0]) throw new Error(`Aucun compte n° ${id}.`)
  if (Number(lignes[0].is_active) !== valeur) {
    throw new Error(`L'état du compte n° ${id} n'a pas changé.`)
  }
  return { actif: valeur === 1 }
}

const routes = {
  'GET /api/comptes': async (cible) => ({ comptes: (await requete(SQL_COMPTES, cible)).lignes }),

  'POST /api/comptes': async (cible, _id, corps) => creerCompte(cible, corps ?? {}),

  'POST /api/comptes/:id/reinitialiser': async (cible, id) => reinitialiser(cible, id),

  'GET /api/cuisines': async (cible) => ({ cuisines: (await requete(SQL_CUISINES, cible)).lignes }),

  'POST /api/cuisines/:id/renommer': async (cible, id, corps) =>
    renommerCuisine(cible, id, corps ?? {}),

  'DELETE /api/cuisines/:id': async (cible, id) => supprimerCuisine(cible, id),

  'GET /api/sante': async (cible) => sante(cible),

  // On RELIT l'etat apres coup plutot que de rapporter `meta.changes`, absent
  // en local : un ecran qui affiche « 0 ligne modifiée » sur une operation
  // reussie apprend a se mefier de lui-meme.
  'POST /api/comptes/:id/desactiver': async (cible, id) => basculerActif(cible, id, 0),

  'POST /api/comptes/:id/activer': async (cible, id) => basculerActif(cible, id, 1),

  /*
   * La suppression ne touche QUE le compte, jamais sa cuisine.
   *
   * Les donnees personnelles partent avec lui par cascade (`user_profile`,
   * `weight_log`, `hydration_day`, et ses appareils, reglages et journal de
   * notifications), et ses traces de modification passent a
   * NULL. Mais recettes, frigo et prix appartiennent au FOYER : les emporter
   * ferait disparaitre une cuisine entiere sur un geste qui dit « supprimer un
   * compte ». La cuisine devenue vide reste, et se voit dans la liste.
   */
  'DELETE /api/comptes/:id': async (cible, id) => {
    await requete(`DELETE FROM user WHERE id = ${id}`, cible)
    const reste = await requete(`SELECT COUNT(*) AS n FROM user WHERE id = ${id}`, cible)
    if (Number(reste.lignes[0]?.n ?? 0) > 0) {
      throw new Error(`Le compte n° ${id} est toujours là. Rien n'a été confirmé.`)
    }
    return { supprime: id }
  },
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const json = (reponse, code, corps) => {
  reponse.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  reponse.end(JSON.stringify(corps))
}

/**
 * Sert un fichier, en refusant tout ce qui sort du dossier autorise.
 *
 * `normalize` puis verification du prefixe : sans elle, « ../../.dev.vars »
 * serait servi par un outil qui tourne justement sur la machine ou vivent les
 * secrets.
 */
async function servirFichier(reponse, base, chemin) {
  const complet = normalize(join(base, chemin))
  if (!complet.startsWith(normalize(base))) {
    reponse.writeHead(403).end('Interdit')
    return
  }
  try {
    const contenu = await readFile(complet)
    reponse.writeHead(200, {
      'content-type': TYPES[extname(complet)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    reponse.end(contenu)
  } catch {
    reponse.writeHead(404).end('Introuvable')
  }
}

/**
 * Le corps JSON d'une requete, borne.
 *
 * La borne n'est pas une precaution de facade : sans elle, un corps sans fin
 * remplit la memoire du processus. Cette console tourne sur un poste, mais
 * c'est le genre de detail qu'on n'ajoute jamais apres coup.
 */
async function lireCorps(requeteHttp) {
  const morceaux = []
  let taille = 0
  for await (const morceau of requeteHttp) {
    taille += morceau.length
    if (taille > 64 * 1024) throw new Error('Corps de requête trop volumineux.')
    morceaux.push(morceau)
  }
  if (morceaux.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(morceaux).toString('utf8'))
  } catch {
    throw new Error('Corps de requête illisible.')
  }
}

const serveur = createServer(async (requeteHttp, reponse) => {
  const url = new URL(requeteHttp.url, `http://localhost:${PORT}`)
  const chemin = url.pathname

  try {
    if (chemin.startsWith('/api/')) {
      const cible = url.searchParams.get('cible') ?? 'local'
      if (!CIBLES[cible]) return json(reponse, 400, { erreur: `Cible inconnue : ${cible}` })

      // Un identifiant dans le chemin est TOUJOURS un entier : c'est ce qui
      // permet de l'interpoler dans le SQL sans risque (voir d1.mjs).
      const parts = chemin.split('/')
      const idBrut = parts[3]
      const id = idBrut === undefined ? null : entier(idBrut)
      const motif = `${requeteHttp.method} ${chemin.replace(/\/\d+\//, '/:id/').replace(/\/\d+$/, '/:id')}`

      const gestionnaire = routes[motif]
      if (!gestionnaire) return json(reponse, 404, { erreur: `Route inconnue : ${motif}` })
      if (motif.includes(':id') && id === null) {
        return json(reponse, 400, { erreur: 'Identifiant invalide.' })
      }

      const corps = requeteHttp.method === 'POST' ? await lireCorps(requeteHttp) : null
      return json(reponse, 200, await gestionnaire(cible, id, corps))
    }

    // Le theme de l'application, servi tel quel : la console ne redefinit
    // aucune couleur, sinon les deux jeux divergeraient.
    if (chemin === '/theme.css') {
      return servirFichier(reponse, join(RACINE, 'web', 'src', 'styles'), 'theme.css')
    }

    return servirFichier(reponse, PUBLIC, chemin === '/' ? 'index.html' : chemin)
  } catch (erreur) {
    json(reponse, 500, { erreur: String(erreur.message ?? erreur) })
  }
})

/*
 * 127.0.0.1 EXPLICITEMENT, jamais 0.0.0.0.
 *
 * Sans cela le serveur ecouterait sur toutes les interfaces, et une console
 * capable de supprimer des comptes en production serait joignable par
 * n'importe qui sur le reseau local — un cafe, un train, un bureau partage.
 */
serveur.listen(PORT, '127.0.0.1', () => {
  console.log(`Console d'administration : http://127.0.0.1:${PORT}`)
})
