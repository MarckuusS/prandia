/**
 * Regles de presentation de la bibliotheque : tri, groupement, filtres, et la
 * traduction du formulaire vers les charges utiles de l'API.
 *
 * Tout le tri / groupement / filtrage se fait ICI, cote client, sur les 500
 * lignes que rend `GET /api/ingredients` — exactement comme le desktop triait
 * en Python apres son SELECT. L'alternative etait de porter les 18 tris, les
 * 5 groupements et les 6 filtres dans la query string du Worker : une
 * douzaine de parametres a maintenir des deux cotes, et un aller-retour reseau
 * a chaque changement de tri, pour une bibliotheque qui tient deja entierement
 * en memoire. Rejetee.
 *
 * Le module est pur : pas de React, pas de fetch. C'est ce qui permet de le
 * lire comme une specification.
 */

import {
  SOURCE_LABELS,
  SOURCES,
  formatCriteria,
  isInSeasonNow,
  normalizeName,
  parseCriteria,
  seasonMonths as parseSeasonMonths,
  type Completion,
  type Ingredient,
  type Source,
  type Criterion as SharedCriterion,
} from '@prandia/shared'

import type { IconName } from '../../icons/index.js'

// ---------------------------------------------------------------------------
// Tri
// ---------------------------------------------------------------------------

/**
 * 9 criteres x 2 sens = les 18 tris du desktop.
 *
 * Le desktop les presentait comme 18 entrees d'un seul menu deroulant. Au
 * pouce, une liste de 18 lignes se rate : critere et sens sont separes, ce qui
 * ramene le choix courant a deux taps sur des cibles pleine largeur.
 */
export const SORT_FIELDS = [
  { code: 'name', label: 'Nom' },
  { code: 'kcal', label: 'Énergie' },
  { code: 'proteins', label: 'Protéines' },
  { code: 'carbs', label: 'Glucides' },
  { code: 'fats', label: 'Lipides' },
  { code: 'fiber', label: 'Fibres' },
  { code: 'salt', label: 'Sel' },
  { code: 'price', label: 'Prix' },
  { code: 'created', label: 'Ajout' },
] as const

export type SortField = (typeof SORT_FIELDS)[number]['code']

const SORT_CODES: ReadonlySet<string> = new Set(SORT_FIELDS.map((field) => field.code))

/** Libelle du sens, dependant du critere : « A → Z » n'a de sens que pour un nom. */
export function directionLabel(field: SortField, desc: boolean): string {
  if (field === 'name') return desc ? 'Z → A' : 'A → Z'
  if (field === 'created') return desc ? 'Plus récents' : 'Plus anciens'
  return desc ? 'Décroissant' : 'Croissant'
}

/** Valeur numerique triable, `null` quand la donnee est inconnue. */
function numericKey(ingredient: Ingredient, field: SortField): number | null {
  switch (field) {
    case 'kcal':
      return ingredient.kcal
    case 'proteins':
      return ingredient.proteins
    case 'carbs':
      return ingredient.carbs
    case 'fats':
      return ingredient.fats
    case 'fiber':
      return ingredient.fiber
    case 'salt':
      return ingredient.salt
    case 'price':
      return ingredient.priceEur === null ? null : Number(ingredient.priceEur)
    default:
      return null
  }
}

/**
 * Tri stable, valeurs inconnues toujours en DERNIER.
 *
 * Reprend la cle `(1, 0)` contre `(0, valeur)` du viewmodel Python : une macro
 * absente ne doit pas remonter en tete d'un tri decroissant, sans quoi
 * « trier par protéines » commence par tout ce dont on ignore les proteines.
 */
export function sortIngredients(
  items: readonly Ingredient[],
  field: SortField,
  desc: boolean,
): Ingredient[] {
  const sign = desc ? -1 : 1
  const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true })

  return [...items].sort((a, b) => {
    if (field === 'name') return sign * collator.compare(a.name, b.name)

    if (field === 'created') {
      // Les horodatages sont en ISO-8601 UTC : l'ordre lexicographique EST
      // l'ordre chronologique, pas besoin de construire deux Date.
      const left = a.createdAt ?? ''
      const right = b.createdAt ?? ''
      if (left === right) return collator.compare(a.name, b.name)
      return sign * (left < right ? -1 : 1)
    }

    const left = numericKey(a, field)
    const right = numericKey(b, field)
    if (left === null && right === null) return collator.compare(a.name, b.name)
    if (left === null) return 1
    if (right === null) return -1
    if (left === right) return collator.compare(a.name, b.name)
    return sign * (left < right ? -1 : 1)
  })
}

// ---------------------------------------------------------------------------
// Groupement
// ---------------------------------------------------------------------------

export const GROUP_MODES = [
  { code: 'none', label: 'Aucun' },
  { code: 'source', label: 'Source' },
  { code: 'rayon', label: 'Rayon' },
  { code: 'season', label: 'Saisonnalité' },
  { code: 'kcal', label: 'Tranche kcal' },
] as const

export type GroupMode = (typeof GROUP_MODES)[number]['code']

const GROUP_CODES: ReadonlySet<string> = new Set(GROUP_MODES.map((mode) => mode.code))

function kcalBucket(kcal: number | null): string {
  if (kcal === null) return 'Sans valeur kcal'
  if (kcal < 100) return '0 – 100 kcal/100 g'
  if (kcal < 300) return '100 – 300 kcal/100 g'
  if (kcal < 500) return '300 – 500 kcal/100 g'
  return '500+ kcal/100 g'
}

function groupKey(ingredient: Ingredient, mode: GroupMode, now: Date): string {
  switch (mode) {
    case 'source':
      return SOURCE_LABELS[ingredient.source]
    case 'rayon':
      return ingredient.categoryL1 ?? 'Sans rayon'
    case 'season':
      if (isInSeasonNow(ingredient, now)) return 'De saison'
      return parseSeasonMonths(ingredient).length > 0 ? 'Hors saison' : 'Saisonnalité inconnue'
    case 'kcal':
      return kcalBucket(ingredient.kcal)
    default:
      return ''
  }
}

export interface IngredientSection {
  readonly key: string
  readonly items: readonly Ingredient[]
}

/** Ouvre ou referme une section, sans muter la liste d'origine. */
export const toggleSection = (open: readonly string[], key: string): string[] =>
  open.includes(key) ? open.filter((k) => k !== key) : [...open, key]

/**
 * Decoupe la liste DEJA triee en sections.
 *
 * Le regroupement ne retrie pas : il parcourt et rassemble, ce qui preserve
 * l'ordre choisi par l'utilisateur A L'INTERIEUR de chaque section. Un meme
 * groupe peut donc apparaitre plusieurs fois si le tri l'eclate — le desktop
 * ajoutait un tri secondaire par cle de groupe pour l'eviter ; on fait pareil,
 * mais en amont, dans `groupIngredients` lui-meme.
 */
export function groupIngredients(
  items: readonly Ingredient[],
  mode: GroupMode,
  now: Date = new Date(),
): IngredientSection[] {
  if (mode === 'none') return [{ key: '', items }]

  const buckets = new Map<string, Ingredient[]>()
  for (const item of items) {
    const key = groupKey(item, mode, now)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }

  return [...buckets.entries()]
    .map(([key, sectionItems]) => ({ key, items: sectionItems }))
    .sort((a, b) => a.key.localeCompare(b.key, 'fr'))
}

// ---------------------------------------------------------------------------
// Filtres
// ---------------------------------------------------------------------------

/**
 * Etat d'une bascule. Trois positions, et non deux.
 *
 * Le desktop n'avait que « coche / non coche », donc pas de filtre inverse :
 * impossible de demander « ce qui n'a PAS de prix », qui est pourtant la
 * question qu'on se pose quand on complete sa bibliotheque. Le troisieme etat
 * ne coute rien a l'ecran — la meme pastille, une couleur de plus.
 */
export type ToggleState = 'indifferent' | 'avec' | 'sans'

/**
 * Champs sur lesquels une borne chiffree a un sens.
 *
 * `priceKg` n'est pas un champ de la table : il se calcule du prix et de la
 * quantite qu'il couvre. Comparer des prix bruts n'aurait aucun sens, un
 * ingredient etant tarife au kilo et l'autre a la piece.
 */
export const CRITERION_FIELDS = [
  { code: 'kcal', label: 'Énergie', unit: 'kcal/100 g' },
  { code: 'proteins', label: 'Protéines', unit: 'g/100 g' },
  { code: 'carbs', label: 'Glucides', unit: 'g/100 g' },
  { code: 'sugars', label: 'dont sucres', unit: 'g/100 g' },
  { code: 'fats', label: 'Lipides', unit: 'g/100 g' },
  { code: 'saturatedFats', label: 'dont saturés', unit: 'g/100 g' },
  { code: 'fiber', label: 'Fibres', unit: 'g/100 g' },
  { code: 'salt', label: 'Sel', unit: 'g/100 g' },
  { code: 'priceKg', label: 'Prix', unit: '€/kg' },
  { code: 'pieceWeightG', label: 'Poids unitaire', unit: 'g' },
] as const

export type CriterionField = (typeof CRITERION_FIELDS)[number]['code']

/**
 * Ce que le CATALOGUE sait filtrer : les huit nutriments, rien de plus.
 *
 * Le prix au kilo et le poids unitaire appartiennent a la bibliotheque
 * personnelle — un catalogue de reference ne les porte pas, et les proposer
 * rendrait toute recherche vide.
 */
export const CATALOG_CRITERION_FIELDS = CRITERION_FIELDS.filter(
  (f) => f.code !== 'priceKg' && f.code !== 'pieceWeightG',
)

const CRITERION_CODES: ReadonlySet<string> = new Set(CRITERION_FIELDS.map((f) => f.code))

/** Une borne, lue « Protéines ≥ 20 » ou « Sel ≤ 1 » a l'ecran. */
export interface Criterion extends SharedCriterion {
  readonly field: CriterionField
}

/**
 * La valeur d'un champ pour un ingredient, ou `null` si elle est inconnue.
 *
 * La distinction compte : `null` n'est pas zero. Un ingredient dont les macros
 * ne sont pas renseignees ne satisfait AUCUNE borne, ni « ≥ », ni « ≤ » —
 * sans quoi « moins de 1 g de sel » ramenerait toute la bibliotheque
 * incomplete, et l'utilisateur croirait avoir trouve des aliments pauvres en
 * sel alors qu'il aurait trouve des fiches vides.
 */
export function criterionValue(item: Ingredient, field: CriterionField): number | null {
  if (field === 'priceKg') {
    const eur = item.priceEur === null ? null : Number(item.priceEur)
    const grams = item.priceQuantityG
    if (eur === null || !Number.isFinite(eur) || grams === null || grams <= 0) return null
    return (eur / grams) * 1000
  }
  if (field === 'pieceWeightG') return item.pieceWeightG ?? null
  return item[field] ?? null
}

export interface LibraryFilters {
  readonly sources: readonly Source[]
  readonly rayons: readonly string[]
  readonly inSeason: ToggleState
  readonly withBrand: ToggleState
  readonly withPieceWeight: ToggleState
  readonly withPrice: ToggleState
  /** Sous-chaine cherchee dans la marque, accents et casse ignores. */
  readonly brand: string
  /** Bornes chiffrees, cumulables. Toutes doivent etre satisfaites. */
  readonly criteria: readonly Criterion[]
}

export const NO_FILTERS: LibraryFilters = {
  sources: [],
  rayons: [],
  inSeason: 'indifferent',
  withBrand: 'indifferent',
  withPieceWeight: 'indifferent',
  withPrice: 'indifferent',
  brand: '',
  criteria: [],
}

/**
 * Les bascules, dans l'ordre d'affichage.
 *
 * L'icone est nommee ici plutot que dessinee dans l'ecran : la liste est une
 * donnee, et un composant React dans une constante de modele rendrait ce
 * fichier intestable hors du navigateur.
 */
export const QUICK_TOGGLES = [
  { code: 'inSeason', icon: 'ui-leaf', label: 'Saison', avec: 'De saison', sans: 'Hors saison' },
  { code: 'withPrice', icon: 'ui-price', label: 'Prix', avec: 'Avec prix', sans: 'Sans prix' },
  { code: 'withPieceWeight', icon: 'ui-scale', label: 'Poids unitaire', avec: 'Avec poids unitaire', sans: 'Sans poids unitaire' },
  { code: 'withBrand', icon: 'ui-tag', label: 'Marque', avec: 'Avec marque', sans: 'Sans marque' },
] as const satisfies ReadonlyArray<{
  code: string
  icon: IconName
  /** Etat indifferent : le nom de la propriete, sans jugement. */
  label: string
  avec: string
  sans: string
}>

/** Le libelle a afficher, qui DIT l'etat plutot que de le suggerer par une couleur. */
export const toggleLabel = (
  toggle: (typeof QUICK_TOGGLES)[number],
  state: ToggleState,
): string => (state === 'avec' ? toggle.avec : state === 'sans' ? toggle.sans : toggle.label)

export type QuickToggle = (typeof QUICK_TOGGLES)[number]['code']

const NEXT_STATE: Record<ToggleState, ToggleState> = {
  indifferent: 'avec',
  avec: 'sans',
  sans: 'indifferent',
}

/**
 * Bascules et listes, exprimees en `switch` plutot qu'en cle calculee.
 *
 * `{ ...filters, [code]: suivant }` avec une cle d'union se degrade en
 * signature d'index sous `exactOptionalPropertyTypes` : le controle de type
 * disparait exactement la ou il servirait.
 */
export function toggleQuickFilter(filters: LibraryFilters, code: QuickToggle): LibraryFilters {
  switch (code) {
    case 'inSeason':
      return { ...filters, inSeason: NEXT_STATE[filters.inSeason] }
    case 'withPrice':
      return { ...filters, withPrice: NEXT_STATE[filters.withPrice] }
    case 'withPieceWeight':
      return { ...filters, withPieceWeight: NEXT_STATE[filters.withPieceWeight] }
    case 'withBrand':
      return { ...filters, withBrand: NEXT_STATE[filters.withBrand] }
  }
}

export function toggleSource(filters: LibraryFilters, source: Source): LibraryFilters {
  const sources = filters.sources.includes(source)
    ? filters.sources.filter((value) => value !== source)
    : [...filters.sources, source]
  return { ...filters, sources }
}

export function toggleRayon(filters: LibraryFilters, rayon: string): LibraryFilters {
  const rayons = filters.rayons.includes(rayon)
    ? filters.rayons.filter((value) => value !== rayon)
    : [...filters.rayons, rayon]
  return { ...filters, rayons }
}

export function addCriterion(filters: LibraryFilters, criterion: Criterion): LibraryFilters {
  return { ...filters, criteria: [...filters.criteria, criterion] }
}

export function removeCriterion(filters: LibraryFilters, index: number): LibraryFilters {
  return { ...filters, criteria: filters.criteria.filter((_, i) => i !== index) }
}

export function updateCriterion(
  filters: LibraryFilters,
  index: number,
  patch: Partial<Criterion>,
): LibraryFilters {
  return {
    ...filters,
    criteria: filters.criteria.map((c, i) => (i === index ? { ...c, ...patch } : c)),
  }
}

/** Une borne par ligne, plus une unite par liste et par texte libre. */
export function activeFilterCount(filters: LibraryFilters): number {
  let count = 0
  if (filters.sources.length > 0) count += 1
  if (filters.rayons.length > 0) count += 1
  if (filters.brand.trim() !== '') count += 1
  for (const toggle of QUICK_TOGGLES) if (filters[toggle.code] !== 'indifferent') count += 1
  return count + filters.criteria.length
}

/** Vrai si la propriete est portee — la question que posent les bascules. */
function has(item: Ingredient, code: QuickToggle, now: Date): boolean {
  switch (code) {
    case 'inSeason':
      return isInSeasonNow(item, now)
    case 'withPrice':
      return item.priceEur !== null
    case 'withPieceWeight':
      return Boolean(item.pieceWeightG)
    case 'withBrand':
      return (item.brand ?? '').trim() !== ''
  }
}

export function filterIngredients(
  items: readonly Ingredient[],
  filters: LibraryFilters,
  now: Date = new Date(),
): Ingredient[] {
  const sources = new Set<string>(filters.sources)
  const rayons = new Set<string>(filters.rayons)
  const brand = normalizeName(filters.brand)

  return items.filter((item) => {
    if (sources.size > 0 && !sources.has(item.source)) return false
    if (rayons.size > 0 && !rayons.has(item.categoryL1 ?? '')) return false

    for (const toggle of QUICK_TOGGLES) {
      const state = filters[toggle.code]
      if (state === 'indifferent') continue
      if (has(item, toggle.code, now) !== (state === 'avec')) return false
    }

    if (brand !== '' && !normalizeName(item.brand).includes(brand)) return false

    for (const c of filters.criteria) {
      const value = criterionValue(item, c.field)
      // Valeur inconnue : la borne n'est pas satisfaite. Voir `criterionValue`.
      if (value === null) return false
      if (c.bound === 'min' && value < c.value) return false
      if (c.bound === 'max' && value > c.value) return false
    }

    return true
  })
}

// ---------------------------------------------------------------------------
// Options de vue portees par l'URL
// ---------------------------------------------------------------------------

export interface ViewOptions {
  readonly query: string
  readonly sort: SortField
  readonly desc: boolean
  readonly group: GroupMode
  /**
   * Sections depliees, par cle de groupe.
   *
   * Vit dans l'URL comme le reste des options de vue, et pas dans un `useState`,
   * pour une raison tres concrete : ouvrir un rayon, toucher un ingredient puis
   * revenir en arriere refermerait tout si l'etat mourait avec l'ecran.
   */
  readonly open: readonly string[]
  readonly filters: LibraryFilters
}

export const DEFAULT_VIEW: ViewOptions = {
  query: '',
  sort: 'name',
  desc: false,
  // Regroupe par rayon d'entree de jeu : une bibliotheque de 80 lignes a plat
  // se parcourt mal, et le rayon est l'axe qui sert aussi en magasin.
  group: 'rayon',
  // Tout replie au depart. Ce qui compte a l'ouverture, c'est de voir la
  // STRUCTURE de sa bibliotheque, pas de faire defiler 80 lignes.
  open: [],
  filters: NO_FILTERS,
}

const isSource = (value: string): value is Source => (SOURCES as readonly string[]).includes(value)

const splitCsv = (value: string | null): string[] =>
  value === null ? [] : value.split(',').map((part) => part.trim()).filter((part) => part !== '')

/**
 * `decodeURIComponent` leve sur une sequence `%` malformee, ce qu'une URL
 * bricolee a la main produit facilement. Une option de vue illisible ne doit
 * jamais faire tomber l'ecran : on garde la valeur brute et on continue.
 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Relit les options depuis la query string.
 *
 * L'URL plutot que `localStorage` : c'est ce qui rend un filtre partageable,
 * survivable a un rafraichissement en magasin, et surtout ANNULABLE par le
 * bouton Retour du telephone. Le desktop persistait dans QSettings, ce qui
 * pouvait rouvrir l'application sur une bibliotheque filtree en apparence
 * vide, sans que rien ne l'explique.
 *
 * Toute valeur devenue invalide entre deux versions est ignoree en silence et
 * le defaut s'applique — comme QSettings le faisait.
 */
export function readViewOptions(params: URLSearchParams): ViewOptions {
  const [rawSort, rawDirection] = (params.get('tri') ?? '').split('.')
  const sort = rawSort !== undefined && SORT_CODES.has(rawSort) ? (rawSort as SortField) : DEFAULT_VIEW.sort
  const rawGroup = params.get('groupe')
  const group = rawGroup !== null && GROUP_CODES.has(rawGroup) ? (rawGroup as GroupMode) : DEFAULT_VIEW.group
  // « f=withPrice » veut dire « avec », « f=-withPrice » veut dire « sans ».
  // Les liens partages avant l'ajout du troisieme etat continuent donc de se
  // relire, et disent la meme chose qu'a l'epoque.
  const toggles = new Set(splitCsv(params.get('f')))
  const etat = (code: QuickToggle): ToggleState =>
    toggles.has(code) ? 'avec' : toggles.has(`-${code}`) ? 'sans' : 'indifferent'

  return {
    query: params.get('q') ?? '',
    sort,
    desc: rawDirection === 'desc',
    group,
    open: splitCsv(params.get('ouverts')).map(safeDecode),
    filters: {
      sources: splitCsv(params.get('sources')).filter(isSource),
      rayons: splitCsv(params.get('rayons')),
      inSeason: etat('inSeason'),
      withBrand: etat('withBrand'),
      withPieceWeight: etat('withPieceWeight'),
      withPrice: etat('withPrice'),
      brand: params.get('marque') ?? '',
      criteria: knownCriteria(params.get('bornes')),
    },
  }
}

/** N'ecrit QUE ce qui differe du defaut : l'URL reste lisible et partageable. */
export function viewOptionsToParams(view: ViewOptions): URLSearchParams {
  const params = new URLSearchParams()
  if (view.query !== '') params.set('q', view.query)
  if (view.sort !== DEFAULT_VIEW.sort || view.desc) {
    params.set('tri', `${view.sort}.${view.desc ? 'desc' : 'asc'}`)
  }
  if (view.group !== DEFAULT_VIEW.group) params.set('groupe', view.group)
  // Chaque cle est encodee AVANT d'etre jointe : les rayons viennent de
  // `category_l1`, saisi librement, et une virgule dans un nom couperait la
  // liste en deux a la relecture. Remplacer la virgule serait plus simple mais
  // la section ne se retrouverait plus a l'ouverture suivante.
  if (view.open.length > 0) {
    params.set('ouverts', view.open.map(encodeURIComponent).join(','))
  }
  if (view.filters.sources.length > 0) params.set('sources', view.filters.sources.join(','))
  if (view.filters.rayons.length > 0) params.set('rayons', view.filters.rayons.join(','))

  const toggles = QUICK_TOGGLES.filter((toggle) => view.filters[toggle.code] !== 'indifferent').map(
    (toggle) => (view.filters[toggle.code] === 'sans' ? `-${toggle.code}` : toggle.code),
  )
  if (toggles.length > 0) params.set('f', toggles.join(','))
  if (view.filters.brand.trim() !== '') params.set('marque', view.filters.brand.trim())
  if (view.filters.criteria.length > 0) {
    params.set('bornes', formatCriteria(view.filters.criteria))
  }

  return params
}

/**
 * Ne garde que les bornes dont le champ existe ICI.
 *
 * La lecture et l'ecriture du format vivent dans `shared/criteria` : le Worker
 * lit le meme texte pour filtrer le catalogue et OpenFoodFacts, et deux
 * analyseurs pour un seul format finissent toujours par diverger. Ce qui reste
 * propre a la bibliotheque, c'est la LISTE des champs — elle connait le prix
 * au kilo, que le catalogue ignore.
 */
const knownCriteria = (raw: string | null): Criterion[] =>
  parseCriteria(raw).filter((c): c is Criterion => CRITERION_CODES.has(c.field))

// ---------------------------------------------------------------------------
// Saisonnalite
// ---------------------------------------------------------------------------

export const MONTHS = [
  { number: 1, initial: 'J', name: 'janvier' },
  { number: 2, initial: 'F', name: 'février' },
  { number: 3, initial: 'M', name: 'mars' },
  { number: 4, initial: 'A', name: 'avril' },
  { number: 5, initial: 'M', name: 'mai' },
  { number: 6, initial: 'J', name: 'juin' },
  { number: 7, initial: 'J', name: 'juillet' },
  { number: 8, initial: 'A', name: 'août' },
  { number: 9, initial: 'S', name: 'septembre' },
  { number: 10, initial: 'O', name: 'octobre' },
  { number: 11, initial: 'N', name: 'novembre' },
  { number: 12, initial: 'D', name: 'décembre' },
] as const

/**
 * Serialise les mois vers la colonne `season_months`.
 *
 * Tri croissant, dedoublonnage, bornes 1..12, et `null` — jamais `''` — quand
 * rien n'est coche : le schema partage refuse une chaine vide, et c'est bien
 * « pas de donnee » qu'on veut stocker, pas « aucun mois ».
 */
export function seasonCsv(months: readonly number[]): string | null {
  const kept = [...new Set(months)].filter((m) => Number.isInteger(m) && m >= 1 && m <= 12).sort((a, b) => a - b)
  return kept.length > 0 ? kept.join(',') : null
}

// ---------------------------------------------------------------------------
// Brouillon de fiche
// ---------------------------------------------------------------------------

/**
 * L'etat du formulaire.
 *
 * Les champs texte sont des chaines (jamais `null`) : un `<input>` controle par
 * `null` bascule en non controle et React s'en plaint. La traduction vers le
 * `null` du modele se fait au moment de l'envoi, dans `toWritePayload`.
 */
export interface IngredientDraft {
  readonly name: string
  readonly brand: string
  readonly sourceRef: string
  readonly kcal: number | null
  readonly proteins: number | null
  readonly carbs: number | null
  readonly sugars: number | null
  readonly fats: number | null
  readonly saturatedFats: number | null
  readonly fiber: number | null
  readonly salt: number | null
  readonly pieceWeightG: number | null
  readonly cookedWeightPer100gRaw: number | null
  readonly categoryL1: string
  readonly months: readonly number[]
}

export const EMPTY_DRAFT: IngredientDraft = {
  name: '',
  brand: '',
  sourceRef: '',
  kcal: null,
  proteins: null,
  carbs: null,
  sugars: null,
  fats: null,
  saturatedFats: null,
  fiber: null,
  salt: null,
  pieceWeightG: null,
  cookedWeightPer100gRaw: null,
  categoryL1: '',
  months: [],
}

export function draftFromIngredient(ingredient: Ingredient): IngredientDraft {
  return {
    name: ingredient.name,
    brand: ingredient.brand ?? '',
    sourceRef: ingredient.sourceRef ?? '',
    kcal: ingredient.kcal,
    proteins: ingredient.proteins,
    carbs: ingredient.carbs,
    sugars: ingredient.sugars,
    fats: ingredient.fats,
    saturatedFats: ingredient.saturatedFats,
    fiber: ingredient.fiber,
    salt: ingredient.salt,
    pieceWeightG: ingredient.pieceWeightG,
    cookedWeightPer100gRaw: ingredient.cookedWeightPer100gRaw,
    categoryL1: ingredient.categoryL1 ?? '',
    months: parseSeasonMonths(ingredient),
  }
}

const blankToNull = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Brouillon -> charge utile d'ecriture.
 *
 * `categoryL2` part TOUJOURS a `null` : la hierarchie L1/L2 est abandonnee, et
 * chaque enregistrement nettoie au passage un residu du seed CIQUAL. Decision
 * reprise telle quelle du desktop.
 *
 * `priceEur` et `priceQuantityG` sont volontairement ABSENTS : ce sont des
 * caches de la derniere observation de l'historique, recalcules par le serveur.
 * Les envoyer depuis le formulaire ferait perdre le prix a chaque renommage.
 */
export function toWritePayload(draft: IngredientDraft): Partial<Ingredient> & { name: string } {
  return {
    name: draft.name.trim(),
    brand: blankToNull(draft.brand),
    kcal: draft.kcal,
    proteins: draft.proteins,
    carbs: draft.carbs,
    sugars: draft.sugars,
    fats: draft.fats,
    saturatedFats: draft.saturatedFats,
    fiber: draft.fiber,
    salt: draft.salt,
    pieceWeightG: draft.pieceWeightG,
    cookedWeightPer100gRaw: draft.cookedWeightPer100gRaw,
    categoryL1: blankToNull(draft.categoryL1),
    categoryL2: null,
    seasonMonths: seasonCsv(draft.months),
  }
}

/** Lien vers la fiche d'origine. `null` quand la source n'en a pas. */
export function sourceUrl(ingredient: Pick<Ingredient, 'source' | 'sourceRef'>): string | null {
  const ref = ingredient.sourceRef
  if (ref === null || ref.trim() === '') return null
  if (ingredient.source === 'ciqual') return `https://ciqual.anses.fr/#/aliments/${encodeURIComponent(ref)}`
  if (ingredient.source === 'openfoodfacts') {
    return `https://world.openfoodfacts.org/product/${encodeURIComponent(ref)}`
  }
  return null
}

/** Cle de deduplication d'une fiche du catalogue, valable meme sans identifiant. */
export const catalogKey = (ingredient: Ingredient): string =>
  ingredient.id !== null ? `id:${ingredient.id}` : `${ingredient.source}:${ingredient.sourceRef ?? ingredient.name}`

// ---------------------------------------------------------------------------
// Completion par l'IA (worker/src/completion.ts)
// ---------------------------------------------------------------------------

/** Les champs de la fiche que l'IA sait remplir. */
export type ChampIA = 'rayon' | 'poidsCuit' | 'saison' | 'poidsPiece'

export const CHAMPS_IA: readonly ChampIA[] = ['rayon', 'poidsPiece', 'poidsCuit', 'saison']

/** Pour les phrases : "Demander le poids cuit a l'IA". */
export const LIBELLES_IA: Readonly<Record<ChampIA, string>> = {
  rayon: 'le rayon',
  poidsCuit: 'le poids cuit',
  saison: 'la saison',
  poidsPiece: 'le poids unitaire',
}

/** Les champs que l'IA sait remplir et qui sont encore vides dans la fiche. */
export function champsACompleter(draft: IngredientDraft): Readonly<Record<ChampIA, boolean>> {
  return {
    rayon: draft.categoryL1.trim() === '',
    poidsCuit: draft.cookedWeightPer100gRaw === null,
    saison: draft.months.length === 0,
    poidsPiece: draft.pieceWeightG === null,
  }
}

/**
 * La valeur que l'IA propose pour UN champ, prete a poser dans la fiche, ou
 * `null` si elle n'en a pas.
 *
 * Les TYPES d'abord, et non `!== null` : une reponse a laquelle il manque une
 * cle poserait `undefined` dans la fiche, et le premier `.trim()` de l'ecran
 * ferait tomber toute l'application (vu en essai).
 */
export function propositionPour(c: Completion, champ: ChampIA): Partial<IngredientDraft> | null {
  switch (champ) {
    case 'rayon':
      return typeof c.rayon === 'string' && c.rayon.trim() !== '' ? { categoryL1: c.rayon } : null
    case 'poidsCuit':
      return typeof c.poidsCuitG === 'number' && Number.isFinite(c.poidsCuitG)
        ? { cookedWeightPer100gRaw: c.poidsCuitG }
        : null
    case 'saison':
      return Array.isArray(c.moisSaison) && c.moisSaison.length > 0 ? { months: [...c.moisSaison] } : null
    case 'poidsPiece':
      return typeof c.poidsPieceG === 'number' && Number.isFinite(c.poidsPieceG) ? { pieceWeightG: c.poidsPieceG } : null
  }
}

/**
 * Le bouton IA de la fiche : la proposition, posee dans les champs VIDES
 * seulement, comme cote serveur. Rend la modification et les champs remplis,
 * que l'ecran encadre jusqu'a l'enregistrement.
 */
export function appliquerCompletion(
  draft: IngredientDraft,
  c: Completion,
): { readonly patch: Partial<IngredientDraft>; readonly champs: readonly ChampIA[] } {
  const vides = champsACompleter(draft)
  let patch: Partial<IngredientDraft> = {}
  const champs: ChampIA[] = []
  for (const champ of CHAMPS_IA) {
    if (!vides[champ]) continue
    const valeur = propositionPour(c, champ)
    if (valeur === null) continue
    patch = { ...patch, ...valeur }
    champs.push(champ)
  }
  return { patch, champs }
}

const pluriel = (n: number, mot: string, motPluriel = `${mot}s`) => `${n} ${n > 1 ? motPluriel : mot}`

/** Le bilan d'une completion de la bibliotheque, en une phrase. */
export function bilanCompletion(somme: {
  readonly traites: number
  readonly rayons: number
  readonly poidsCuits: number
  readonly saisons: number
}): string {
  if (somme.traites === 0) return 'Rien n’a pu être complété. Réessaie plus tard.'
  const relus = `${pluriel(somme.traites, 'produit')} relu${somme.traites > 1 ? 's' : ''}`
  const parties = [
    somme.rayons > 0 ? pluriel(somme.rayons, 'rayon') : null,
    somme.poidsCuits > 0 ? pluriel(somme.poidsCuits, 'poids cuit', 'poids cuits') : null,
    somme.saisons > 0 ? pluriel(somme.saisons, 'saison') : null,
  ].filter((p): p is string => p !== null)
  if (parties.length === 0) return `${relus}, rien de sûr à ajouter.`
  // L'accord suit le genre : des saisons seules sont "ajoutées", un rayon ou
  // un poids cuit dans la liste fait passer au masculin.
  const total = somme.rayons + somme.poidsCuits + somme.saisons
  const feminin = somme.rayons === 0 && somme.poidsCuits === 0
  const ajoute = `ajouté${feminin ? 'e' : ''}${total > 1 ? 's' : ''}`
  return `${relus} : ${parties.join(', ')} ${ajoute}. Tout se corrige dans la fiche.`
}
