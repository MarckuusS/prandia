/**
 * Profil alimentaire et sportif, et objectifs qui en decoulent.
 *
 * Module PUR : aucune base, aucun reseau. C'est ce qui permet de le tester
 * comme une specification, et c'est important ici — les chiffres qu'il produit
 * sont affiches comme des reperes de sante.
 *
 * ---------------------------------------------------------------------------
 * DEUX AXES, ET NON UN SEUL
 * ---------------------------------------------------------------------------
 * La premiere version confondait deux questions dans une liste de trois
 * entrees : COMBIEN d'energie (perdre / maintenir / prendre) et COMMENT elle se
 * repartit (30/35/35…). Les deux etaient soudees, donc « perdre du poids »
 * imposait sa repartition, et vouloir des proteines hautes obligeait a changer
 * d'objectif de poids.
 *
 * Elles sont maintenant separees :
 *
 *   - `ENERGY_GOALS` decide de la CIBLE EN KCAL — l'ecart a la depense estimee.
 *   - `MACRO_SPLITS` decide du PARTAGE de cette energie entre les trois macros.
 *
 * Chaque objectif propose une repartition par defaut, que l'utilisateur peut
 * remplacer par une autre, ou ecrire lui-meme. C'est le point de la separation :
 * une seche et une prise de masse peuvent partager une repartition, deux
 * personnes en perte de poids peuvent en vouloir des differentes.
 *
 * ---------------------------------------------------------------------------
 * CE QUE CE MODULE N'EST PAS
 * ---------------------------------------------------------------------------
 * Ce n'est pas un avis medical, et l'interface doit le dire. Mifflin-St Jeor
 * est une ESTIMATION statistique du metabolisme de base : elle ignore la
 * composition corporelle, la genetique, les traitements, la grossesse et
 * l'allaitement. Un ecart de 10 a 15 % avec la depense reelle est normal.
 *
 * D'ou des garde-fous inscrits dans le code plutot que laisses a la vigilance
 * de l'interface : un plancher de kcal, un plafond d'allure, et des drapeaux
 * que l'ecran est oblige de regarder (`floored`, `capped`, `lowProteins`,
 * `lowFats`).
 */

/**
 * Niveaux d'activite et leur facteur.
 *
 * Facteurs usuels de la litterature sur Harris-Benedict et Mifflin-St Jeor.
 * Les libelles decrivent la SEMAINE entiere, sport compris : c'est l'erreur de
 * saisie la plus frequente que d'additionner mentalement un facteur « actif »
 * et des seances de sport deja comptees dedans.
 */
export const ACTIVITY_LEVELS = [
  { code: 'sedentaire', label: 'Sédentaire', hint: 'Bureau, peu de marche, pas de sport', factor: 1.2 },
  { code: 'leger', label: 'Légèrement actif', hint: 'Sport 1 à 3 fois par semaine', factor: 1.375 },
  { code: 'actif', label: 'Actif', hint: 'Sport 3 à 5 fois par semaine', factor: 1.55 },
  { code: 'sportif', label: 'Très actif', hint: 'Sport 6 à 7 fois par semaine', factor: 1.725 },
  { code: 'athlete', label: 'Athlète', hint: 'Deux entraînements par jour, métier physique', factor: 1.9 },
] as const

export type ActivityCode = (typeof ACTIVITY_LEVELS)[number]['code']

// ---------------------------------------------------------------------------
// Repartitions
// ---------------------------------------------------------------------------

export interface MacroSplit {
  readonly proteins: number
  readonly carbs: number
  readonly fats: number
}

/**
 * Repartitions proposees, en part de l'ENERGIE et non en grammes.
 *
 * L'energie est la seule unite qui reste valable quand la cible en kcal change :
 * une repartition en grammes devrait etre reecrite a chaque kilo perdu.
 *
 * Aucune ne descend sous 20 % de lipides. En dessous, l'apport ne couvre plus
 * les besoins hormonaux et l'absorption des vitamines liposolubles — c'est la
 * limite basse communement citee, et `estimateTargets` la surveille meme sur
 * une repartition ecrite a la main.
 */
export const MACRO_SPLITS = [
  {
    code: 'equilibre',
    label: 'Équilibrée',
    hint: 'Le partage courant, sans parti pris',
    split: { proteins: 25, carbs: 45, fats: 30 },
  },
  {
    code: 'proteine',
    label: 'Riche en protéines',
    hint: 'Rassasie davantage à énergie égale',
    split: { proteins: 35, carbs: 35, fats: 30 },
  },
  {
    code: 'seche',
    label: 'Sèche',
    hint: 'Protéines hautes pour préserver le muscle en déficit',
    split: { proteins: 40, carbs: 30, fats: 30 },
  },
  {
    code: 'faible_glucides',
    label: 'Faible en glucides',
    hint: 'Les lipides prennent la place des glucides',
    split: { proteins: 30, carbs: 20, fats: 50 },
  },
  {
    code: 'endurance',
    label: 'Endurance',
    hint: 'Glucides hauts, pour les sorties longues',
    split: { proteins: 20, carbs: 55, fats: 25 },
  },
  {
    code: 'mediterraneen',
    label: 'Méditerranéenne',
    hint: 'Lipides d’origine végétale, glucides modérés',
    split: { proteins: 20, carbs: 45, fats: 35 },
  },
  {
    code: 'perso',
    label: 'Personnalisée',
    hint: 'Trois pourcentages qui totalisent 100',
    split: null,
  },
] as const

export type SplitCode = (typeof MACRO_SPLITS)[number]['code']

// ---------------------------------------------------------------------------
// Objectifs energetiques
// ---------------------------------------------------------------------------

/**
 * Objectifs, et l'ecart qu'ils creusent par rapport a la depense estimee.
 *
 * L'ajustement est un POURCENTAGE de la depense et non un forfait de 500 kcal :
 * retrancher 500 a quelqu'un qui depense 1 800 est une coupe de 28 %, la meme
 * coupe a quelqu'un qui depense 3 200 n'en fait que 16. Le pourcentage traite
 * les deux de la meme facon.
 *
 * `perte`, `maintien` et `prise` sont les trois codes d'origine : ils restent
 * pour que les profils deja enregistres continuent de se lire.
 *
 * `defaultSplit` n'est qu'une PROPOSITION. Elle s'applique tant que personne
 * n'a choisi de repartition, et cede des que quelqu'un en choisit une.
 */
export const ENERGY_GOALS = [
  {
    code: 'seche',
    label: 'Sèche',
    hint: 'Déficit marqué, protéines hautes',
    adjust: -0.2,
    defaultSplit: 'seche',
  },
  {
    code: 'perte',
    label: 'Perdre du poids',
    hint: 'Environ 15 % sous la dépense estimée',
    adjust: -0.15,
    defaultSplit: 'proteine',
  },
  {
    code: 'perte_douce',
    label: 'Perte progressive',
    hint: 'Déficit léger, tenable sur la durée',
    adjust: -0.1,
    defaultSplit: 'equilibre',
  },
  {
    code: 'maintien',
    label: 'Maintenir mon poids',
    hint: 'À la hauteur de la dépense estimée',
    adjust: 0,
    defaultSplit: 'equilibre',
  },
  {
    code: 'prise_seche',
    label: 'Prise de masse sèche',
    hint: 'Léger surplus, pour limiter le gras pris',
    adjust: 0.1,
    defaultSplit: 'proteine',
  },
  {
    code: 'prise',
    label: 'Prise de masse',
    hint: 'Surplus franc',
    adjust: 0.2,
    defaultSplit: 'proteine',
  },
] as const

export type GoalCode = (typeof ENERGY_GOALS)[number]['code']

/**
 * Les trois DIRECTIONS, et les objectifs fins qu'elles regroupent.
 *
 * Un ecran ne peut pas demander de choisir entre six pourcentages avant meme
 * d'avoir demande de quel cote on va. Les trois directions sont la question
 * qu'on se pose en premier ; les six objectifs restent la reponse fine, et
 * aucun ne disparait.
 *
 * L'ordre a l'interieur d'une direction va du PLUS DOUX au plus marque, et
 * `defaut` est toujours le premier. Un ecart de 20 % ne doit jamais s'obtenir
 * par defaut : il se choisit.
 */
export const GOAL_DIRECTIONS = [
  { code: 'perdre', label: 'Perdre', goals: ['perte_douce', 'perte', 'seche'] },
  { code: 'maintenir', label: 'Maintenir', goals: ['maintien'] },
  { code: 'prendre', label: 'Prendre', goals: ['prise_seche', 'prise'] },
] as const satisfies readonly {
  code: string
  label: string
  goals: readonly GoalCode[]
}[]

export type DirectionCode = (typeof GOAL_DIRECTIONS)[number]['code']

/** La direction d'un objectif. `null` quand aucun objectif n'est choisi. */
export function directionOf(goal: GoalCode | null | undefined): DirectionCode | null {
  if (goal == null) return null
  return GOAL_DIRECTIONS.find((d) => (d.goals as readonly string[]).includes(goal))?.code ?? null
}

/**
 * L'objectif a retenir quand on passe a une direction.
 *
 * Garde l'objectif en cours s'il appartient DEJA a cette direction : taper sur
 * la tuile deja active ne doit rien changer, et revenir d'un aller-retour non
 * plus. Sinon, prend le plus doux de la direction.
 */
export function goalForDirection(
  direction: DirectionCode,
  current: GoalCode | null | undefined,
): GoalCode {
  const entree = GOAL_DIRECTIONS.find((d) => d.code === direction)
  if (entree === undefined) throw new Error(`Direction inconnue : ${direction}`)
  if (current != null && (entree.goals as readonly string[]).includes(current)) return current
  return entree.goals[0] as GoalCode
}

export type Sex = 'f' | 'm'

// ---------------------------------------------------------------------------
// Garde-fous
// ---------------------------------------------------------------------------

/**
 * Plancher de securite, en kcal par jour.
 *
 * En dessous, un apport ne couvre plus les besoins de base d'un adulte et
 * releve d'un suivi medical, pas d'une application de recettes. Les valeurs
 * retenues sont les seuils communement cites pour un regime non supervise.
 */
export const MIN_SAFE_KCAL: Record<Sex, number> = { f: 1200, m: 1500 }

/**
 * Ecart maximal a la depense, en part de celle-ci.
 *
 * Sert quand l'ecart vient d'une ALLURE demandee (« 1 kg par semaine ») et non
 * d'un pourcentage choisi : une allure ambitieuse sur une petite depense donne
 * vite un deficit de 50 %. Le plafond le ramene a 25 %, et le drapeau `capped`
 * oblige l'ecran a dire que l'allure demandee ne sera pas tenue.
 */
export const MAX_ADJUST = 0.25

/** Part minimale de l'energie en lipides, sous laquelle on avertit. */
export const MIN_FAT_PERCENT = 20

/** Proteines minimales en g/kg, sous lesquelles on avertit en deficit. */
export const MIN_PROTEINS_PER_KG = 1.2

/**
 * Energie d'un kilo de masse corporelle, en kcal.
 *
 * Approximation classique (un kilo de tissu adipeux ≈ 7 700 kcal). Elle sert a
 * convertir une allure en kg/semaine en un ecart journalier. Elle SURESTIME les
 * premieres semaines, ou la balance bouge surtout par l'eau ; c'est une regle
 * de conversion, pas une promesse.
 */
export const KCAL_PER_KG = 7700

/**
 * L'allure, en kg par semaine : bornes du reglage continu.
 *
 * ELLE ETAIT UN CODE PARMI TROIS (0,25 / 0,5 / 0,75). L'ecran offre desormais
 * un curseur qui glisse, ce qui demande un nombre. Les profils enregistres ont
 * ete convertis par la migration 0014 ; les trois anciennes valeurs restent
 * atteignables, elles ne sont simplement plus les seules.
 *
 * Le HAUT est `SAFE_PACE.max` de `weight.ts`, soit 1 kg par semaine : c'est la
 * borne communement citee, et le curseur ne va pas au-dela. Le BAS est
 * volontairement SOUS le seuil de lisibilite d'une balance : quelqu'un peut
 * vouloir aller tres doucement, l'ecran le dit sans l'interdire.
 */
export const PACE_BOUNDS = { min: 0.1, max: 1, step: 0.05 } as const

/**
 * Une allure ecrite en toutes lettres, pour l'accompagner d'un mot.
 *
 * Les seuils viennent de `SAFE_PACE` : sous 0,2 kg par semaine le changement
 * se perd dans le bruit d'une balance, ce que le tableau de bord dit deja du
 * rythme observe.
 */
export function paceLabel(kgPerWeek: number): string {
  if (kgPerWeek < 0.2) return 'Très progressif'
  if (kgPerWeek <= 0.35) return 'Confortable'
  if (kgPerWeek <= 0.6) return 'Le compromis habituel'
  if (kgPerWeek <= 0.8) return 'Exigeant'
  return 'Difficile à tenir longtemps'
}

// ---------------------------------------------------------------------------

export interface Profile {
  readonly sex: Sex | null
  readonly birthYear: number | null
  readonly heightCm: number | null
  readonly weightKg: number | null
  readonly activity: ActivityCode | null
  readonly goal: GoalCode | null
  /** Repartition choisie. `null` = celle que propose l'objectif. */
  readonly split?: SplitCode | null
  /** Pourcentages ecrits a la main. Lus seulement si `split === 'perso'`. */
  readonly customSplit?: MacroSplit | null
  /** Poids vise, en kg. `null` = pas d'arrivee, seulement une direction. */
  readonly targetWeightKg?: number | null
  /** Allure visee, en kg par semaine. Lue seulement avec un poids vise. */
  readonly paceKgPerWeek?: number | null
}

export interface MacroTarget {
  readonly percent: number
  readonly grams: number
  readonly kcal: number
}

export interface Targets {
  /** Metabolisme de base, en kcal par jour. */
  readonly bmr: number
  /** Depense totale estimee : metabolisme de base x facteur d'activite. */
  readonly tdee: number
  /** Cible journaliere, apres ajustement et garde-fous. */
  readonly kcal: number
  readonly proteins: MacroTarget
  readonly carbs: MacroTarget
  readonly fats: MacroTarget
  /** Repartition finalement appliquee, et d'ou elle vient. */
  readonly split: MacroSplit
  readonly splitCode: SplitCode
  /** Proteines rapportees au poids — l'unite dans laquelle elles se jugent. */
  readonly proteinsPerKg: number

  /** Vrai si le plancher de securite a releve la cible. */
  readonly floored: boolean
  /** Vrai si l'allure demandee depassait `MAX_ADJUST` et a ete ramenee. */
  readonly capped: boolean
  /** Vrai si les proteines tombent sous `MIN_PROTEINS_PER_KG` en deficit. */
  readonly lowProteins: boolean
  /** Vrai si les lipides tombent sous `MIN_FAT_PERCENT`. */
  readonly lowFats: boolean

  /** Semaines estimees jusqu'au poids vise, s'il y en a un. */
  readonly weeksToTarget: number | null
  /** Date d'arrivee estimee, au format `yyyy-mm-dd`. */
  readonly targetDate: string | null
  /** Kilos restants (valeur absolue), s'il y a un poids vise. */
  readonly kgToTarget: number | null
}

/** kcal par gramme, pour convertir une part d'energie en grammes. */
const KCAL_PER_G = { proteins: 4, carbs: 4, fats: 9 } as const

/**
 * Age revolu approximatif, a partir de l'annee de naissance.
 *
 * L'annee suffit : Mifflin-St Jeor retranche 5 kcal par annee d'age, donc une
 * erreur de douze mois deplace la cible de 5 kcal — trois cacahuetes. Demander
 * une date de naissance complete serait collecter une donnee plus sensible pour
 * un gain nul.
 */
export const ageFrom = (birthYear: number, now: Date): number => now.getFullYear() - birthYear

/**
 * Metabolisme de base — equation de Mifflin-St Jeor (1990).
 *
 *   homme : 10 x poids + 6,25 x taille - 5 x age + 5
 *   femme : 10 x poids + 6,25 x taille - 5 x age - 161
 *
 * Retenue plutot que Harris-Benedict, qu'elle a remplacee : elle est plus juste
 * sur les populations actuelles, et c'est la reference des recommandations
 * nutritionnelles depuis les annees 2000. Ce n'est pas une formule maison, et
 * c'est le point : elle est verifiable.
 */
export function basalMetabolicRate(
  sex: Sex,
  weightKg: number,
  heightCm: number,
  age: number,
): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return sex === 'm' ? base + 5 : base - 161
}

/**
 * Ramene trois pourcentages a un total de 100.
 *
 * Une repartition ecrite a la main arrive rarement juste, et un total de 97
 * produirait une cible qui ne consomme pas toute l'energie annoncee — sans que
 * rien ne l'explique a la lecture. Le reste d'arrondi va aux glucides, la macro
 * dont le gramme se lit le moins precisement.
 */
export function normalizeSplit(split: MacroSplit): MacroSplit {
  const total = split.proteins + split.carbs + split.fats
  if (total <= 0) return { proteins: 25, carbs: 45, fats: 30 }

  const proteins = Math.round((split.proteins / total) * 100)
  const fats = Math.round((split.fats / total) * 100)
  return { proteins, fats, carbs: 100 - proteins - fats }
}

/** La repartition d'un code, ou `null` pour `perso` (qui n'en porte pas). */
export const splitOf = (code: SplitCode): MacroSplit | null =>
  MACRO_SPLITS.find((s) => s.code === code)?.split ?? null

/**
 * Cibles journalieres, ou `null` si le profil est incomplet.
 *
 * `null` et non une estimation partielle : une cible calculee sur un poids
 * devine serait presentee avec la meme assurance qu'une cible calculee sur un
 * poids reel, et rien a l'ecran ne les distinguerait.
 */
export function estimateTargets(profile: Profile, now: Date = new Date()): Targets | null {
  const { sex, birthYear, heightCm, weightKg, activity, goal } = profile
  if (sex === null || birthYear === null || heightCm === null || weightKg === null) return null
  if (activity === null || goal === null) return null

  const age = ageFrom(birthYear, now)
  const level = ACTIVITY_LEVELS.find((l) => l.code === activity)
  const target = ENERGY_GOALS.find((g) => g.code === goal)
  if (!level || !target) return null

  const bmr = Math.round(basalMetabolicRate(sex, weightKg, heightCm, age))
  const tdee = Math.round(bmr * level.factor)

  // ---- L'ecart : soit une allure vers un poids vise, soit un pourcentage ----
  //
  // L'allure l'emporte quand elle est exploitable : « atteindre 68 kg à 0,5 kg
  // par semaine » est une intention plus precise que « perdre du poids », et
  // c'est elle qui doit decider du deficit.
  const kgToTarget =
    profile.targetWeightKg != null ? Math.abs(profile.targetWeightKg - weightKg) : null

  const paceKgWeek = profile.paceKgPerWeek ?? undefined

  let ratio = target.adjust
  let capped = false

  if (profile.targetWeightKg != null && paceKgWeek !== undefined && kgToTarget !== null && kgToTarget > 0) {
    // La direction vient de l'ECART REEL, jamais de l'objectif : quelqu'un qui
    // vise plus lourd que son poids actuel prend du poids, meme si l'objectif
    // affiche dit « perdre » — c'est le poids vise qui est explicite.
    const direction = profile.targetWeightKg > weightKg ? 1 : -1
    const dailyDelta = (paceKgWeek * KCAL_PER_KG) / 7
    ratio = (direction * dailyDelta) / tdee
  }

  if (Math.abs(ratio) > MAX_ADJUST) {
    ratio = Math.sign(ratio) * MAX_ADJUST
    capped = true
  }

  const wanted = Math.round(tdee * (1 + ratio))
  const floor = MIN_SAFE_KCAL[sex]
  const kcal = Math.max(wanted, floor)

  // ---- La repartition ----
  const splitCode: SplitCode = profile.split ?? target.defaultSplit
  const chosen =
    splitCode === 'perso'
      ? (profile.customSplit ?? splitOf(target.defaultSplit) ?? { proteins: 25, carbs: 45, fats: 30 })
      : (splitOf(splitCode) ?? splitOf(target.defaultSplit) ?? { proteins: 25, carbs: 45, fats: 30 })
  const split = normalizeSplit(chosen)

  const macro = (key: keyof typeof KCAL_PER_G): MacroTarget => {
    const percent = split[key]
    const macroKcal = Math.round((kcal * percent) / 100)
    return { percent, kcal: macroKcal, grams: Math.round(macroKcal / KCAL_PER_G[key]) }
  }

  const proteins = macro('proteins')
  const carbs = macro('carbs')
  const fats = macro('fats')
  const proteinsPerKg = proteins.grams / weightKg

  // ---- Combien de temps ----
  //
  // Calcule sur l'ecart REELLEMENT applique, pas sur l'allure demandee : quand
  // le plafond ou le plancher est intervenu, annoncer la date de l'allure
  // demandee serait promettre ce que la cible ne produira pas.
  // Et surtout : la cible se RAPPROCHE-t-elle ? Le plancher de securite peut
  // relever l'apport au-dessus de la depense, ce qui fait grossir quelqu'un qui
  // visait plus leger. Annoncer alors « 63 semaines » serait promettre une
  // arrivee dans la mauvaise direction. `weeksToTarget` reste `null` : a
  // l'ecran de dire que le reglage n'y mene pas.
  const appliedDelta = tdee - kcal // > 0 en deficit
  const kgPerWeek = (Math.abs(appliedDelta) * 7) / KCAL_PER_KG
  const needsLoss = profile.targetWeightKg != null && profile.targetWeightKg < weightKg
  const progressing = needsLoss ? appliedDelta > 0 : appliedDelta < 0
  const weeksToTarget =
    kgToTarget !== null && kgToTarget > 0 && kgPerWeek > 0 && progressing
      ? Math.ceil(kgToTarget / kgPerWeek)
      : null

  return {
    bmr,
    tdee,
    kcal,
    proteins,
    carbs,
    fats,
    split,
    splitCode,
    proteinsPerKg,
    floored: kcal > wanted,
    capped,
    /*
     * L'avertissement ne vaut qu'en deficit : c'est la que le muscle part.
     *
     * Sur l'ecart REELLEMENT applique, et non sur le signe de l'objectif. Une
     * allure vers un poids vise l'emporte sur l'objectif : viser plus lourd
     * avec un objectif « seche » produit un surplus, et l'avertissement
     * « en deficit, la masse musculaire paie » s'affichait alors sur un calcul
     * qui ajoute de l'energie.
     */
    lowProteins: appliedDelta > 0 && proteinsPerKg < MIN_PROTEINS_PER_KG,
    lowFats: split.fats < MIN_FAT_PERCENT,
    weeksToTarget,
    targetDate: weeksToTarget === null ? null : addWeeks(now, weeksToTarget),
    kgToTarget,
  }
}

/**
 * `yyyy-mm-dd`, N semaines apres une date.
 *
 * Arithmetique en UTC : la meme entree doit rendre la meme date, que le calcul
 * tourne dans le navigateur d'un telephone en France ou dans un Worker de
 * Cloudflare. Sur une estimation a plusieurs semaines, le fuseau ne dit rien
 * d'utile — mais un desaccord d'un jour entre les deux cotes, si.
 */
function addWeeks(from: Date, weeks: number): string {
  const d = new Date(from.getTime())
  d.setUTCDate(d.getUTCDate() + weeks * 7)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/**
 * Millilitres d'eau par kilo et par jour.
 *
 * 30 ml/kg est la regle courante chez l'adulte (EFSA raisonne en volumes fixes
 * — 2 L pour une femme, 2,5 L pour un homme — ce qui revient au meme autour de
 * 70 kg mais ignore la corpulence). Le chiffre couvre l'eau de BOISSON seule ;
 * l'eau des aliments, environ 20 % des apports, n'est pas comptee ici puisque
 * l'ecran ne compte que ce qu'on boit.
 */
export const ML_PER_KG = 30

/** Bornes de securite : en deca c'est trop peu, au-dela on ne le boira pas. */
export const HYDRATION_BOUNDS = { min: 1500, max: 4000 } as const

/**
 * Cible d'hydratation du jour, en millilitres.
 *
 * Recalculee du poids, JAMAIS stockee — meme regle que les cibles en kcal et
 * en macros, et pour la meme raison : une cible ecrite en base resterait a
 * 2 L apres une perte de dix kilos, sans que rien ne le signale.
 *
 * Sans poids connu, on rend le repere general de 2 L plutot que `null` : a la
 * difference d'une cible calorique, une cible d'hydratation fausse de 300 ml ne
 * fait de mal a personne, et un verre a remplir vaut mieux qu'un tiret.
 * L'appelant sait lequel des deux il a par `estimated`.
 */
export function hydrationTarget(weightKg: number | null): {
  readonly ml: number
  /** Vrai si le chiffre vient du poids, faux si c'est le repere general. */
  readonly estimated: boolean
} {
  if (weightKg === null || !Number.isFinite(weightKg) || weightKg <= 0) {
    return { ml: 2000, estimated: false }
  }
  const brut = Math.round((weightKg * ML_PER_KG) / 100) * 100
  return {
    ml: Math.min(HYDRATION_BOUNDS.max, Math.max(HYDRATION_BOUNDS.min, brut)),
    estimated: true,
  }
}

/**
 * Part d'une journee revenant a une personne.
 *
 * Le calendrier planifie pour LA CUISINE : aucune entree ne dit qui mange (voir
 * la migration 0005, ou `meal_plan_entry` ne porte que le foyer). Comparer le
 * total d'une journee a l'objectif d'une personne serait donc faux d'un facteur
 * egal au nombre de mangeurs.
 *
 * On divise par le nombre declare sur le foyer. C'est une APPROXIMATION, et
 * l'interface doit le dire : elle suppose que tout le monde mange la meme
 * chose et en meme quantite. Elle est juste pour des repas communs, fausse pour
 * une portion d'enfant ou un dejeuner pris dehors.
 */
export const perEater = (total: number, eaters: number): number =>
  eaters > 0 ? total / eaters : total

/**
 * Ecart tolere autour de la cible, en part de la cible, pour dire qu'une
 * journee "tient l'objectif".
 */
export const ON_TARGET_TOLERANCE = 0.1

/**
 * Une journee planifiee tient-elle l'objectif ? Sa part individuelle a 10 %
 * pres de la cible. Une journee sans repas ne tient rien : elle n'est pas
 * planifiee, ce n'est pas une journee a zero calorie.
 *
 * Le badge de la semaine et le bilan du dimanche s'en servent tous deux : la
 * meme journee ne doit pas etre tenue a l'ecran et ratee dans la notification.
 */
export function dayOnTarget(
  dayKcal: number,
  entryCount: number,
  kcalTarget: number | null,
  eaters: number,
): boolean {
  return (
    entryCount > 0 &&
    kcalTarget !== null &&
    Math.abs(perEater(dayKcal, eaters) - kcalTarget) <= kcalTarget * ON_TARGET_TOLERANCE
  )
}

/**
 * Le profil tel que la base le stocke et que l'API le rend : des chaines libres
 * la ou `Profile` attend des codes, et la repartition en trois colonnes.
 */
export interface StoredProfile {
  readonly sex: Sex | null
  readonly birthYear: number | null
  readonly heightCm: number | null
  readonly weightKg: number | null
  readonly activity: string | null
  readonly goal: string | null
  readonly split: string | null
  readonly splitProteins: number | null
  readonly splitCarbs: number | null
  readonly splitFats: number | null
  readonly targetWeightKg: number | null
  readonly paceKgPerWeek: number | null
  /** Cible saisie a la main : elle l'emporte sur la cible calculee. */
  readonly kcalTarget: number | null
}

/**
 * La cible du jour d'une personne, depuis son profil enregistre.
 *
 * Partagee par l'ecran (`useDailyTargets`) et par le bilan du dimanche. La
 * regle n'est pas triviale : codes relus depuis des chaines libres, repartition
 * personnalisee recomposee, et cible saisie a la main AVANT la cible calculee.
 * Deux copies finiraient par annoncer deux objectifs pour la meme journee.
 */
export function dailyTargetsOf(
  profile: StoredProfile,
  now: Date = new Date(),
): { readonly targets: Targets | null; readonly kcalTarget: number | null } {
  const targets = estimateTargets(
    {
      sex: profile.sex,
      birthYear: profile.birthYear,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      // Un code retire des listes ne doit rien faire tomber : `estimateTargets`
      // rend `null` s'il ne le reconnait pas.
      activity: profile.activity as ActivityCode | null,
      goal: profile.goal as GoalCode | null,
      split: profile.split as SplitCode | null,
      customSplit:
        profile.splitProteins === null
          ? null
          : {
              proteins: profile.splitProteins,
              carbs: profile.splitCarbs ?? 0,
              fats: profile.splitFats ?? 0,
            },
      targetWeightKg: profile.targetWeightKg,
      paceKgPerWeek: profile.paceKgPerWeek,
    },
    now,
  )
  return { targets, kcalTarget: profile.kcalTarget ?? targets?.kcal ?? null }
}

/** Ou en est-on d'une cible : part atteinte, et de combien on l'a depassee. */
export interface Progress {
  readonly ratio: number
  readonly over: boolean
  /** Ecart absolu a la cible, dans l'unite de la cible. */
  readonly gap: number
}

/**
 * Une cible nulle ou absente ne produit PAS un ratio infini : elle rend une
 * progression neutre. Un ecran qui affiche « 340 % » parce que la cible vaut
 * zero est pire que pas d'objectif du tout.
 */
export function progressToward(actual: number, target: number): Progress {
  if (!Number.isFinite(target) || target <= 0) return { ratio: 0, over: false, gap: 0 }
  return { ratio: actual / target, over: actual > target, gap: Math.abs(target - actual) }
}

// ---------------------------------------------------------------------------
// Reglage libre de la repartition
// ---------------------------------------------------------------------------

export type MacroCle = keyof MacroSplit

/**
 * Deplace UNE macro et redistribue le reste sur les deux autres.
 *
 * Sans cela, trois champs independants obligent l'utilisateur a faire
 * l'arithmetique lui-meme : monter les proteines de 10 points suppose d'en
 * retrancher 10 ailleurs, et tant que ce n'est pas fait le total est faux.
 * Ici, bouger un curseur suffit — les deux autres cedent ou reprennent la
 * place, chacun a proportion de ce qu'il occupait.
 *
 * Quand les deux autres valent zero, on partage a egalite : leur rapport
 * n'existe pas, et tout donner a l'une des deux serait arbitraire.
 */
export function ajusterSplit(split: MacroSplit, macro: MacroCle, valeur: number): MacroSplit {
  const cible = Math.max(0, Math.min(100, Math.round(valeur)))
  const autres = (['proteins', 'carbs', 'fats'] as const).filter((k) => k !== macro)
  const a = autres[0]!
  const b = autres[1]!
  const reste = 100 - cible
  const somme = split[a] + split[b]

  // Le premier est arrondi, le second prend le reliquat : la somme fait 100
  // exactement, sans quoi l'affichage et le calcul divergeraient d'un point.
  const partA = somme > 0 ? Math.round((split[a] / somme) * reste) : Math.round(reste / 2)

  const resultat: Record<MacroCle, number> = { proteins: 0, carbs: 0, fats: 0 }
  resultat[macro] = cible
  resultat[a] = partA
  resultat[b] = reste - partA
  return resultat
}

// ---------------------------------------------------------------------------
// Effets secondaires d'un reglage extreme
// ---------------------------------------------------------------------------

/**
 * Seuils au-dela desquels l'ecran doit dire quelque chose.
 *
 * Ils ne sont pas inventes : ce sont les bornes couramment retenues par les
 * agences — les AMDR de l'Institute of Medicine (proteines 10-35 %, lipides
 * 20-35 %, glucides 45-65 %), l'apport de reference EFSA de 0,83 g/kg de
 * proteines, et le besoin en glucose du cerveau, de l'ordre de 130 g par jour.
 *
 * Depasser une borne n'est pas une faute : beaucoup de regimes documentes le
 * font volontairement, et un plafond franchi de peu ne veut rien dire. C'est
 * pourquoi l'ecran AVERTIT et n'interdit jamais.
 */
export const SEUILS = {
  /** g/kg — sous l'apport de reference pour un adulte. */
  proteinesBasses: 0.83,
  /** g/kg — plancher usuel pour preserver la masse maigre EN DEFICIT. */
  proteinesDeficitBasses: 1.2,
  /** g/kg — au-dela, aucun benefice supplementaire demontre. */
  proteinesHautes: 2.2,
  /**
   * g/kg — territoire ou la charge renale commence a se discuter.
   *
   * Calibre a 3,5 et non a 3 : la repartition « Riche en proteines » du
   * catalogue (35 % de l'energie, soit la borne haute des AMDR) atteint
   * 3,0 g/kg chez un homme de 80 kg au maintien. Un seuil qui accuse une
   * proposition de l'application elle-meme est un seuil faux — c'est un test
   * de couverture du catalogue qui l'a montre.
   */
  proteinesTresHautes: 3.5,
  /** % de l'energie — plancher des AMDR. */
  lipidesBas: 20,
  /** % de l'energie — au-dela, on est de fait sur un regime cetogene. */
  lipidesHauts: 55,
  /** g/jour — besoin en glucose du cerveau. */
  glucidesGrammesBas: 130,
  /** part de la depense — deficit au-dela duquel la masse maigre paie. */
  deficitFort: 0.25,
  /** part de la depense — surplus au-dela duquel la prise se fait en gras. */
  surplusFort: 0.2,
} as const

export type Gravite = 'attention' | 'serieux'
export type Sujet = 'energie' | 'proteines' | 'glucides' | 'lipides'

/**
 * Un effet secondaire annonce, par horizon.
 *
 * Les trois horizons ne sont pas un habillage : un deficit creuse se paie en
 * fatigue la premiere semaine, en masse musculaire au bout de deux mois, en
 * densite osseuse au bout de deux ans. Une seule phrase melangerait des
 * consequences sans commune mesure, et la plus grave serait lue comme
 * immediate — donc soit paniquante, soit ignoree.
 */
export interface Avertissement {
  readonly code: string
  readonly gravite: Gravite
  readonly sujet: Sujet
  /** Ce qui, dans le reglage, declenche l'avertissement. */
  readonly constat: string
  /** Jours a semaines. */
  readonly court: string | null
  /** Semaines a mois. */
  readonly moyen: string | null
  /** Mois a annees. */
  readonly long: string | null
}

const fr = (n: number, d = 1) => n.toLocaleString('fr-FR', { maximumFractionDigits: d })

/**
 * Ce que la litterature dit d'un reglage, quand il sort des bornes usuelles.
 *
 * Fonction PURE et exhaustive : elle ne connait ni l'ecran ni la personne, et
 * elle rend TOUT ce qui depasse — a l'interface de trier. Ce sont des ordres
 * de grandeur pour un adulte en bonne sante, pas un diagnostic, et l'ecran
 * doit le dire.
 */
export function effetsSecondaires(cibles: Targets): readonly Avertissement[] {
  const out: Avertissement[] = []
  const ecart = (cibles.tdee - cibles.kcal) / cibles.tdee // > 0 en deficit
  const gkg = cibles.proteinsPerKg

  // ---------- Energie ----------
  if (ecart > SEUILS.deficitFort) {
    out.push({
      code: 'deficit-fort',
      gravite: 'serieux',
      sujet: 'energie',
      constat: `Déficit de ${Math.round(ecart * 100)} % sous ta dépense estimée.`,
      court: 'Faim persistante, fatigue, frilosité, sommeil moins réparateur.',
      moyen:
        'La perte ne vient plus seulement du gras : la masse musculaire paie, et la dépense ' +
        'baisse avec elle — le fameux palier.',
      long:
        'Chez la femme, cycles perturbés voire interrompus ; chez tous, densité osseuse et ' +
        'fonction thyroïdienne peuvent être touchées.',
    })
  } else if (ecart < -SEUILS.surplusFort) {
    out.push({
      code: 'surplus-fort',
      gravite: 'attention',
      sujet: 'energie',
      constat: `Surplus de ${Math.round(-ecart * 100)} % au-dessus de ta dépense estimée.`,
      court: 'Digestion lourde, sensation de lourdeur après les repas.',
      moyen: 'Au-delà d’un petit surplus, ce qui se prend en plus se prend surtout en gras.',
      long: 'Masse grasse en hausse, et une sèche à faire ensuite pour la reperdre.',
    })
  }

  if (cibles.floored) {
    out.push({
      code: 'plancher',
      gravite: 'serieux',
      sujet: 'energie',
      constat: `Le calcul descendait sous le seuil d’un régime non supervisé.`,
      court: 'Un apport aussi bas relève d’un suivi médical, pas d’une application de recettes.',
      moyen: 'À ce niveau d’apport, les carences en micronutriments sont difficiles à éviter.',
      long: null,
    })
  }

  // ---------- Proteines ----------
  if (gkg < SEUILS.proteinesBasses) {
    out.push({
      code: 'proteines-tres-basses',
      gravite: 'serieux',
      sujet: 'proteines',
      constat: `${fr(gkg)} g de protéines par kilo — sous l’apport de référence de ${fr(SEUILS.proteinesBasses, 2)}.`,
      court: 'Récupération plus lente après l’effort, faim qui revient vite.',
      moyen: 'Fonte musculaire, y compris sans que la balance ne bouge.',
      long: 'Cicatrisation ralentie, défenses immunitaires moins efficaces.',
    })
  } else if (ecart > 0 && gkg < SEUILS.proteinesDeficitBasses) {
    out.push({
      code: 'proteines-basses-deficit',
      gravite: 'attention',
      sujet: 'proteines',
      constat: `${fr(gkg)} g par kilo en déficit — le plancher usuel est ${fr(SEUILS.proteinesDeficitBasses)}.`,
      court: 'Rassasiement moindre : le déficit est plus dur à tenir.',
      moyen: 'Une part de ce que tu perds sera du muscle plutôt que du gras.',
      long: null,
    })
  } else if (gkg > SEUILS.proteinesTresHautes) {
    out.push({
      code: 'proteines-tres-hautes',
      gravite: 'attention',
      sujet: 'proteines',
      constat: `${fr(gkg)} g par kilo — bien au-delà de ${fr(SEUILS.proteinesHautes)}, où les bénéfices cessent.`,
      court: 'Soif, digestion pesante, haleine chargée.',
      moyen: 'Le reste de l’assiette se réduit d’autant : fibres et micronutriments en pâtissent.',
      long:
        'Sur des reins sains, aucun dommage démontré ; en cas d’atteinte rénale connue, ' +
        'c’est un sujet à voir avec un médecin.',
    })
  }

  // ---------- Lipides ----------
  if (cibles.split.fats < SEUILS.lipidesBas) {
    out.push({
      code: 'lipides-bas',
      gravite: 'serieux',
      sujet: 'lipides',
      constat: `${cibles.split.fats} % de lipides — sous le plancher de ${SEUILS.lipidesBas} %.`,
      court: 'Peau et cheveux secs, satiété en berne.',
      moyen: 'Production hormonale perturbée — cycle menstruel, libido, humeur.',
      long: 'Absorption des vitamines A, D, E et K compromise, et carence en acides gras essentiels.',
    })
  } else if (cibles.split.fats > SEUILS.lipidesHauts) {
    out.push({
      code: 'lipides-hauts',
      gravite: 'attention',
      sujet: 'lipides',
      constat: `${cibles.split.fats} % de lipides — de fait un régime cétogène.`,
      court: 'Fatigue et maux de tête les premiers jours, transit ralenti.',
      moyen: 'Performance en berne sur les efforts intenses et courts.',
      long: 'Peu de données au-delà de deux ans ; un suivi du bilan lipidique est raisonnable.',
    })
  }

  // ---------- Glucides ----------
  if (cibles.carbs.grams < SEUILS.glucidesGrammesBas) {
    out.push({
      code: 'glucides-bas',
      gravite: 'attention',
      sujet: 'glucides',
      constat:
        `${cibles.carbs.grams} g de glucides — sous les ${SEUILS.glucidesGrammesBas} g ` +
        'que le cerveau consomme chaque jour.',
      court: 'Coup de barre, difficulté à se concentrer, maux de tête.',
      moyen: 'L’organisme fabrique le glucose manquant, en partie à partir des protéines.',
      long: 'Tenable, mais les efforts intenses et le sommeil s’en ressentent souvent.',
    })
  }

  return out
}
