/**
 * Anneau de repartition des macros, EN MASSE.
 *
 * DEUX DECISIONS Y SONT INSCRITES, et les deux ont ete demandees.
 *
 * 1. IL N'Y A PAS DE LEGENDE, ET IL N'Y A PLUS DE FACON D'EN REMETTRE UNE.
 *
 *    Le composant portait un `showLegend?: boolean` optionnel qui valait `true`
 *    par defaut. Les ecrans qui devaient s'en passer le posaient a `false` ;
 *    l'editeur de recette, lui, ne le posait pas du tout et gardait donc sa
 *    legende. Le defaut a ete signale trois fois et corrige deux fois sans
 *    disparaitre, parce qu'on corrigeait la VALEUR passee la ou il fallait
 *    supprimer le REGLAGE : tant que l'oubli restait exprimable, un nouvel
 *    appel le reproduisait. Le prop est parti avec le balisage.
 *
 *    La raison de fond n'a pas change : le tableau des huit nutriments suit
 *    immediatement, avec les memes familles et les memes parts. La legende les
 *    redisait a quelques centimetres d'ecart, et rien n'indiquait laquelle
 *    faisait foi. Le trace montre, le tableau chiffre. La repartition chiffree
 *    passe dans le libelle accessible pour ne pas disparaitre des lecteurs
 *    d'ecran.
 *
 * 2. LES ARCS SONT PROPORTIONNELS AUX GRAMMES, PAS AUX CALORIES.
 *
 *    L'anneau repondait a "d'ou viennent les calories". Il repond desormais a
 *    "de quoi ce plat est fait". Ce n'est pas un detail de calcul : les lipides
 *    pesent 9 kcal/g contre 4 aux glucides, donc pour un meme plat la lecture
 *    energetique leur donne pres du double de la place que la lecture massique.
 *    La colonne "Part" du tableau suit la MEME base (`massShare`), sans quoi
 *    l'anneau et la ligne juste dessous annonceraient deux nombres differents
 *    pour la meme chose.
 *
 *    Ce qui reste energetique le reste : le nombre au centre est bien des kcal,
 *    et les objectifs de repartition du profil (`MACRO_SPLITS`) sont des parts
 *    d'ENERGIE, ce que cette figure ne pretend pas illustrer.
 *
 * Pas de survol : il n'existe pas au doigt.
 */

import { massBreakdown, type NutritionTotal } from '@prandia/shared'

import { formatNumber } from '../lib/format.js'

import '../styles/components.css'

const DONUT_RADIUS = 42
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS

const SEGMENTS = [
  { key: 'fats', label: 'Lipides' },
  { key: 'carbs', label: 'Glucides' },
  { key: 'fiber', label: 'Fibres' },
  { key: 'proteins', label: 'Protéines' },
] as const

/**
 * Les arcs a tracer, dans l'ordre, deja normalises.
 *
 * Partage avec la tri-barre pour que les deux figures ne puissent pas diverger.
 * Elles vivent sur des ecrans differents, la carte du repertoire et la fiche :
 * deux calculs auraient fini par donner deux dessins pour la meme recette.
 *
 * ON ECARTE CE QUI S'ARRONDIT A ZERO, puis on renormalise. Un sirop d'agave
 * porte 0,02 g de proteines pour la portion : le tableau affiche "0,0 g", et
 * l'anneau tracait pourtant un trait visible, un arc de moins d'un demi-pixel
 * que l'anti-crenelage rend bien present. On lisait donc une part de proteines
 * dans un aliment que le tableau juste dessous annonce a zero. Le seuil est
 * celui de l'AFFICHAGE, pas une valeur arbitraire : sous 0,5 % la part s'ecrit
 * "0 %", donc elle ne doit pas se voir non plus.
 */
function arcsDe(total: NutritionTotal) {
  const masse = massBreakdown(total)
  if (masse.macroMassG <= 0) return null

  const retenus = SEGMENTS.map((segment) => ({
    ...segment,
    grams: masse[`${segment.key}G` as const],
  })).filter((segment) => segment.grams / masse.macroMassG >= 0.005)

  // La renormalisation sur la seule masse retenue garantit que les arcs
  // remplissent exactement le cercle et que les parts font 100.
  const base = retenus.reduce((somme, s) => somme + s.grams, 0)
  if (base <= 0) return null

  let offset = 0
  return retenus.map((segment) => {
    const share = segment.grams / base
    const arc = { ...segment, share, start: offset }
    offset += share
    return arc
  })
}

/** La repartition dite en toutes lettres, pour les lecteurs d'ecran. */
function resumeDe(arcs: ReturnType<typeof arcsDe>): string {
  return (arcs ?? [])
    .map((arc) => `${arc.label} ${formatNumber(arc.share * 100, 0)} %`)
    .join(', ')
}

/**
 * L'anneau SEUL, sans carte autour.
 *
 * Il existe a part pour la fiche de recette, ou le selecteur d'echelle (par
 * portion, recette entiere, aux 100 g) commande a la fois l'anneau et le
 * tableau : les deux doivent donc vivre dans LA MEME carte, sous le meme
 * selecteur. La version cartee ci-dessous rendrait une carte blanche dans une
 * carte blanche, ce que ce projet a deja paye ailleurs, deux niveaux imbriques
 * se lisant comme un seul.
 *
 * Rend `null` quand rien n'est chiffrable : la phrase a afficher depend de
 * l'ecran, c'est a l'appelant de la choisir.
 */
export function MacrosRing({
  total,
  centerCaption,
}: {
  readonly total: NutritionTotal
  /** Ligne sous le nombre central : « kcal / 100 g », « kcal ce jour »… */
  readonly centerCaption: string
}) {
  const arcs = arcsDe(total)
  if (arcs === null) return null

  return (
    <div className="macros">
      <svg
        className="macros__chart"
        viewBox="0 0 120 120"
        role="img"
        aria-label={`Répartition en masse : ${resumeDe(arcs)}`}
      >
        <circle
          className="macros__track"
          cx="60"
          cy="60"
          r={DONUT_RADIUS}
          fill="none"
          strokeWidth="16"
        />
        {arcs.map((arc) => (
          <circle
            key={arc.key}
            cx="60"
            cy="60"
            r={DONUT_RADIUS}
            fill="none"
            strokeWidth="16"
            stroke={`var(--color-nutrient-${arc.key})`}
            strokeDasharray={`${arc.share * DONUT_CIRCUMFERENCE} ${DONUT_CIRCUMFERENCE}`}
            strokeDashoffset={-arc.start * DONUT_CIRCUMFERENCE}
            // Depart a 12 h plutot qu'a 3 h, comme sur le desktop.
            transform="rotate(-90 60 60)"
          />
        ))}
        {/* Le centre porte l'ENERGIE, pas une masse. C'est le chiffre qu'on
            vient chercher en premier, et les arcs disent de quoi elle est
            faite. Le libelle accessible ci-dessus nomme la base des arcs
            pour que les deux ne se confondent pas. */}
        <text className="macros__center" x="60" y="57" textAnchor="middle">
          {Math.round(total.kcal)}
        </text>
        <text className="macros__center-sub" x="60" y="72" textAnchor="middle">
          {centerCaption}
        </text>
      </svg>
    </div>
  )
}

export interface MacrosDonutProps {
  readonly total: NutritionTotal
  readonly title: string
  /** Ligne sous le nombre central : « kcal / 100 g », « kcal ce jour »… */
  readonly centerCaption: string
  /** Phrase affichee quand rien n'est chiffrable. */
  readonly emptyMessage: string
}

/** L'anneau dans sa propre carte titree, pour les ecrans qui l'affichent seul. */
export function MacrosDonut({ total, title, centerCaption, emptyMessage }: MacrosDonutProps) {
  // Le calcul est refait plutot que le composant appele comme une fonction :
  // `MacrosRing(props)` rendrait le trace mais le sortirait de l'arbre React,
  // et le jour ou il prendrait un hook, la regle des hooks casserait sans
  // prevenir. Recalculer quatre divisions ne coute rien.
  const chiffrable = arcsDe(total) !== null

  return (
    <div className="card macros-card">
      <h3 className="card__title">{title}</h3>
      {chiffrable ? (
        <MacrosRing total={total} centerCaption={centerCaption} />
      ) : (
        <p className="card__lead">{emptyMessage}</p>
      )}
    </div>
  )
}

/**
 * La meme repartition, reduite a une barre de six pixels.
 *
 * Elle existe pour les LIGNES : la semaine, et les cartes du repertoire, ou
 * l'anneau ne tiendrait pas et ou quatre valeurs chiffrees seraient illisibles.
 * Elle ne remplace pas le detail : elle donne l'allure d'un plat, « surtout des
 * glucides » se voit sans lire, et la fiche porte les nombres.
 *
 * Meme base que l'anneau, par la meme fonction : une carte de liste et la
 * fiche qu'elle ouvre doivent montrer le meme dessin.
 *
 * `role="img"` avec un libelle : le trace n'est pas decoratif ici, c'est la
 * seule information de repartition presente dans la ligne.
 */
export function MacroBar({ total }: { readonly total: NutritionTotal }) {
  const arcs = arcsDe(total)
  if (arcs === null) return null

  return (
    <span className="macro-bar" role="img" aria-label={`Répartition en masse : ${resumeDe(arcs)}`}>
      {arcs.map((arc) => (
        <span
          key={arc.key}
          className={`macro-bar__part macro-bar__part--${arc.key}`}
          style={{ flexGrow: arc.share }}
        />
      ))}
    </span>
  )
}

/**
 * Les quatre chiffres d'un aliment, en cellules teintees.
 *
 * Troisieme forme de la meme information, et chacune a son emploi :
 * l'anneau montre des PROPORTIONS, la barre donne une ALLURE en six pixels,
 * ces cellules livrent les VALEURS. Une fiche produit se lit en chiffres,
 * « 10,6 g de protéines », et un anneau ne repond pas a cette question.
 *
 * L'energie occupe la premiere cellule et porte l'OLIVE de l'application, pas
 * une quatrieme teinte du tricolore : elle n'est pas une quatrieme famille,
 * elle est la somme des trois. Elle etait grise, ce qui la faisait passer pour
 * du noir.
 */
export function MacroCells({
  total,
  caption = 'pour 100 g',
}: {
  readonly total: NutritionTotal
  /** Ce a quoi les valeurs se rapportent : « pour 100 g », « par portion »… */
  readonly caption?: string
}) {
  const cellules = [
    { key: 'energy', valeur: String(Math.round(total.kcal)), unite: `kcal ${caption}` },
    { key: 'proteins', valeur: formatNumber(total.proteins, 1), unite: 'Prot. (g)' },
    { key: 'carbs', valeur: formatNumber(total.carbs, 1), unite: 'Gluc. (g)' },
    { key: 'fats', valeur: formatNumber(total.fats, 1), unite: 'Lip. (g)' },
  ]

  return (
    <div className="macro-cells">
      {cellules.map((c) => (
        <div key={c.key} className={`macro-cell macro-cell--${c.key}`}>
          <span className="macro-cell__value chiffre">{c.valeur}</span>
          <span className="macro-cell__unit">{c.unite}</span>
        </div>
      ))}
    </div>
  )
}
