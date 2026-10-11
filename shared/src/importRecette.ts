/**
 * Importer une recette depuis un lien : ce qui se lit sans reseau.
 *
 * Trois choses, toutes PURES et testees comme des specifications :
 *   - lire une ligne d'ingredient ecrite en francais ("1,5 c. a soupe d'huile
 *     d'olive") en quantite, unite et nom ;
 *   - lire le bloc "Recipe" que presque tous les sites de cuisine cachent dans
 *     leur page (JSON-LD de schema.org), pour les robots des moteurs de
 *     recherche ;
 *   - classer les ingredients candidats d'une ligne.
 *
 * Portage de app/services/recipe_url_importer/ (quantity_parser.py et
 * jsonld_fallback.py), avec ses tests, et quelques ajouts : fractions ecrites
 * "½", fourchettes "2 a 3", contenance entre parentheses "(400 g)".
 *
 * ON NE LIT QUE LE JSON-LD, pas la page. C'est ce que les sites publient
 * EXPRES pour etre lus par des machines ; deviner une recette dans une mise en
 * page casserait a la premiere refonte du site, et silencieusement.
 */

import { toGrams, PIECE_UNIT_CODE } from './units.js'
import { splitSentences } from './steps.js'
import { normalizeName } from './text.js'

// ---------------------------------------------------------------------------
// Le lien
// ---------------------------------------------------------------------------

/** Adresses qui ne menent pas a un site public : jamais lues. */
const HOTE_PRIVE =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i

/**
 * Le lien d'une recette dans un texte colle, ou `null`.
 *
 * Copier depuis Safari donne l'adresse seule ; partager depuis une autre app
 * colle souvent "Titre de la recette https://...". On prend donc la PREMIERE
 * adresse web du texte, et a defaut un texte qui ressemble a un domaine
 * ("marmiton.org/recettes/..."), complete en https.
 *
 * Refuse ce qui ne mene pas a un site public (machine locale, reseau prive,
 * adresse IPv6 litterale) et les adresses porteuses d'identifiants : le
 * serveur ira chercher la page, il ne doit jamais etre envoye ailleurs que
 * sur le web ouvert.
 */
export function lienRecette(texte: string): string | null {
  const brut = (texte ?? '').trim()
  const trouve = /https?:\/\/[^\s<>"']+/i.exec(brut)?.[0] ?? (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(brut) ? `https://${brut}` : null)
  if (trouve === null) return null
  let url: URL
  try {
    url = new URL(trouve.replace(/[),.;!?]+$/, ''))
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.hostname.startsWith('[') || HOTE_PRIVE.test(url.hostname)) return null
  if (!url.hostname.includes('.')) return null
  url.hash = ''
  return url.toString()
}

// ---------------------------------------------------------------------------
// Une ligne d'ingredient
// ---------------------------------------------------------------------------

export interface ParsedIngredientLine {
  /** `null` : aucune quantite ecrite ("Sel, poivre"). */
  readonly quantity: number | null
  /** Code d'unite de `units.ts`, ou `null` : un nombre de pieces ("3 carottes"). */
  readonly unit: string | null
  /** Le reste, nettoye. Jamais vide si la ligne ne l'etait pas. */
  readonly name: string
  /**
   * Le mot de portion ou de contenant lu ("gousse", "feuille", "sachet"), au
   * singulier et sans accent, ou `null`. Il donne un ordre de grandeur quand
   * la ligne n'a pas d'unite : voir `PORTIONS_G`.
   */
  readonly portion: string | null
}

/** Minuscules sans accents, pour comparer les alias. Meme longueur que l'entree. */
const plier = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

/**
 * Alias d'unites, du PLUS LONG au plus court : "c. a soupe" doit etre essaye
 * avant "c", "kg" avant "g". Compares sur la forme pliee.
 */
const ALIAS_BRUTS: Array<[string, string]> = [
  ['cuilleres a soupe', 'c_soupe'],
  ['cuillere a soupe', 'c_soupe'],
  ['cuillerees a soupe', 'c_soupe'],
  ['cuilleree a soupe', 'c_soupe'],
  ['cuil. a soupe', 'c_soupe'],
  ['c. a soupe', 'c_soupe'],
  ['c. a s.', 'c_soupe'],
  ['c a s', 'c_soupe'],
  ['c.a.s', 'c_soupe'],
  ['c.a.s.', 'c_soupe'],
  ['c a soupe', 'c_soupe'],
  ['cas', 'c_soupe'],
  ['c.s.', 'c_soupe'],
  ['c.s', 'c_soupe'],
  ['cs', 'c_soupe'],
  ['cuilleres a cafe', 'c_cafe'],
  ['cuillere a cafe', 'c_cafe'],
  ['cuillerees a cafe', 'c_cafe'],
  ['cuilleree a cafe', 'c_cafe'],
  ['cuil. a cafe', 'c_cafe'],
  ['c. a cafe', 'c_cafe'],
  ['c. a c.', 'c_cafe'],
  ['c a c', 'c_cafe'],
  ['c.a.c', 'c_cafe'],
  ['c.a.c.', 'c_cafe'],
  ['c a cafe', 'c_cafe'],
  ['cac', 'c_cafe'],
  ['c.c.', 'c_cafe'],
  ['c.c', 'c_cafe'],
  ['cc', 'c_cafe'],
  ['litres', 'L'],
  ['litre', 'L'],
  ['ml', 'ml'],
  ['cl', 'cl'],
  ['dl', 'dl'],
  ['l', 'L'],
  ['kilogrammes', 'kg'],
  ['kilogramme', 'kg'],
  ['kilos', 'kg'],
  ['kilo', 'kg'],
  ['kg', 'kg'],
  ['grammes', 'g'],
  ['gramme', 'g'],
  ['gr', 'g'],
  ['g', 'g'],
  ['mg', 'mg'],
  ['tasses', 'tasse'],
  ['tasse', 'tasse'],
  ['pincees', 'pincee'],
  ['pincee', 'pincee'],
]
const ALIAS_UNITES: ReadonlyArray<readonly [string, string]> = ALIAS_BRUTS.sort((a, b) => b[0].length - a[0].length)

/**
 * Contenants, retires du nom : "1 sachet de levure" se cherche "levure". Pas
 * de conversion connue : l'unite reste celle d'une piece, ou la contenance
 * entre parentheses quand la ligne la donne.
 *
 * "gousse" n'y est PAS : "gousse d'ail" est le nom d'un ingredient dans les
 * fiches de cuisine. "bouquet" non plus, sinon "1 bouquet garni" se
 * chercherait "garni".
 */
const CONTENANTS = [
  'piece(s)', 'pieces', 'piece',
  'paquet(s)', 'paquets', 'paquet',
  'sachet(s)', 'sachets', 'sachet',
  'boite(s)', 'boites', 'boite',
  'pot(s)', 'pots', 'pot',
  'brique(s)', 'briques', 'brique',
  'tranche(s)', 'tranches', 'tranche',
  'branche(s)', 'branches',
  'feuille(s)', 'feuilles',
  'bouquets', 'bouquet(s)',
].sort((a, b) => b.length - a.length)

/** Articles en tete du nom, chacun termine par une frontiere. */
const ARTICLES = ["de l'", "de l’", 'de la ', 'des ', 'du ', 'de ', "d'", 'd’', 'a ']

const FRACTIONS: Readonly<Record<string, string>> = {
  '½': '1/2', '¼': '1/4', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅛': '1/8',
}

/** Un nombre ecrit a la francaise : "200", "1,5", "0.5", "1/2", "1 1/2". */
function lireNombre(token: string): number | null {
  const t = token.trim().replace(/\s+/g, ' ')
  if (t === '') return null
  const mixte = /^(\d+) (\d+)\/(\d+)$/.exec(t)
  if (mixte) {
    const den = Number(mixte[3])
    return den === 0 ? null : Number(mixte[1]) + Number(mixte[2]) / den
  }
  const fraction = /^(\d+(?:[.,]\d+)?)\/(\d+(?:[.,]\d+)?)$/.exec(t.replace(/\s/g, ''))
  if (fraction) {
    const den = Number(fraction[2]?.replace(',', '.'))
    return den === 0 ? null : Number(fraction[1]?.replace(',', '.')) / den
  }
  const n = Number(t.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * Le nombre en tete de ligne. L'ORDRE des alternatives compte : sur "1/2",
 * un `\d+` glouton prendrait "1" et ne tenterait jamais la fraction.
 * Une fourchette "2 a 3" ou "2-3" rend sa moyenne : ni le bas ni le haut ne
 * sont plus vrais l'un que l'autre, et la personne corrige a la revue.
 */
const NOMBRE =
  /^\s*(?<a>\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?)(?:\s*(?:-|\u2013|à|a|ou)\s*(?<b>\d+(?:[.,]\d+)?)(?=\s|$|[a-zA-Z]))?\s*/

function retirerArticle(nom: string): string {
  const net = nom.trim()
  const plie = plier(net)
  for (const article of ARTICLES) {
    if (plie.startsWith(article)) return net.slice(article.length).trim()
  }
  return net
}

/** Le prefixe `alias` est-il suivi d'une frontiere (ni lettre ni chiffre) ? */
function commencePar(plie: string, alias: string): boolean {
  if (!plie.startsWith(alias)) return false
  const apres = plie.charAt(alias.length)
  return apres === '' || !/[\p{L}\p{N}]/u.test(apres)
}

/** "(400 g)", "(environ 150 g)" : une contenance entre parentheses. */
const CONTENANCE = /\(\s*(?:environ|env\.?|~)?\s*(\d+(?:[.,]\d+)?)\s*(kg|g|gr|ml|cl|l)\s*\)/i

export function parseIngredientLine(texte: string): ParsedIngredientLine {
  // Les marques de pluriel des sites ("Escalope(s)", "gousse(s)") coupaient le
  // nom a la parenthese, et l'on cherchait "escalope" au lieu de "escalope de
  // dinde".
  let s = (texte ?? '')
    .replace(/\((?:e?s|x|e)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s === '') return { quantity: null, unit: null, name: '', portion: null }
  for (const [signe, ecrit] of Object.entries(FRACTIONS)) {
    // "1½" devient "1 1/2", "½" seul devient "1/2".
    s = s.replace(new RegExp(`(\\d)${signe}`, 'g'), `$1 ${ecrit}`).replace(new RegExp(signe, 'g'), ecrit)
  }

  const m = NOMBRE.exec(s)
  if (!m || m.groups === undefined) return { quantity: null, unit: null, name: s, portion: null }
  const a = lireNombre(m.groups['a'] ?? '')
  if (a === null) return { quantity: null, unit: null, name: s, portion: null }
  const b = m.groups['b'] === undefined ? null : lireNombre(m.groups['b'])
  const quantite = b === null ? a : (a + b) / 2
  let reste = s.slice(m[0].length).trim()

  // 1. Une unite connue.
  const plie = plier(reste)
  for (const [alias, code] of ALIAS_UNITES) {
    if (commencePar(plie, alias)) {
      const nom = retirerArticle(reste.slice(alias.length).replace(/^\.\s*/, ''))
      return { quantity: quantite, unit: code, name: nom === '' ? s : nom, portion: null }
    }
  }

  // 2. Un contenant : on le retire du nom, et l'on prend la contenance entre
  //    parentheses si la ligne la donne ("1 boite (400 g) de tomates").
  let portion: string | null = null
  for (const contenant of CONTENANTS) {
    if (commencePar(plie, contenant)) {
      reste = retirerArticle(reste.slice(contenant.length))
      portion = contenant.replace('(s)', '').replace(/s$/, '')
      break
    }
  }
  // Les mots de portion qui restent dans le nom ("gousse d'ail") se lisent aussi.
  if (portion === null) {
    const premier = singulierPortion(plier(reste).split(/[^a-z]+/)[0] ?? '')
    if (premier in PORTIONS_G) portion = premier
  }

  const contenance = CONTENANCE.exec(reste)
  if (contenance) {
    const valeur = lireNombre(contenance[1] ?? '')
    const unite = (contenance[2] ?? '').toLowerCase()
    const code = unite === 'gr' ? 'g' : unite === 'l' ? 'L' : unite
    const nom = retirerArticle(reste.replace(contenance[0], ' ').replace(/\s+/g, ' ').trim())
    if (valeur !== null && nom !== '') {
      return { quantity: quantite * valeur, unit: code, name: nom, portion }
    }
  }

  // 3. Rien : un nombre de pieces ("1 oignon", "3 carottes").
  const nom = retirerArticle(reste)
  return { quantity: quantite, unit: null, name: nom === '' ? s : nom, portion }
}

// ---------------------------------------------------------------------------
// Des grammes, une fois l'ingredient choisi
// ---------------------------------------------------------------------------

/**
 * Poids suppose d'une piece quand rien ne le dit. Ecrire 1 g pour "1 oignon"
 * serait faux d'un facteur cent ; cent grammes est l'ordre de grandeur d'un
 * legume ou d'un fruit moyen, et la ligne est marquee "a verifier".
 */
export const PIECE_SUPPOSEE_G = 100

/**
 * Ordres de grandeur des mots de portion, en grammes. Sans eux, "15 feuilles
 * de persil" pesait 1,5 kg et "2 gousses d'ail" 200 g. Ce sont des
 * estimations : la ligne reste marquee "a verifier".
 */
export const PORTIONS_G: Readonly<Record<string, number>> = {
  gousse: 5,
  feuille: 0.5,
  brin: 1,
  pointe: 0.5,
  filet: 5,
  trait: 5,
  goutte: 0.05,
  noisette: 5,
  poignee: 30,
  tranche: 30,
  cube: 10,
  sachet: 10,
  pot: 125,
  brique: 200,
  boite: 400,
}

/**
 * Les mots de portion qui designent l'EMBALLAGE du produit lui-meme : "1 sachet
 * de salade", "1 pot de creme". Quand la fiche choisie connait sa contenance,
 * ce qu'a tout produit du commerce, elle vaut mieux que l'ordre de grandeur de
 * `PORTIONS_G` : un sachet de salade de 200 g n'est pas un sachet de levure.
 */
const EMBALLAGES = new Set(['sachet', 'pot', 'brique', 'boite', 'paquet', 'barquette', 'bouteille'])

/** "gousses" et "gousse" : le meme mot de portion. */
const singulierPortion = (mot: string): string => (mot.length > 3 && mot.endsWith('s') ? mot.slice(0, -1) : mot)

/** Ce qui se dose a la pincee quand la ligne ne dit pas combien ("Sel, poivre"). */
const ASSAISONNEMENTS = new Set([
  'sel', 'poivre', 'muscade', 'cannelle', 'paprika', 'piment', 'cumin', 'curry', 'curcuma', 'thym',
  'laurier', 'origan', 'persil', 'ciboulette', 'coriandre', 'aneth', 'estragon', 'romarin', 'sauge',
  'epice', 'herbe', 'cayenne', 'safran', 'clou', 'quatre',
])

/**
 * Rayons ou "3" veut dire trois pieces : des tomates, des escalopes, des
 * saucisses. Ce sont les rayons de Prandia (`category_l1`), pas les familles
 * CIQUAL. Ailleurs, rayon inconnu compris (le beurre et le sucre du catalogue
 * n'en ont pas), un nombre nu de dix ou plus est presque toujours des grammes
 * dont le site a oublie l'unite : "20 Beurre". Les oeufs se comptent quel que
 * soit leur rayon.
 */
const COMPTABLES = /fruit|legume|boucherie|viande|poisson|charcuterie/

/** Au-dela, un nombre sans unite est des grammes quel que soit l'aliment. */
const GRAMMES_SANS_UNITE = 50

export interface ImportAmount {
  readonly grams: number
  /** L'unite enregistree a cote, pour relire la ligne comme elle a ete ecrite. */
  readonly unit: string
  /** Vrai quand le poids est suppose, pas lu : l'ecran le signale. */
  readonly estimated: boolean
}

/**
 * La masse d'une ligne lue, pour l'ingredient retenu, du plus sur au plus
 * suppose :
 *   1. une unite lue ("200 g", "2 c. a soupe"), convertie par `units.ts` ;
 *   2. un mot de portion ("2 gousses"), par `PORTIONS_G` ;
 *   3. un nombre de pieces, au poids d'une piece de l'ingredient ;
 *   4. un assaisonnement, en pincees ;
 *   5. un nombre nu de dix ou plus pour un aliment qu'on ne compte pas, ou de
 *      cinquante ou plus pour n'importe lequel, en grammes ;
 *   6. a defaut, `PIECE_SUPPOSEE_G` la piece.
 * Sans quantite du tout : une pincee pour un assaisonnement, une piece sinon.
 * Tout ce qui n'est pas lu est marque `estimated`.
 */
export function importAmount(
  line: {
    readonly quantity: number | null
    readonly unit: string | null
    readonly name?: string | undefined
    readonly portion?: string | null | undefined
  },
  ingredient: { readonly pieceWeightG: number | null; readonly categoryL1?: string | null | undefined },
): ImportAmount {
  const piece = ingredient.pieceWeightG !== null && ingredient.pieceWeightG > 0 ? ingredient.pieceWeightG : null
  const tete = searchTerms(line.name ?? '')[0]
  const assaisonnement = tete !== undefined && ASSAISONNEMENTS.has(tete)
  const poidsPortion = line.portion ? PORTIONS_G[line.portion] : undefined
  const comptable = COMPTABLES.test(normalizeName(ingredient.categoryL1 ?? '')) || tete === 'oeuf'
  const q = line.quantity

  if (q === null || q <= 0) {
    if (assaisonnement) return { grams: toGrams(1, 'pincee'), unit: 'pincee', estimated: true }
    if (piece !== null) return { grams: piece, unit: PIECE_UNIT_CODE, estimated: true }
    return { grams: PIECE_SUPPOSEE_G, unit: 'g', estimated: true }
  }
  if (line.unit !== null) return { grams: toGrams(q, line.unit), unit: line.unit, estimated: false }
  if (line.portion && EMBALLAGES.has(line.portion) && piece !== null) {
    return { grams: q * piece, unit: PIECE_UNIT_CODE, estimated: true }
  }
  if (poidsPortion !== undefined) return { grams: q * poidsPortion, unit: 'g', estimated: true }
  if (piece !== null) return { grams: q * piece, unit: PIECE_UNIT_CODE, estimated: false }
  if (assaisonnement) return { grams: toGrams(q, 'pincee'), unit: 'pincee', estimated: true }
  if (q >= GRAMMES_SANS_UNITE || (q >= 10 && !comptable)) return { grams: q, unit: 'g', estimated: true }
  return { grams: q * PIECE_SUPPOSEE_G, unit: 'g', estimated: true }
}

// ---------------------------------------------------------------------------
// Le bloc "Recipe" de la page
// ---------------------------------------------------------------------------

export interface ImportedRecipe {
  readonly name: string
  /** Les lignes telles qu'ecrites sur le site, une par ingredient. */
  readonly ingredients: readonly string[]
  /** Une etape par ligne ; un intertitre de section finit par " :". */
  readonly steps: readonly string[]
  readonly portions: number
  readonly prepTimeMin: number | null
  /** Telle qu'ecrite : peut etre relative, l'appelant la resout. */
  readonly imageUrl: string | null
}

/**
 * L'image de partage de la page (`og:image`), ou `null`.
 *
 * Le bloc recette donne parfois une simple vignette (290 pixels chez certains
 * sites), alors que l'image de partage, celle des apercus de lien, est presque
 * toujours grande. L'ecran essaie l'une puis l'autre.
 */
export function extractOgImage(html: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const balise = m[0]
    if (!/\b(?:property|name)\s*=\s*["']og:image(?::url|:secure_url)?["']/i.test(balise)) continue
    const contenu = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(balise)?.[1]
    if (contenu) return texteBrut(contenu)
  }
  return null
}

/** Les contenus des balises `<script type="application/ld+json">`. */
export function extractJsonLdBlocks(html: string): string[] {
  const blocs: string[] = []
  const motif = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(motif)) {
    const contenu = (m[1] ?? '').trim()
    if (contenu !== '') blocs.push(contenu)
  }
  return blocs
}

const ENTITES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è',
  ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', icirc: 'î',
  iuml: 'ï', euml: 'ë', oelig: 'œ', rsquo: '’', lsquo: '‘', hellip: '…', deg: '°',
}

/**
 * Du texte propre : les sites WordPress laissent des entites ("l&#039;huile")
 * et parfois des balises dans leurs chaines.
 */
export function texteBrut(valeur: string): string {
  return valeur
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (tout, nom: string) => ENTITES[nom.toLowerCase()] ?? tout)
    .replace(/\s+/g, ' ')
    .trim()
}

function enTexte(valeur: unknown): string {
  if (valeur === null || valeur === undefined) return ''
  if (Array.isArray(valeur)) return valeur.length > 0 ? enTexte(valeur[0]) : ''
  if (typeof valeur === 'object') {
    const o = valeur as Record<string, unknown>
    return enTexte(o['@value'] ?? o['text'] ?? o['name'] ?? '')
  }
  return texteBrut(String(valeur))
}

const estRecette = (noeud: unknown): noeud is Record<string, unknown> => {
  if (noeud === null || typeof noeud !== 'object' || Array.isArray(noeud)) return false
  const type = (noeud as Record<string, unknown>)['@type']
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))
}

function trouverRecette(charge: unknown): Record<string, unknown> | null {
  if (Array.isArray(charge)) {
    for (const element of charge) {
      const trouvee = trouverRecette(element)
      if (trouvee) return trouvee
    }
    return null
  }
  if (charge !== null && typeof charge === 'object') {
    if (estRecette(charge)) return charge
    const graphe = (charge as Record<string, unknown>)['@graph']
    if (graphe !== undefined) return trouverRecette(graphe)
  }
  return null
}

/** "PT1H30M", "P0DT0H20M" en minutes ; `null` si illisible ou nul. */
export function dureeEnMinutes(iso: unknown): number | null {
  if (typeof iso !== 'string') return null
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(iso.trim())
  if (!m) return null
  const total = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
  return total > 0 ? total : null
}

/** "4", "4 personnes", ["4", "4 parts"], 4 : en portions, entre 1 et 50. */
function portionsDe(valeur: unknown): number {
  const texte = typeof valeur === 'number' ? String(valeur) : enTexte(valeur)
  const m = /\d+/.exec(texte)
  const n = m ? Number(m[0]) : 1
  return Math.min(50, Math.max(1, Number.isFinite(n) ? n : 1))
}

/**
 * Une phrase qui renvoie a la mise en page du SITE : "les quantites indiquees
 * a gauche". Dans Prandia il n'y a rien a gauche, la phrase est retiree.
 * HelloFresh en ouvre chacune de ses recettes.
 */
const RENVOI_A_LA_PAGE = /indiqu\p{L}*\s+(?:[aà]\s+)?(?:gauche|droite|ci-contre|ci-dessus|ci-dessous)\b/iu

/** Une puce sans ponctuation finale en recoit une : sinon deux gestes se colleraient. */
const PONCTUATION_FINALE = /[.!?:;…]["')\]]*$/

/** Les frontieres de puce, de paragraphe et de ligne d'une etape en HTML. */
const BLOC_HTML = /<\/?(?:li|p|div|ul|ol)\b[^>]*>|<br\s*\/?>/i

/**
 * Le texte d'une etape, SES PUCES GARDEES COMME DES PHRASES.
 *
 * Certains sites (HelloFresh) publient chaque etape en liste HTML, un geste
 * par puce. `texteBrut` aplatissait le tout en un bloc de six phrases. Chaque
 * puce, paragraphe ou `<br>` devient ici une phrase qui commence par
 * une capitale et finit par un point, et la lecture (`stepParts`, dans
 * steps.ts) en refait une ligne par geste. La base ne stocke toujours que du
 * texte, et une etape tapee a la main se lit de la meme facon.
 */
function texteEtape(html: string): string {
  const morceaux = BLOC_HTML.test(html) ? html.split(BLOC_HTML) : [html]
  const phrases = morceaux
    .map(texteBrut)
    .filter((m) => m !== '')
    .map((m) => {
      const capitale = m.charAt(0).toLocaleUpperCase('fr') + m.slice(1)
      return PONCTUATION_FINALE.test(capitale) ? capitale : `${capitale}.`
    })
  return splitSentences(phrases.join(' '))
    .filter((p) => !RENVOI_A_LA_PAGE.test(p))
    .join(' ')
}

function etapesDe(valeur: unknown): string[] {
  if (valeur === null || valeur === undefined) return []
  if (typeof valeur === 'string') {
    return valeur
      .split(/\r?\n|<br\s*\/?>/i)
      .map(texteBrut)
      .filter((l) => l !== '')
  }
  if (Array.isArray(valeur)) return valeur.flatMap(etapesDe)
  if (typeof valeur === 'object') {
    const o = valeur as Record<string, unknown>
    if (o['@type'] === 'HowToSection') {
      // Le nom de la section devient un intertitre, que `steps.ts` reconnait a
      // son deux-points final et ne numerote pas.
      const titre = enTexte(o['name'])
      const sous = etapesDe(o['itemListElement'])
      return titre === '' ? sous : [`${titre.replace(/\s*:\s*$/, '')} :`, ...sous]
    }
    const brut = o['text'] ?? o['name']
    const texte = typeof brut === 'string' ? texteEtape(brut) : enTexte(brut)
    return texte === '' ? [] : [texte]
  }
  return []
}

function imageDe(valeur: unknown): string | null {
  if (typeof valeur === 'string') return valeur.trim() || null
  if (Array.isArray(valeur)) return valeur.length > 0 ? imageDe(valeur[0]) : null
  if (valeur !== null && typeof valeur === 'object') {
    const o = valeur as Record<string, unknown>
    return imageDe(o['url'] ?? o['contentUrl'] ?? o['@id'] ?? null)
  }
  return null
}

/**
 * La premiere recette trouvee dans les blocs JSON-LD, ou `null`.
 *
 * Tolerant par construction : un bloc illisible est saute, pas fatal (une page
 * en porte souvent plusieurs, fil d'Ariane, organisation, recette). Les
 * enveloppes `@graph` et les `@type` en liste sont acceptes.
 */
export function parseRecipeJsonLd(blocs: readonly string[]): ImportedRecipe | null {
  let noeud: Record<string, unknown> | null = null
  for (const bloc of blocs) {
    let charge: unknown
    try {
      charge = JSON.parse(bloc)
    } catch {
      continue
    }
    noeud = trouverRecette(charge)
    if (noeud) break
  }
  if (noeud === null) return null

  const brutes = noeud['recipeIngredient'] ?? noeud['ingredients'] ?? []
  const ingredients = (Array.isArray(brutes) ? brutes : [brutes]).map(enTexte).filter((l) => l !== '')
  const total = dureeEnMinutes(noeud['totalTime'])
  const prep = dureeEnMinutes(noeud['prepTime'])
  const cuisson = dureeEnMinutes(noeud['cookTime'])

  return {
    name: enTexte(noeud['name']) || 'Recette importée',
    ingredients,
    steps: etapesDe(noeud['recipeInstructions']),
    portions: portionsDe(noeud['recipeYield']),
    prepTimeMin: total ?? (prep !== null || cuisson !== null ? (prep ?? 0) + (cuisson ?? 0) : null),
    imageUrl: imageDe(noeud['image']),
  }
}

// ---------------------------------------------------------------------------
// Retrouver l'ingredient
// ---------------------------------------------------------------------------

/** Mots qui ne disent rien de l'ingredient. */
const MOTS_VIDES = new Set([
  'de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'en', 'et', 'ou', 'un', 'une',
  'pour', 'avec', 'sans', 'frais', 'fraiche', 'fraiches', 'gros', 'grosse', 'grosses', 'petit',
  'petite', 'petits', 'petites', 'moyen', 'moyenne', 'moyens', 'moyennes', 'bien', 'environ',
  'quelques', 'bio', 'beau', 'belle', 'beaux', 'belles', 'bon', 'bonne',
])

/**
 * Mots qui disent COMBIEN, pas QUOI : "2 gousses d'ail" se cherche "ail",
 * "1 pointe de colorant" se cherche "colorant". Retires de la recherche
 * seulement, jamais du nom affiche.
 */
const MOTS_PORTION = new Set([
  'gousse', 'tranche', 'feuille', 'branche', 'brin', 'botte', 'pointe', 'rasade', 'filet',
  'morceau', 'poignee', 'trait', 'goutte', 'verre', 'bol', 'louche', 'sachet', 'pot', 'boite',
  'brique', 'paquet', 'piece',
])

/** Un nom commercial n'est pas dans CIQUAL : on cherche ce qu'il designe. */
const SYNONYMES: Readonly<Record<string, readonly string[]>> = {
  maizena: ['amidon', 'mai'],
  fecule: ['fecule', 'pomme', 'terre'],
}

/**
 * Ce qu'une recette francaise entend par defaut quand elle ne precise pas :
 * "lait" est du demi-ecreme, "farine" de la farine de ble, "sucre" du sucre
 * blanc. Un petit bonus departage les fiches qui commencent toutes par le meme
 * mot ; la bibliotheque, elle, l'emporte toujours (voir le Worker).
 */
const PAR_DEFAUT: Readonly<Record<string, readonly string[]>> = {
  lait: ['demi'],
  farine: ['ble'],
  sucre: ['blanc', 'poudre'],
  beurre: ['doux'],
  sel: ['blanc'],
  eau: ['robinet'],
}

/** "tomates" et "tomate" sont le meme mot pour chercher. */
const singulier = (mot: string): string => (mot.length > 3 && /[sx]$/.test(mot) ? mot.slice(0, -1) : mot)

function motsDe(texte: string): string[] {
  return normalizeName(texte)
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length > 1 && !MOTS_VIDES.has(m))
    .map(singulier)
}

/**
 * Les mots a chercher pour une ligne : avant la premiere virgule ou
 * parenthese, ce qui suit etant presque toujours une preparation ("oignon,
 * emince", "beurre (mou)"). Sans les mots de portion, et un nom commercial
 * remplace par ce qu'il designe.
 */
export function searchTerms(nom: string): string[] {
  const tete = nom.split(/[,(;]| ou /)[0] ?? nom
  const mots = motsDe(tete).filter((m) => !MOTS_PORTION.has(m))
  return mots.flatMap((m) => SYNONYMES[m] ?? [m])
}

/**
 * Deux mots sont-ils le meme ? Egaux, ou au feminin pres ("cru", "crue").
 * PAS de prefixe libre : "lait" rapprochait "laitue", et "mort" "mortadelle".
 */
const memeMot = (a: string, b: string): boolean => a === b || a === `${b}e` || b === `${a}e`

/**
 * Proximite d'une fiche avec les mots d'une ligne, sans echelle absolue :
 * elle sert a CLASSER des candidats entre eux.
 *
 * - la part des mots de la ligne retrouves dans la fiche fait l'essentiel ;
 * - le premier mot, qui porte presque toujours l'aliment ("tomates cerises"),
 *   compte en plus quand la fiche commence par lui ;
 * - chaque mot de trop dans la fiche coute un peu, pour qu'une fiche courte
 *   l'emporte a egalite ;
 * - une fiche "crue" passe devant a egalite : une recette pese ses
 *   ingredients avant cuisson ;
 * - le sens par defaut d'un mot seul ("lait" : demi-ecreme) departage.
 */
export function matchScore(nomFiche: string, termes: readonly string[]): number {
  if (termes.length === 0) return 0
  const mots = motsDe(nomFiche)
  const correspond = (m: string) => termes.some((t) => memeMot(t, m))
  const trouves = termes.filter((t) => mots.some((m) => memeMot(t, m))).length
  let score = trouves / termes.length
  // Le premier mot de la fiche est-il un mot de la ligne ? CIQUAL ecrit
  // parfois l'aliment apres ("Dinde, escalope crue" pour "escalope de dinde").
  if (mots[0] !== undefined && correspond(mots[0])) score += 0.2

  const tete = termes[0]
  // Sous la meme forme que les mots de la fiche : "doux" y devient "dou".
  const attendus = (tete === undefined ? [] : (PAR_DEFAUT[tete] ?? [])).map(singulier)
  // Seulement pour une fiche de CET aliment : le "blanc" attendu du sel ne doit
  // pas profiter au "Poivre blanc" sur une ligne "sel, poivre".
  const memeAliment = tete !== undefined && mots[0] !== undefined && memeMot(tete, mots[0])
  const implicite = memeAliment && mots.some((m) => attendus.includes(m))
  const cru = mots.some((m) => m === 'cru' || m === 'crue')
  // Seuls coutent les mots qui ne correspondent a rien et disent autre chose :
  // "Beurre a 80% MG, sale" contre "Beurre a 80% MG minimum, doux", c'est
  // "sale" qui departage, pas "80", "mg" ni "minimum".
  const enTrop = mots.filter(
    (m) => !correspond(m) && m !== 'cru' && m !== 'crue' && !attendus.includes(m) && !QUALIFICATIFS.has(m) && !/^\d+$/.test(m),
  ).length
  score -= enTrop * 0.04
  if (cru) score += 0.05
  if (implicite) score += 0.15
  return score
}

/** Mots techniques des fiches CIQUAL, qui ne disent pas ce qu'est l'aliment. */
const QUALIFICATIFS = new Set([
  'mg', 'minimum', 'non', 'iode', 'fluore', 'alimentaire', 'uht', 'pasteurise', 'pasteurisee',
  'preemballe', 'preemballee', 'appertise', 'appertisee', 'rayon', 'aliment', 'moyen', 'standard',
])

/** En dessous, la ligne arrive "a choisir" : mieux vaut demander que se tromper. */
export const SEUIL_RETENU = 0.7
/** Au-dessus, la correspondance est sure ; entre les deux, "a verifier". */
export const SEUIL_SUR = 0.9
/**
 * Ecart minimal avec le second candidat pour dire "sur". "Huile" va aussi
 * bien a l'huile d'olive qu'a l'huile de colza : deux candidats a egalite ne
 * sont pas une certitude, quelle que soit leur note.
 */
export const ECART_SUR = 0.05

/**
 * La requete plein texte d'une ligne : n'importe lequel de ses mots, en
 * prefixe. Le classement fait le tri ensuite ; exiger TOUS les mots ne
 * trouvait rien pour "eau de fleur d'oranger".
 */
export function importFtsQuery(termes: readonly string[]): string | null {
  const propres = termes.map((t) => t.replace(/[^a-z0-9]/g, '')).filter((t) => t.length > 1)
  return propres.length === 0 ? null : propres.map((t) => `"${t}"*`).join(' OR ')
}
