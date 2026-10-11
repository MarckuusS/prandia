/**
 * Remplace les dessins maison par ceux de Lucide.
 *
 * POURQUOI PASSER PAR UN SCRIPT plutot que d'ajouter la dependance `lucide-react`.
 * Le paquet expose un composant par icone, tire React, et laisse chaque icone
 * poser ses propres attributs — exactement ce que `Icon.tsx` interdit depuis le
 * debut pour qu'aucune icone ne puisse deriver du systeme. On prend donc la
 * MATIERE (les chemins) et on garde notre cadre : grille 24, trait 1,6,
 * `currentColor` pose une seule fois.
 *
 * L'extraction reutilise `sanitizeSvg`, l'assainisseur ecrit pour les icones
 * collees par l'utilisateur. Ce n'est pas de la paranoia deplacee : c'est
 * exactement le meme besoin — retirer la balise racine et ne garder que les
 * formes — et le faire passer par le meme code garantit que les icones du jeu
 * et les icones collees subissent le meme traitement.
 *
 *   node scripts/import-lucide.mjs          # ecrit paths/ui.ts et paths/rayons.ts
 *   node scripts/import-lucide.mjs --check  # verifie seulement, n'ecrit rien
 */

import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')

/**
 * Versions FIGEES. « latest » rendrait ce script non reproductible d'un mois
 * sur l'autre.
 *
 * DEUX SOURCES, et non une. Lucide couvre l'interface et la plupart des rayons,
 * mais n'a ni brique de lait ni fromage : son `milk` est une bouteille. Tabler,
 * meme grille 24 et meme trait, en a. Un nom prefixe `tabler:` va la chercher.
 *
 * Les deux licences sont permissives et exigent la meme chose : conserver leur
 * texte. Voir LICENSE-lucide.txt et LICENSE-tabler.txt.
 */
const LUCIDE_VERSION = '0.469.0'
const TABLER_VERSION = '3.31.0'

const CDN = (name) =>
  name.startsWith('tabler:')
    ? `https://unpkg.com/@tabler/icons@${TABLER_VERSION}/icons/outline/${name.slice(7)}.svg`
    : `https://unpkg.com/lucide-static@${LUCIDE_VERSION}/icons/${name}.svg`

/**
 * Notre nom -> nom Lucide.
 *
 * Les ecarts qui meritent d'etre expliques :
 *
 *   - `ui-price` prend `badge-euro` et non `circle-dollar-sign` : l'application
 *     est en euros, et un dollar sur un prix francais est une petite trahison
 *     qu'on remarque.
 *   - `ui-screen-awake` prend `vibrate` : c'est le seul dessin de Lucide qui
 *     montre un telephone qui ne s'endort pas. `sun` etait deja pris par le
 *     theme, et les deux cote a cote etaient illisibles.
 *   - `rayon-epicerie` prend `shopping-bag` et `ui-basket` `shopping-basket` :
 *     les deux existent chez Lucide et se distinguent bien, ce qui evite le
 *     doublon que le panier et le cabas formaient dans ma version.
 *   - `ui-star-filled` n'existe pas chez Lucide, qui ne dessine qu'au trait.
 *     On reprend `star` et on la remplit (voir FILLED plus bas).
 */
const MAP = {
  // ---------- Navigation ----------
  'ui-chevron-left': 'chevron-left',
  'ui-chevron-right': 'chevron-right',
  'ui-chevron-up': 'chevron-up',
  'ui-chevron-down': 'chevron-down',
  'ui-arrow-left': 'arrow-left',
  'ui-arrow-right': 'arrow-right',

  // ---------- Actions ----------
  'ui-plus': 'plus',
  'ui-minus': 'minus',
  'ui-close': 'x',
  'ui-check': 'check',
  'ui-check-circle': 'circle-check',
  'ui-close-circle': 'circle-x',
  'ui-edit': 'pencil',
  'ui-trash': 'trash-2',
  'ui-eraser': 'eraser',
  'ui-copy': 'copy',
  'ui-save': 'save',
  'ui-folder': 'folder',
  'ui-refresh': 'rotate-ccw',
  // Remplacer un ingredient par un autre : `rotate-ccw` s'y lisait "annuler".
  'ui-swap': 'arrow-left-right',
  'ui-download': 'download',
  'ui-share': 'share-2',
  'ui-external-link': 'external-link',

  // ---------- Recherche, tri, filtres ----------
  'ui-search': 'search',
  'ui-filter': 'funnel',
  'ui-sliders': 'sliders-horizontal',
  'ui-sort': 'arrow-up-down',
  'ui-list': 'list',
  'ui-grip': 'grip-vertical',
  'ui-more': 'ellipsis',

  // ---------- Theme et reglages ----------
  'ui-sun': 'sun',
  'ui-moon': 'moon',
  'ui-settings': 'settings',
  'ui-screen-awake': 'vibrate',
  // Les trois destinations de l'ecran Parametres. Un rang de navigation sans
  // dessin se lit comme un paragraphe : c'est l'icone qui le rend reperable
  // avant d'etre lu.
  'ui-palette': 'palette',
  'ui-shapes': 'shapes',
  'ui-history': 'history',

  // ---------- Etats et signaux ----------
  'ui-alert': 'triangle-alert',
  'ui-info': 'info',
  'ui-star': 'star',
  'ui-star-filled': 'star',
  'ui-heart': 'heart',
  'ui-clock': 'clock',
  'ui-timer': 'timer',
  'ui-flame': 'flame',
  'ui-lock': 'lock',
  'ui-user': 'user',
  'ui-logout': 'log-out',

  // ---------- Metiers ----------
  'ui-calendar': 'calendar',
  'ui-cart': 'shopping-cart',
  'ui-basket': 'shopping-basket',
  'ui-fridge': 'refrigerator',
  'ui-utensils': 'utensils',
  'ui-book': 'book-open',
  'ui-scale': 'scale',
  'ui-chart': 'chart-column',
  'ui-price': 'badge-euro',
  'ui-tag': 'tag',
  'ui-leaf': 'leaf',
  'ui-barcode': 'barcode',
  'ui-camera': 'camera',

  // ---------- Nutriments ----------
  // Les huit lignes du tableau reglementaire. Elles etaient des PNG de 250 px
  // reduits a 72, quantifies en palette, pour 58 Ko a huit : une image ne se
  // teinte pas, ne suit pas le theme sombre et se voit a l'agrandissement.
  // Les sous-lignes derivent de leur famille — les satures sont deux gouttes
  // la ou les lipides en ont une.
  'ui-zap': 'zap',
  'ui-wheat': 'wheat',
  'ui-candy': 'candy',
  'ui-droplet': 'droplet',
  'ui-droplets': 'droplets',
  'ui-biceps': 'biceps-flexed',
  // Lucide n'a pas de saliere ; Tabler si, et c'est le dessin qu'on reconnait.
  'ui-salt': 'tabler:salt',

  // ---------- Barre d'onglets ----------
  // Ces quatre-la ne servent QU'A la navigation principale, d'ou leur groupe :
  // les changer se voit sur tous les ecrans a la fois.
  'ui-home': 'house',
  // La fleche qui monte, et non un graphique : un objectif est une direction,
  // pas un releve. C'est le dessin du mockup.
  'ui-goal': 'trending-up',
  // Le cadre de visee avec sa ligne de balayage — `barcode` dessine le
  // code-barres lui-meme, ce qui decrit la CIBLE et non le geste.
  'ui-scan': 'scan-line',

  // ---------- Rayons ----------
  'rayon-fruits-legumes': 'apple',
  'rayon-boulangerie': 'croissant',
  'rayon-boucherie': 'beef',
  'rayon-poissonnerie': 'fish',
  // Tabler et non Lucide : le `milk` de Lucide est une BOUTEILLE, celui de
  // Tabler une brique. C'est une brique qu'on achete.
  'rayon-produits-laitiers': 'tabler:milk',
  // Aucun des deux jeux n'a de pot de yaourt a opercule : `tabler:milk` n'est
  // ici qu'un repli, le dessin reel vit dans paths/overrides.ts.
  'rayon-frais': 'tabler:milk',
  'rayon-boissons': 'cup-soda',
  'rayon-surgeles': 'snowflake',
  'rayon-epicerie': 'shopping-bag',
  'rayon-snacks-confiseries': 'candy',
  'rayon-autre': 'package',
}

/** Icones a remplir apres coup : Lucide ne dessine qu'au trait. */
const FILLED = new Set(['ui-star-filled'])

/**
 * Noms de repli, essayes dans l'ordre si le premier rend 404.
 *
 * Lucide renomme regulierement (`filter` est devenu `funnel`, `bar-chart` est
 * devenu `chart-column`). Figer la version protege du changement, mais pas
 * d'une erreur de ma part sur un nom : le repli evite d'avoir a relancer le
 * script trois fois pour trouver la bonne orthographe.
 */
const FALLBACKS = {
  funnel: ['filter', 'list-filter'],
  'chart-column': ['bar-chart-3', 'bar-chart'],
  'triangle-alert': ['alert-triangle'],
  'circle-check': ['check-circle'],
  'circle-x': ['x-circle'],
  ellipsis: ['more-horizontal'],
  'badge-euro': ['euro', 'circle-dollar-sign'],
  house: ['home'],
  'scan-line': ['scan', 'scan-barcode'],
  // Recemment ajoutee chez Lucide : le repli couvre une version plus ancienne.
  'biceps-flexed': ['dumbbell'],
}

async function loadSanitizer() {
  const result = await build({
    entryPoints: [join(ROOT, 'shared/src/svg.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { sanitizeSvg } = await loadSanitizer()

async function fetchIcon(lucideName) {
  for (const candidate of [lucideName, ...(FALLBACKS[lucideName] ?? [])]) {
    const response = await fetch(CDN(candidate))
    if (response.ok) return { name: candidate, svg: await response.text() }
  }
  return null
}

const results = []
const failures = []

// En serie et non en parallele : soixante-sept requetes simultanees sur un CDN
// public sont un comportement de robot mal eleve, et le script tourne trois
// fois par an.
for (const [ours, theirs] of Object.entries(MAP)) {
  const fetched = await fetchIcon(theirs)
  if (fetched === null) {
    failures.push(`${ours} -> ${theirs} (introuvable)`)
    continue
  }

  const { markup, viewBox, removed } = sanitizeSvg(fetched.svg)
  if (markup === '') {
    failures.push(`${ours} -> ${fetched.name} (rien de dessinable)`)
    continue
  }
  if (viewBox !== '0 0 24 24') {
    failures.push(`${ours} -> ${fetched.name} (grille ${viewBox}, attendu 0 0 24 24)`)
    continue
  }

  // Tabler ouvre chaque icone par un rectangle transparent de 24 x 24, qui ne
  // dessine rien mais fausserait toute mesure de boite englobante — et
  // alourdit le bundle de soixante octets par icone.
  const cleaned = markup.replace(/<path[^>]*d="M0 0h24v24H0z"[^>]*\/>/g, '')

  const final = FILLED.has(ours)
    ? cleaned.replace(/<path /g, '<path fill="currentColor" ')
    : cleaned

  results.push({ ours, theirs: fetched.name, markup: final, renamed: fetched.name !== theirs, removed })
  process.stdout.write('.')
}

process.stdout.write('\n')

if (failures.length > 0) {
  console.error('\nECHECS :')
  for (const f of failures) console.error('  ' + f)
  process.exitCode = 1
}

const renamed = results.filter((r) => r.renamed)
if (renamed.length > 0) {
  console.log('\nReplis utilises (nom Lucide different de celui attendu) :')
  for (const r of renamed) console.log(`  ${r.ours} -> ${r.theirs}`)
}

console.log(`\n${results.length}/${Object.keys(MAP).length} icones recuperees.`)

if (CHECK_ONLY || failures.length > 0) {
  if (failures.length > 0) console.error('\nRien ecrit : corrige la correspondance et relance.')
  process.exit(process.exitCode ?? 0)
}

// ---------------------------------------------------------------------------
// Ecriture
// ---------------------------------------------------------------------------

const header = (title, note) => `/**
 * ${title}
 *
 * DESSINS REPRIS DE LUCIDE (https://lucide.dev, ISC) et de TABLER
 * (https://tabler.io/icons, MIT). Le commentaire au-dessus de chaque icone dit
 * laquelle des deux sources l'a fournie. Voir LICENSE-lucide.txt et
 * LICENSE-tabler.txt dans ce dossier. Ne pas retoucher a la main — regenerer avec
 * \`node scripts/import-lucide.mjs\`, qui part de la table de correspondance.
 *
 * Seul le CONTENU du \`<svg>\` est conserve. Les attributs communs (trait,
 * epaisseur, jonctions) sont poses une fois par \`Icon.tsx\`, ce qui garantit
 * qu'aucune icone ne peut deriver du systeme en redefinissant les siens — et
 * c'est aussi ce qui permet de rendre ces dessins a 1,6 d'epaisseur quand
 * Lucide les publie a 2.
 *
${note}
 */
`

const body = (constName, entries) =>
  `export const ${constName} = {\n` +
  entries
    .map((r) => {
      const key = /^[a-z][a-z0-9]*$/.test(r.ours) ? r.ours : `'${r.ours}'`
      // L'etiquette dit QUELLE source a fourni le dessin : les deux ne portent
      // pas la meme licence, et l'information doit rester lisible dans le fichier.
      const source = r.theirs.startsWith('tabler:')
        ? `tabler: ${r.theirs.slice(7)}`
        : `lucide: ${r.theirs}`
      return `  // ${source}
  ${key}:
    '${r.markup.replace(/'/g, "\'")}',`
    })
    .join('\n') +
  '\n} as const\n'

const uiEntries = results.filter((r) => r.ours.startsWith('ui-'))
const rayonEntries = results.filter((r) => r.ours.startsWith('rayon-'))

await writeFile(
  join(ROOT, 'web/src/icons/paths/ui.ts'),
  header(
    'Icones d’interface.',
    ' * `ui-star-filled` est la seule retouche : Lucide ne dessine qu’au trait,\n' +
      ' * l’etoile pleine reprend donc `star` avec un remplissage ajoute.',
  ) + '\n' + body('UI_PATHS', uiEntries),
  'utf8',
)

await writeFile(
  join(ROOT, 'web/src/icons/paths/rayons.ts'),
  header(
    'Icones de rayon — une par en-tete de section.',
    ' * Un rayon doit se lire comme un lieu du magasin. Le cabas de l’epicerie et\n' +
      ' * le panier de l’onglet Ingredients sont deux dessins distincts chez Lucide,\n' +
      ' * ce qui leve la confusion qu’ils avaient dans le jeu precedent.',
  ) + '\n' + body('RAYON_PATHS', rayonEntries),
  'utf8',
)

console.log(`Ecrit : paths/ui.ts (${uiEntries.length}) et paths/rayons.ts (${rayonEntries.length}).`)
