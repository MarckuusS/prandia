/**
 * La courbe de poids : le bruit, la tendance, la projection.
 *
 * Trois series sur un meme trace, et chacune repond a une question differente.
 * Les PESEES BRUTES, en petits points, montrent la dispersion reelle d'une
 * balance : c'est ce qui dedramatise le matin ou l'on a pris 800 g. La MOYENNE
 * LISSEE, en trait plein, est la seule ligne qu'il faut lire. La PROJECTION,
 * en pointilles, prolonge le rythme observe jusqu'a la cible.
 *
 * Le trace est en `viewBox` de 320 x 120 avec `preserveAspectRatio="none"` :
 * il s'etire en largeur sans deformer les epaisseurs de trait, qui sont
 * exprimees en unites de la viewBox et non en pixels.
 */

import { daysBetween, type TrendPoint } from '@prandia/shared'

const L = 320
const H = 120
/** Marge haute et basse, pour que les points ne touchent pas les bords. */
const MARGE = 12

export function CourbePoids({
  points,
  targetKg,
  etaDay,
  today,
}: {
  readonly points: readonly TrendPoint[]
  readonly targetKg: number | null
  /** Fin de la projection. `null` : on ne trace pas de pointilles. */
  readonly etaDay: string | null
  readonly today: string
}) {
  const premier = points[0]
  const dernier = points[points.length - 1]
  if (premier === undefined || dernier === undefined) return null

  /*
   * L'echelle horizontale couvre les pesees ET la projection : sans cela, le
   * trait pointille sortirait du cadre, ou la courbe serait comprimee a
   * gauche des qu'une arrivee lointaine est estimee.
   */
  const finJours = Math.max(
    daysBetween(premier.day, dernier.day),
    etaDay === null ? 0 : daysBetween(premier.day, etaDay),
    1,
  )
  const x = (day: string) => (daysBetween(premier.day, day) / finJours) * L

  // L'echelle verticale englobe la cible : une courbe qui la laisse hors cadre
  // ne dit pas de combien on en est loin.
  const valeurs = points.flatMap((p) => [p.raw, p.smoothed]).filter((v): v is number => v !== null)
  if (targetKg !== null) valeurs.push(targetKg)
  const min = Math.min(...valeurs)
  const max = Math.max(...valeurs)
  const etendue = max - min || 1
  const y = (kg: number) => MARGE + ((max - kg) / etendue) * (H - MARGE * 2)

  const lisses = points.filter((p) => p.smoothed !== null)
  const trace = lisses.map((p) => `${x(p.day)},${y(p.smoothed as number)}`).join(' L ')
  const aire =
    lisses.length === 0
      ? ''
      : `M ${trace} L ${x(dernier.day)},${H} L ${x(premier.day)},${H} Z`

  const xToday = x(today)

  return (
    <svg className="courbe" viewBox={`0 0 ${L} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="aire-poids" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-success)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--color-success)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {targetKg !== null && (
        <line
          className="courbe__cible"
          x1="0"
          y1={y(targetKg)}
          x2={L}
          y2={y(targetKg)}
          strokeDasharray="5 5"
        />
      )}

      <line className="courbe__aujourdhui" x1={xToday} y1="0" x2={xToday} y2={H} />

      {aire !== '' && <path d={aire} fill="url(#aire-poids)" />}

      {/* Les pesees brutes, volontairement bruitees : c'est la realite d'une
          balance, et la voir empeche de lire la tendance dans un seul point. */}
      <g className="courbe__pesees">
        {points
          .filter((p) => p.raw !== null)
          .map((p) => (
            <circle key={p.day} cx={x(p.day)} cy={y(p.raw as number)} r="1.7" />
          ))}
      </g>

      {lisses.length > 1 && <path className="courbe__tendance" d={`M ${trace}`} fill="none" />}

      {etaDay !== null && targetKg !== null && (
        <>
          <line
            className="courbe__projection"
            x1={x(dernier.day)}
            y1={y(dernier.smoothed as number)}
            x2={x(etaDay)}
            y2={y(targetKg)}
            strokeDasharray="2 5"
          />
          <circle className="courbe__arrivee" cx={x(etaDay)} cy={y(targetKg)} r="4" />
        </>
      )}

      {dernier.smoothed !== null && (
        <circle
          className="courbe__actuel"
          cx={x(dernier.day)}
          cy={y(dernier.smoothed)}
          r="4.5"
        />
      )}
    </svg>
  )
}
