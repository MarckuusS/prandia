/**
 * Derivations du frigo : un lot, son urgence, son tri, son regroupement.
 *
 * Tout est PUR ici — ni requete, ni composant, ni etat. C'est ce qui permet de
 * recalculer les seaux d'urgence au retour au premier plan sans redemander
 * quoi que ce soit au reseau, et de raisonner sur les regles de tri sans
 * monter React.
 *
 * L'unite de base est le LOT, jamais l'ingredient : deux briques de lait
 * ouvertes a une semaine d'ecart ont deux peremptions et ne se confondent pas.
 * La consolidation par ingredient n'existe que pour la liste de courses, ou
 * seule la masse totale compte.
 *
 * Un defaut du desktop est corrige ici : il triait cote Python puis regroupait
 * cote QML par `section.property`, si bien qu'un tri qui ne suivait pas le
 * groupement faisait reapparaitre trois fois la section « En stock ». Le tri
 * s'applique d'abord, puis les sections sont bâties dans un ordre FIXE.
 */

import {
  UNCATEGORIZED_LABEL,
  daysUntil,
  formatGrams,
  estUnPlat,
  formatShoppingQuantity,
  normalizeName,
  urgencyBucket,
  type Ingredient,
  type PantryStock,
  type UrgencyBucket,
} from '@prandia/shared'

// ---------------------------------------------------------------------------
// Le lot
// ---------------------------------------------------------------------------

export interface Lot {
  readonly id: number
  readonly stock: PantryStock
  /** `null` quand l'ingredient a ete supprime et que la cascade a laisse le lot. */
  readonly ingredient: Ingredient | null
  readonly name: string
  readonly categoryL1: string | null
  readonly pieceWeightG: number | null
  /** Jours entiers restants, negatif si perime, `null` sans peremption suivie. */
  readonly daysLeft: number | null
  readonly bucket: UrgencyBucket
  /** Nombre de lots du meme ingredient, ce lot compris. */
  readonly siblingCount: number
  /** Masse de l'ingredient tous lots confondus — ce que voit la liste de courses. */
  readonly totalG: number
}

/** Lot dont l'ingredient a disparu : il reste supprimable, c'est tout ce qu'on peut en faire. */
export const ORPHAN_NAME = 'Ingrédient supprimé'

/**
 * Construit les lots affichables.
 *
 * `today` est passe en argument plutot que lu ici : l'ecran le fige et le
 * renouvelle au retour au premier plan, sinon une PWA laissee ouverte deux
 * jours afficherait des urgences fausses.
 *
 * Le desktop ignorait les lots orphelins, qui devenaient invisibles ET
 * indestructibles tout en continuant a compter dans la couverture de la liste
 * de courses. On les affiche donc, sous un nom explicite : c'est le seul moyen
 * de les faire disparaitre.
 */
export function buildLots(
  items: readonly PantryStock[],
  ingredientsById: Record<string, Ingredient>,
  today: Date,
): Lot[] {
  const totals = new Map<number, { count: number; grams: number }>()
  for (const stock of items) {
    const accumulated = totals.get(stock.ingredientId) ?? { count: 0, grams: 0 }
    totals.set(stock.ingredientId, {
      count: accumulated.count + 1,
      grams: accumulated.grams + stock.quantityG,
    })
  }

  const lots: Lot[] = []
  for (const stock of items) {
    // Un lot sans identifiant ne serait ni modifiable ni supprimable : il ne
    // peut venir que d'une reponse malformee, on ne le montre pas.
    if (stock.id === null) continue

    const ingredient = ingredientsById[String(stock.ingredientId)] ?? null
    const daysLeft = stock.expiryDate === null ? null : daysUntil(stock.expiryDate, today)
    const total = totals.get(stock.ingredientId)

    lots.push({
      id: stock.id,
      stock,
      ingredient,
      name: ingredient?.name ?? ORPHAN_NAME,
      categoryL1: ingredient?.categoryL1 ?? null,
      pieceWeightG: ingredient?.pieceWeightG ?? null,
      daysLeft,
      bucket: urgencyBucket(daysLeft),
      siblingCount: total?.count ?? 1,
      totalG: total?.grams ?? stock.quantityG,
    })
  }
  return lots
}

// ---------------------------------------------------------------------------
// Filtre, tri, groupement
// ---------------------------------------------------------------------------

/**
 * Filtre par nom.
 *
 * `normalizeName` plie les accents et les ligatures, ce que le desktop ne
 * faisait pas : il comparait des `casefold()` bruts, et « creme » ne trouvait
 * pas « crème ».
 */
export function filterLots(lots: readonly Lot[], query: string): Lot[] {
  const needle = normalizeName(query)
  if (needle === '') return [...lots]
  return lots.filter((lot) => normalizeName(lot.name).includes(needle))
}

/*
 * `court` sert la CHIP, `label` sert le libelle long.
 *
 * Une chip fait vingt pixels de haut sur un telephone : "Quantité
 * (décroissant)" y passe a la ligne ou se coupe. Les deux existent donc, et
 * aucun tri n'a ete retire pour tenir dans la place.
 */
export const SORTS = [
  { value: 'urgence', label: 'Urgence (péremption)', court: "À consommer d'abord" },
  { value: 'rayon', label: 'Rayon', court: 'Par rayon' },
  { value: 'nom', label: 'Nom (A-Z)', court: 'Nom' },
  { value: 'quantite', label: 'Quantité (décroissant)', court: 'Quantité' },
  { value: 'peremption', label: 'Date de péremption', court: 'Date' },
] as const
export type SortValue = (typeof SORTS)[number]['value']

export const GROUPS = [
  { value: 'urgence', label: 'Urgence' },
  { value: 'rayon', label: 'Rayon' },
  { value: 'aucun', label: 'Aucun' },
] as const
export type GroupValue = (typeof GROUPS)[number]['value']

/** Lit une valeur venue de l'URL, ou le defaut si elle ne fait pas partie du choix. */
export function readOption<T extends string>(
  raw: string | null,
  options: ReadonlyArray<{ readonly value: T }>,
  fallback: T,
): T {
  return options.find((option) => option.value === raw)?.value ?? fallback
}

// localeCompare et non une comparaison de points de code : « Œuf » vaut
// U+0152, au-dela de Z, et se retrouverait apres « Zeste » dans la liste.
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true })

/** Sans peremption = pas urgent : ces lots ferment la marche, dans les deux sens. */
function compareExpiry(a: Lot, b: Lot): number {
  if (a.daysLeft === null || b.daysLeft === null) {
    if (a.daysLeft === b.daysLeft) return 0
    return a.daysLeft === null ? 1 : -1
  }
  return a.daysLeft - b.daysLeft
}

/** Meme regle pour les rayons inconnus : en dernier, jamais melanges au reste. */
function compareCategory(a: Lot, b: Lot): number {
  if (a.categoryL1 === null || b.categoryL1 === null) {
    if (a.categoryL1 === b.categoryL1) return 0
    return a.categoryL1 === null ? 1 : -1
  }
  return collator.compare(a.categoryL1, b.categoryL1)
}

const compareName = (a: Lot, b: Lot): number => collator.compare(a.name, b.name)

export function sortLots(lots: readonly Lot[], sort: SortValue): Lot[] {
  const sorted = [...lots]
  switch (sort) {
    case 'nom':
      return sorted.sort(compareName)
    case 'quantite':
      return sorted.sort((a, b) => b.stock.quantityG - a.stock.quantityG)
    case 'peremption':
      // Sans departage par nom, comme sur le desktop : le tri de tableau est
      // stable depuis ES2019, l'ordre du serveur (date puis identifiant) tient
      // donc lieu de second critere.
      return sorted.sort(compareExpiry)
    case 'rayon':
      return sorted.sort((a, b) => compareCategory(a, b) || compareName(a, b))
    case 'urgence':
      return sorted.sort((a, b) => compareExpiry(a, b) || compareName(a, b))
  }
}

export interface LotSection {
  readonly key: string
  /** `null` quand le groupement est desactive : la liste est alors plate. */
  readonly title: string | null
  readonly hint: string | null
  /** Colore l'en-tete. `null` pour un rayon, qui n'a pas d'urgence propre. */
  readonly bucket: UrgencyBucket | null
  readonly lots: readonly Lot[]
}

const URGENCY_SECTIONS: ReadonlyArray<{
  readonly bucket: UrgencyBucket
  readonly title: string
  readonly hint: string
}> = [
  { bucket: 'soon', title: 'À consommer vite', hint: '5 jours ou moins' },
  { bucket: 'watch', title: 'À surveiller', hint: '14 jours ou moins' },
  { bucket: 'stock', title: 'En stock', hint: 'sans urgence' },
]

export function groupLots(lots: readonly Lot[], group: GroupValue): LotSection[] {
  if (group === 'aucun') {
    return lots.length === 0 ? [] : [{ key: 'all', title: null, hint: null, bucket: null, lots }]
  }

  if (group === 'urgence') {
    // Ordre fixe et non ordre d'apparition : une section ne peut plus se
    // repeter, quel que soit le tri actif.
    return URGENCY_SECTIONS.map((section) => ({
      key: section.bucket,
      title: section.title,
      hint: section.hint,
      bucket: section.bucket,
      lots: lots.filter((lot) => lot.bucket === section.bucket),
    })).filter((section) => section.lots.length > 0)
  }

  const byCategory = new Map<string, Lot[]>()
  for (const lot of lots) {
    const category = lot.categoryL1 ?? UNCATEGORIZED_LABEL
    const bucket = byCategory.get(category)
    if (bucket) bucket.push(lot)
    else byCategory.set(category, [lot])
  }

  return [...byCategory.entries()]
    .sort(([a], [b]) => {
      if (a === UNCATEGORIZED_LABEL || b === UNCATEGORIZED_LABEL) {
        return a === b ? 0 : a === UNCATEGORIZED_LABEL ? 1 : -1
      }
      return collator.compare(a, b)
    })
    .map(([category, sectionLots]) => ({
      key: category,
      title: category,
      hint: null,
      bucket: null,
      lots: sectionLots,
    }))
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/**
 * « 1,5 kg », « 250 g », et l'equivalent en pieces quand l'ingredient en a une.
 *
 * On passe par le formateur partage plutot que par la regle a trois branches du
 * desktop (2 decimales sous 10 kg, 1 au-dela, 1 sous 10 g) : cette regle
 * n'existait qu'en QML, et une quatrieme copie du meme arrondi finirait par
 * diverger des trois autres.
 */
export function formatLotQuantity(lot: Lot): string {
  return formatShoppingQuantity(
    {
      quantityG: lot.stock.quantityG,
      pieceCount: lot.pieceWeightG ? lot.stock.quantityG / lot.pieceWeightG : null,
    },
    // Le reste d'un plat cuisine se compte en parts.
    lot.ingredient !== null && estUnPlat(lot.ingredient) ? 'part' : 'pièce',
  )
}

/** Masse cumulee d'un ingredient, pour les lignes qui ont des lots freres. */
export const formatLotTotal = (lot: Lot): string => formatGrams(lot.totalG)

/**
 * L'echeance en clair. Six cas, repris mot pour mot du desktop.
 *
 * Le texte reste neutre entre 6 et 14 jours alors que la couleur passe a
 * l'orange : c'est voulu, la couleur dit le seau, le texte dit le delai.
 */
export function formatExpiryLabel(daysLeft: number | null): string {
  if (daysLeft === null) return 'Pas de date'
  if (daysLeft < 0) return `Périmé depuis ${-daysLeft} j`
  if (daysLeft === 0) return "Périme aujourd'hui"
  if (daysLeft === 1) return 'Périme demain'
  return `Dans ${daysLeft} jours`
}

/**
 * La date absolue, en toutes lettres.
 *
 * « Dans 12 jours » ne permet pas de comparer avec l'etiquette du produit :
 * la feuille du lot montre donc aussi la date elle-meme. Decoupage manuel et
 * non `new Date(iso)`, qui interprete 'AAAA-MM-JJ' en UTC et affiche la veille
 * pour tout le fuseau europeen.
 */
export function formatExpiryDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  if (year === undefined || month === undefined || day === undefined) return iso
  return new Date(year, month - 1, day).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/**
 * L'echeance en DEUX CARACTERES, pour la pastille de droite.
 *
 * "J-1" tient la ou "Périme demain" prend treize caracteres et pousse le nom du
 * produit sur deux lignes. Le texte long n'est pas perdu : il reste dans la
 * fiche du lot, et il sert de libelle accessible a cette pastille, parce que
 * "J-1" ne se lit pas a voix haute.
 *
 * Au-dela de quatre-vingt-dix-neuf jours, on bascule en mois : "J-365" est un
 * nombre qu'on ne compare a rien.
 */
export function formatJours(daysLeft: number | null): string {
  if (daysLeft === null) return ''
  if (daysLeft < 0) return 'Périmé'
  if (daysLeft > 99) return `${Math.round(daysLeft / 30)} mois`
  return `J-${daysLeft}`
}
